/* ==========================================================
   提出金額内訳書テンプレートの構造解析（純粋関数、DOM・DB非依存）
   会社指定の.xlsx（例: 七里 提出金額.xlsx）のシートXMLを読み、
   「1頁が何行か」「見出し・小計・頁番号・会社名の行位置」「明細行の
   置ける行の偶奇」「行位置ごとの罫線スタイル」「数値・折返し文字に
   使うスタイル」「小計・表紙ラベルの文言」を、テンプレート自身から
   導出して"プロファイル"（JSON）にまとめる。41行等の値をコードに
   直書きしないための仕組みで、別の会社様式は別プロファイルとして
   同じ処理で解析する。導出できない項目は推測せずerrorsに積み、
   呼び出し側が登録拒否／警告できるようにする。
   ========================================================== */

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 見出し行の文言（空白除去後）→ 項目キー
const HEADER_FIELD_BY_TEXT = {
  記号: "symbol",
  名称: "name",
  摘要: "spec",
  数量: "quantity",
  単位: "unit",
  単価: "unitPrice",
  金額: "amount",
  備考: "note"
};

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** sharedStrings.xmlを文字列配列にする（ふりがな<rPh>は除く） */
export function parseSharedStrings(sharedStringsXml) {
  if (!sharedStringsXml) return [];
  return [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const inner = m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "");
    return decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
  });
}

/**
 * シートXMLの<row>を行番号→{attrs, cells}に分解する。
 * attrsは行開始タグのr属性以外の属性文字列（spans/ht/s等）、
 * cellsは列文字→{s(スタイルid|null), text(文字列|null), isNumber}。
 */
export function parseSheetRows(sheetXml, sharedStrings = []) {
  const rows = new Map();
  const rowRe = /<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml))) {
    const cells = new Map();
    const inner = rm[3] || "";
    const cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner))) {
      const attrs = cm[2];
      const body = cm[3] || "";
      const sMatch = /\ss="(\d+)"/.exec(attrs);
      const tMatch = /\st="(\w+)"/.exec(attrs);
      const type = tMatch ? tMatch[1] : "n";
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
      let text = null;
      let isNumber = false;
      if (type === "s" && vMatch) text = sharedStrings[Number(vMatch[1])] ?? "";
      else if (type === "inlineStr") text = decodeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else if (type === "n" && vMatch) {
        text = vMatch[1];
        isNumber = true;
      } else if (vMatch) text = decodeXml(vMatch[1]);
      cells.set(cm[1], { s: sMatch ? Number(sMatch[1]) : null, text, isNumber });
    }
    rows.set(Number(rm[1]), { attrs: rm[2].trim(), cells });
  }
  return rows;
}

function stripSpaces(text) {
  return String(text ?? "").replace(/[\s　]/g, "");
}

function hasText(cell) {
  return !!cell && cell.text != null && cell.text !== "";
}

function majority(counter) {
  let best = null;
  for (const [key, n] of counter) {
    if (!best || n > best[1]) best = [key, n];
  }
  return best ? best[0] : null;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * @param {object} params
 * @param {string} params.sheetXml 対象シートのXML
 * @param {string} params.sharedStringsXml sharedStrings.xml（無ければnull）
 * @param {string} params.sheetName シート表示名
 * @returns {{ profile: object|null, errors: string[], warnings: string[] }}
 */
export function analyzeSubmissionTemplate({ sheetXml, sharedStringsXml, sheetName }) {
  const errors = [];
  const warnings = [];
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const rows = parseSheetRows(sheetXml, sharedStrings);

  // ---- 1頁の行数（各頁の会社名行を結合したセル範囲の間隔から導出） ----
  const mergeRows = [...sheetXml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)]
    .filter((m) => m[2] === m[4])
    .map((m) => ({ first: m[1], last: m[3], row: Number(m[2]) }))
    .sort((a, b) => a.row - b.row);
  if (mergeRows.length === 0) {
    errors.push("頁ごとの会社名行（横一列の結合セル）が見つからないため、1頁の行数を判別できません。");
    return { profile: null, errors, warnings };
  }
  const pageRows = mergeRows[0].row;
  if (!mergeRows.every((m, i) => m.row === pageRows * (i + 1))) {
    errors.push("結合セルの間隔が一定でないため、1頁の行数を判別できません。");
    return { profile: null, errors, warnings };
  }
  const maxRow = Math.max(...rows.keys());
  const templatePageCount = mergeRows.length;
  const lastCol = mergeRows[0].last;
  const colCount = COL_LETTERS.indexOf(lastCol) + 1;
  const columns = COL_LETTERS.slice(0, colCount).split("");

  const at = (page, pos) => rows.get((page - 1) * pageRows + pos);
  const cellText = (page, pos, col) => {
    const cell = at(page, pos)?.cells.get(col);
    return hasText(cell) ? cell.text : "";
  };

  // ---- 見出し行・頁番号行の位置と、見出し文言→列の対応 ----
  let headerPos = null;
  const fieldColumns = {};
  for (let pos = 1; pos <= pageRows && headerPos == null; pos++) {
    const row = at(1, pos);
    if (!row) continue;
    const found = {};
    for (const [col, cell] of row.cells) {
      const key = HEADER_FIELD_BY_TEXT[stripSpaces(cell.text)];
      if (key) found[key] = col;
    }
    if (found.name && found.amount && found.quantity) {
      headerPos = pos;
      Object.assign(fieldColumns, found);
    }
  }
  if (headerPos == null) errors.push("見出し行（名称・数量・金額など）が見つかりません。");

  let pageMarkPos = null;
  let pageMarkCol = null;
  for (let pos = 1; pos <= pageRows && pageMarkPos == null; pos++) {
    for (const [col, cell] of at(1, pos)?.cells || []) {
      if (/^P-\d+$/.test(cell.text || "")) {
        pageMarkPos = pos;
        pageMarkCol = col;
      }
    }
  }
  if (pageMarkPos == null) errors.push("頁番号（P-1形式）のセルが見つかりません。");

  const titlePos = headerPos != null ? headerPos - 1 : null;
  const companyPos = pageRows;
  if (errors.length) return { profile: null, errors, warnings };

  const firstBodyPos = headerPos + 1;
  const subtotalPos = pageMarkPos - 1;
  const amountCol = fieldColumns.amount;
  const titleCol = columns[0];

  // ---- 明細行（数値行）が置かれる行位置の偶奇 ----
  const parityCount = new Map();
  for (let page = 1; page <= templatePageCount; page++) {
    for (let pos = firstBodyPos; pos < subtotalPos; pos++) {
      const cell = at(page, pos)?.cells.get(amountCol);
      if (cell?.isNumber && hasText(cell)) bump(parityCount, pos % 2);
    }
  }
  const lineParity = majority(parityCount);
  if (lineParity == null) {
    errors.push("金額が入っている行が見つからないため、明細を置ける行位置を判別できません。");
    return { profile: null, errors, warnings };
  }
  const offParity = [...parityCount.keys()].filter((p) => p !== lineParity);
  if (offParity.length) warnings.push("金額行の位置の偶奇が一部の頁で揃っていません（多数派を採用）。");
  let lastLinePos = subtotalPos - 1;
  while (lastLinePos % 2 !== lineParity) lastLinePos--;

  // ---- 行位置ごとの罫線スタイル（空セルの多数派）と行属性 ----
  const frameStyles = {};
  const rowAttrs = {};
  for (let pos = 1; pos <= pageRows; pos++) {
    rowAttrs[pos] = at(1, pos)?.attrs ?? "";
  }
  for (let pos = firstBodyPos; pos <= subtotalPos; pos++) {
    frameStyles[pos] = columns.map((col) => {
      // 罫線の素のスタイルを知りたいので、金額の入っていない行の空セルを最優先で数える
      // （数値・折返し用に上書きされたスタイルが空セルに残っていても多数派で薄まる）
      const blankRowCounter = new Map();
      const emptyCounter = new Map();
      const anyCounter = new Map();
      for (let page = 1; page <= templatePageCount; page++) {
        const row = at(page, pos);
        const cell = row?.cells.get(col);
        if (!cell || cell.s == null) continue;
        bump(anyCounter, cell.s);
        if (!hasText(cell)) {
          bump(emptyCounter, cell.s);
          if (!hasText(row.cells.get(amountCol))) bump(blankRowCounter, cell.s);
        }
      }
      return majority(blankRowCounter) ?? majority(emptyCounter) ?? majority(anyCounter);
    });
  }

  // ---- 内容種別（数値／セル内改行）ごとに使われるスタイル ----
  const numberStyle = {};
  const wrapStyle = {};
  const numberVotes = new Map();
  const wrapVotes = new Map();
  for (let page = 1; page <= templatePageCount; page++) {
    for (let pos = firstBodyPos; pos <= subtotalPos; pos++) {
      const row = at(page, pos);
      if (!row) continue;
      columns.forEach((col, ci) => {
        const cell = row.cells.get(col);
        if (!hasText(cell) || cell.s == null) return;
        const proto = frameStyles[pos][ci];
        if (proto == null) return;
        if (cell.isNumber) bump(numberVotes, `${col}:${proto}:${cell.s}`);
        else if (/[\r\n]/.test(cell.text)) bump(wrapVotes, `${col}:${proto}:${cell.s}`);
      });
    }
  }
  const resolveVotes = (votes, target) => {
    const best = new Map();
    for (const [key, n] of votes) {
      const [col, proto, used] = key.split(":");
      const k = `${col}:${proto}`;
      if (!best.has(k) || n > best.get(k)[1]) best.set(k, [Number(used), n]);
    }
    for (const [k, [used]] of best) target[k] = used;
  };
  resolveVotes(numberVotes, numberStyle);
  resolveVotes(wrapVotes, wrapStyle);

  // 数値用に上書きされたスタイルが空セルの多数派になってしまった行位置（明細行しか
  // 無い位置など）は、上書き前の素のスタイルへ戻す（列ごとの「素→数値用」対応の逆引き）
  for (const pos of Object.keys(frameStyles)) {
    frameStyles[pos] = frameStyles[pos].map((style, ci) => {
      const col = columns[ci];
      for (const [key, used] of Object.entries(numberStyle)) {
        const [keyCol, protoText] = key.split(":");
        const proto = Number(protoText);
        if (keyCol === col && used === style && proto !== style && Object.values(frameStyles).some((arr) => arr[ci] === proto)) return proto;
      }
      return style;
    });
  }

  // ---- 小計ラベル（最下段の文言）の種類判別 ----
  const labels = { groupSuffix: null, workType: null, subType: null };
  for (let page = 1; page <= templatePageCount; page++) {
    const text = cellText(page, subtotalPos, fieldColumns.name);
    if (!text) continue;
    if (!labels.subType && /^[\s　]*[（(].*計[）)]$/.test(text)) labels.subType = text;
    else if (!labels.workType && /^[\s　]+小[\s　]+計[\s　]*$/.test(text)) labels.workType = text;
    else if (!labels.groupSuffix && /[^\s　][\s　]計$/.test(text)) labels.groupSuffix = text.slice(text.search(/[\s　]計$/));
  }
  for (const [key, label] of [["groupSuffix", "号棟・区分の計"], ["workType", "工種の小計"], ["subType", "種別の小計"]]) {
    if (!labels[key]) errors.push(`様式から「${label}」の行の文言を判別できません（該当する頁が無い）。`);
  }

  // ---- 表紙（1頁目）の合計行ラベルと、表紙行の既定単位 ----
  const cover = { subtotalLabels: [], lumpUnit: null, lumpQuantity: null };
  for (let pos = firstBodyPos; pos < subtotalPos; pos++) {
    const row = at(1, pos);
    if (!row) continue;
    const symbolCell = row.cells.get(fieldColumns.symbol);
    const nameCell = row.cells.get(fieldColumns.name);
    const amountCell = row.cells.get(amountCol);
    if (!hasText(nameCell) || !amountCell?.isNumber) continue;
    if (!hasText(symbolCell)) {
      cover.subtotalLabels.push(nameCell.text);
    } else if (cover.lumpUnit == null) {
      cover.lumpUnit = row.cells.get(fieldColumns.unit)?.text ?? null;
      cover.lumpQuantity = Number(row.cells.get(fieldColumns.quantity)?.text ?? NaN);
      if (Number.isNaN(cover.lumpQuantity)) cover.lumpQuantity = null;
    }
  }
  if (cover.subtotalLabels.length !== 3) {
    errors.push(`表紙の合計行（直接工事費計・純工事費・工事原価）を3行として判別できません（検出${cover.subtotalLabels.length}行）。`);
  }
  if (cover.lumpUnit == null || cover.lumpQuantity == null) {
    errors.push("表紙の号棟行から「数量・単位」（一式表記）を判別できません。");
  }
  if (errors.length) return { profile: null, errors, warnings };

  const profile = {
    version: 1,
    kind: "submission-breakdown",
    sheetName,
    pageRows,
    templatePageCount,
    columns,
    fieldColumns,
    positions: {
      title: titlePos,
      header: headerPos,
      firstBody: firstBodyPos,
      lastLine: lastLinePos,
      subtotal: subtotalPos,
      pageMark: pageMarkPos,
      company: companyPos
    },
    pageMarkColumn: pageMarkCol,
    titleColumn: titleCol,
    lineParity,
    frameStyles,
    rowAttrs,
    numberStyle,
    wrapStyle,
    labels,
    cover,
    defaults: {
      companyName: cellText(1, companyPos, titleCol),
      sampleTitle: cellText(1, titlePos, titleCol)
    }
  };
  return { profile, errors, warnings };
}
