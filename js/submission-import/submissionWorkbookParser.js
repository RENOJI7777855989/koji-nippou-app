/* ==========================================================
   提出金額内訳書（会社様式.xlsx）の解析（純粋関数、DOM・DB非依存）
   出力側（js/submission-output/）が「積算→様式」へ書き出すのと逆向きに、
   完成した内訳書（例: 七里 提出金額.xlsx）から
     区分（号棟等）→ 工種 → 種別 → 明細
   の階層つき明細を取り出す。頁の行数・見出し/小計/頁番号/会社名の位置・
   明細行の偶奇は、templateProfile.jsがそのファイル自身から導出したものを
   使い、行数や件数はコードに固定しない。

   分類の原則:
     ・見出し・工事名・会社名・頁番号・小計・空行は明細にしない（件数を数えて返す）。
     ・頁の一覧行（区分頁の工種行／工種頁の種別行）は明細にしない。
       ただし内訳頁を持たない一覧行（例: 共通仮設費(一般)の準備費）は明細とする。
     ・数値行を終端とする連続行を1明細にまとめる（複数行の名称・摘要）。
     ・空行で区切られた文字だけの行は「摘要のみの行」。
     ・前の項目の追記行かどうか構造上決められない行は ambiguous として印を付け、
       推測で確定しない。
     ・Excel上の小計は金額の根拠にせず、取込結果の検算（consistency）にだけ使う。
   ========================================================== */

import { analyzeSubmissionTemplate, parseSheetRows, parseSharedStrings } from "../submission-output/templateProfile.js";
import { normalizeItemText } from "../vendorQuote/itemNormalize.js";

// 記号（頁先頭行のA列）の種類。七里様式の記号体系（区分=全角英大文字、工種=数字、種別=小文字英字）。
// 別の記号体系の様式では解析できない旨を警告する（推測で分類しない）。
const SYMBOL_CLASSES = [
  { level: "group", re: /^[Ａ-Ｚ]$/ },
  { level: "workType", re: /^\d+$/ },
  { level: "subType", re: /^[a-z]$/ }
];

function symbolLevel(symbol) {
  return SYMBOL_CLASSES.find((c) => c.re.test(symbol))?.level ?? null;
}

const num = (cell) => (cell?.isNumber && cell.text !== "" && cell.text != null ? Number(cell.text) : null);

function groupKindOf(section, name) {
  // 種類は表紙上の位置（直接工事費計より前=号棟、純工事費より前=共通仮設、後=現場管理費）で決める。
  // 共通仮設の「積上／一般」は位置では区別できないため名称の語で判別し、根拠を返す。
  if (section === "building") return { kind: "building", basis: "position" };
  if (section === "management") return { kind: "site_management", basis: "position" };
  if (/積上/.test(name)) return { kind: "common_temp_itemized", basis: "name" };
  if (/一般/.test(name)) return { kind: "common_temp_general", basis: "name" };
  return { kind: "common_temp_general", basis: "unknown" };
}

/**
 * @param {object} params
 * @param {string} params.sheetXml
 * @param {string|null} params.sharedStringsXml
 * @param {string} params.sheetName
 * @returns {{ ok: boolean, errors: string[], warnings: string[], result?: object }}
 */
export function parseSubmissionWorkbook({ sheetXml, sharedStringsXml, sheetName }) {
  const analysis = analyzeSubmissionTemplate({ sheetXml, sharedStringsXml, sheetName });
  if (!analysis.profile) return { ok: false, errors: analysis.errors, warnings: analysis.warnings };
  const profile = analysis.profile;
  const warnings = [...analysis.warnings];
  const rows = parseSheetRows(sheetXml, parseSharedStrings(sharedStringsXml));
  const { pageRows, positions: P, fieldColumns: F, lineParity } = profile;
  const maxRow = Math.max(...rows.keys());
  const pageCount = Math.floor(maxRow / pageRows);
  const trailingRows = maxRow - pageCount * pageRows;

  const cell = (rowNum, field) => rows.get(rowNum)?.cells.get(F[field]);
  const text = (rowNum, field) => {
    const c = cell(rowNum, field);
    return c && c.text != null ? c.text : "";
  };
  const rowHasContent = (rowNum) => [...(rows.get(rowNum)?.cells.values() || [])].some((c) => c.text != null && c.text !== "");
  const rowInfo = (rowNum, pos) => {
    const q = num(cell(rowNum, "quantity")), up = num(cell(rowNum, "unitPrice")), amt = num(cell(rowNum, "amount"));
    return {
      pos,
      rowNum,
      symbol: text(rowNum, "symbol"),
      name: text(rowNum, "name"),
      spec: text(rowNum, "spec"),
      unit: text(rowNum, "unit"),
      note: text(rowNum, "note"),
      quantity: q,
      unitPrice: up,
      amount: amt,
      hasNumbers: q != null || up != null || amt != null,
      blank: !rowHasContent(rowNum)
    };
  };

  const excluded = { title: 0, header: 0, pageMark: 0, company: 0, blank: 0, subtotal: 0, coverSubtotal: 0, listing: 0, trailingBlank: 0 };
  const errors = [];
  const nonEmptyRowCount = [...rows.keys()].filter((r) => rowHasContent(r)).length;
  const classified = new Set(); // 分類済みの行番号（黙って落とした行が無いことの確認用）
  const mark = (rowNum) => classified.add(rowNum);

  // ---- 頁ごとの節（section）: 先頭行の記号で階層を判別。同じ見出しが続く頁は継続頁として結合 ----
  const sections = [];
  let pageTitle = "";
  let companyName = "";
  for (let page = 1; page <= pageCount; page++) {
    const base = (page - 1) * pageRows;
    const fixed = [[P.title, "title"], [P.header, "header"], [P.pageMark, "pageMark"], [P.company, "company"]];
    for (const [pos, kind] of fixed) {
      if (rowHasContent(base + pos)) {
        excluded[kind]++;
        mark(base + pos);
      }
    }
    if (page === 1) {
      pageTitle = text(base + P.title, "symbol");
      companyName = text(base + P.company, "symbol");
    }

    const body = [];
    for (let pos = P.firstBody; pos < P.subtotal; pos++) body.push(rowInfo(base + pos, pos));
    const subtotalRow = rowInfo(base + P.subtotal, P.subtotal);
    const first = body.find((r) => !r.blank);
    const isCover = page === 1;
    let crumb = null;
    let level = "cover";
    if (!isCover) {
      if (first && !first.hasNumbers && first.symbol) {
        crumb = first;
        level = symbolLevel(first.symbol);
        if (!level) {
          warnings.push(`${page}頁目: 見出しの記号「${first.symbol}」の階層を判別できないため、この頁の明細は取り込みません。`);
          level = "unknown";
        }
      } else if (first) {
        warnings.push(`${page}頁目: 頁の先頭行が見出し（記号・名称のみの行）ではないため、この頁の明細は取り込みません。`);
        level = "unknown";
      } else {
        level = "empty";
      }
    }
    const prev = sections[sections.length - 1];
    const sameAsPrev =
      prev && crumb && prev.crumb && prev.level === level && prev.crumb.symbol === crumb.symbol && prev.crumb.name === crumb.name && prev.crumb.spec === crumb.spec;
    if (sameAsPrev) {
      prev.pages.push(page);
      prev.body.push(...body.filter((r) => r !== first));
      prev.subtotalRow = subtotalRow.blank ? prev.subtotalRow : subtotalRow;
    } else {
      sections.push({ level, crumb, pages: [page], body: crumb ? body.filter((r) => r !== first) : body, crumbRow: crumb, subtotalRow, page });
    }
    if (crumb) mark(crumb.rowNum); // 見出し行
    if (!subtotalRow.blank) {
      excluded.subtotal++;
      mark(subtotalRow.rowNum);
    }
  }

  // ---- 表紙: 区分の一覧と合計行 ----
  const cover = { groups: [], totals: [], labelsMatched: true };
  const coverSection = sections[0];
  let coverPart = "building";
  let subtotalIndex = 0;
  for (const r of coverSection?.body || []) {
    if (r.blank) continue;
    mark(r.rowNum);
    if (r.symbol && r.hasNumbers) {
      cover.groups.push({ symbol: r.symbol, name: r.name, quantity: r.quantity, unit: r.unit, unitPrice: r.unitPrice, amount: r.amount, part: coverPart, row: r.rowNum });
    } else if (!r.symbol && r.name && r.amount != null) {
      cover.totals.push({ label: r.name, amount: r.amount, index: subtotalIndex });
      if (r.name !== profile.cover.subtotalLabels[subtotalIndex]) cover.labelsMatched = false;
      subtotalIndex++;
      coverPart = subtotalIndex === 1 ? "common" : "management";
      excluded.coverSubtotal++;
    } else {
      warnings.push(`表紙 ${r.rowNum}行目: 区分行・合計行のどちらにも分類できない行があります。`);
      classified.delete(r.rowNum);
    }
  }
  for (const g of cover.groups) Object.assign(g, groupKindOf(g.part, g.name));

  // ---- 明細行のまとめ（数値行を終端とする連続行 = 1明細、空行区切りの文字だけの行 = 摘要のみの行）----
  function extractLines(section) {
    const lines = [];
    let pending = [];
    let blankBefore = false;
    let pendingBlankBefore = false;
    const flushNote = () => {
      if (pending.length) {
        lines.push({ rows: pending, terminator: null, ambiguous: false, blankBefore: pendingBlankBefore });
        pending = [];
      }
    };
    for (const r of section.body) {
      if (r.blank) {
        flushNote();
        blankBefore = true;
        excluded.blank++;
        continue;
      }
      if (pending.length === 0) pendingBlankBefore = blankBefore;
      pending.push(r);
      blankBefore = false;
      if (r.hasNumbers) {
        // 空行の直後・数値行と同じ偶奇の位置から始まる2行以上の塊は、直前の項目の追記行
        // （摘要のみの行）が混ざっている可能性を否定できない → ambiguous
        const firstRow = pending[0];
        const ambiguous = pendingBlankBefore && pending.length >= 2 && firstRow.pos % 2 === lineParity && !firstRow.hasNumbers;
        lines.push({ rows: pending, terminator: r, ambiguous, blankBefore: pendingBlankBefore });
        pending = [];
      }
    }
    flushNote();
    return lines;
  }

  const joinLines = (rowList, field) => rowList.map((r) => r[field]).filter((t) => t !== "").join("\n");
  const toItemFields = (line) => {
    const last = line.rows[line.rows.length - 1];
    return {
      name: joinLines(line.rows, "name"),
      spec: joinLines(line.rows, "spec"),
      note: joinLines(line.rows, "note"),
      symbol: line.terminator ? line.terminator.symbol : "",
      quantity: line.terminator ? line.terminator.quantity : null,
      unit: line.terminator ? line.terminator.unit : "",
      unitPrice: line.terminator ? line.terminator.unitPrice : null,
      amount: line.terminator ? line.terminator.amount : null,
      noteOnly: !line.terminator,
      ambiguous: line.ambiguous,
      // 判断材料（摘要のみの行・構造要確認の行を人間が判断するための情報）
      blankBefore: !!line.blankBefore,
      rowCount: line.rows.length,
      firstPos: line.rows[0].pos,
      lastPos: last.pos,
      firstRow: line.rows[0].rowNum,
      lastRow: last.rowNum
    };
  };

  // ---- 節を順にたどって階層を確定 ----
  const lines = [];
  const groups = cover.groups.map((g) => ({ symbol: g.symbol, name: g.name, kind: g.kind, kindBasis: g.basis, hasPage: false, coverAmount: g.amount, coverRow: g.row }));
  const subtotals = [];
  let curGroup = null;
  let curWorkType = null; // { symbol, name }
  let order = 0;

  const push = (fields, hier, section) => {
    lines.push({
      displayOrder: ++order,
      groupSymbol: hier.group.symbol,
      groupName: hier.group.name,
      workTypeSymbol: hier.workType?.symbol ?? "",
      workType: hier.workType?.name ?? "",
      subTypeSymbol: hier.subType?.symbol ?? "",
      subType: hier.subType?.name ?? "",
      name: fields.name,
      spec: fields.spec,
      quantity: fields.quantity,
      unit: fields.unit,
      unitPrice: fields.unitPrice,
      amount: fields.amount,
      note: fields.note,
      flags: { noteOnly: fields.noteOnly, ambiguous: fields.ambiguous, coverOnly: !!fields.coverOnly },
      layout: { blankBefore: !!fields.blankBefore, rowCount: fields.rowCount ?? 1, firstPos: fields.firstPos ?? null, lastPos: fields.lastPos ?? null },
      source: { pages: section?.pages ?? [1], firstRow: fields.firstRow, lastRow: fields.lastRow }
    });
  };

  for (let si = 1; si < sections.length; si++) {
    const section = sections[si];
    if (section.level === "unknown" || section.level === "empty") continue;
    const crumb = section.crumb;
    const secLines = extractLines(section);

    if (section.level === "group") {
      curGroup = groups.find((g) => g.symbol === crumb.symbol) || { symbol: crumb.symbol, name: crumb.name, kind: "building", kindBasis: "unknown", hasPage: true, coverAmount: null };
      if (!groups.includes(curGroup)) {
        groups.push(curGroup);
        warnings.push(`区分「${crumb.symbol} ${crumb.name}」が表紙に見つかりません（区分の種類は要確認）。`);
      }
      curGroup.hasPage = true;
      curWorkType = null;
      let nextGroupIndex = sections.findIndex((s, i) => i > si && s.level === "group");
      if (nextGroupIndex < 0) nextGroupIndex = sections.length;
      const scope = sections.slice(si + 1, nextGroupIndex).filter((s) => s.level === "workType");
      let listedTotal = 0;
      let computed = 0;
      for (const line of secLines) {
        const f = toItemFields(line);
        line.rows.forEach((r) => mark(r.rowNum));
        const isListing = f.terminator !== null && scope.some((s) => s.crumb.symbol === f.symbol && normalizeItemText(s.crumb.name) === normalizeItemText(f.name));
        if (!f.noteOnly && isListing) {
          excluded.listing += line.rows.length;
          listedTotal += f.amount ?? 0;
          section.listed = (section.listed || 0) + 1;
        } else {
          push(f, { group: curGroup }, section);
          computed += f.amount ?? 0;
        }
      }
      const coverAmount = curGroup.coverAmount;
      subtotals.push({
        level: "group",
        label: section.subtotalRow?.name ?? "",
        excelAmount: section.subtotalRow?.amount ?? null,
        computedAmount: computed + listedTotal,
        matches: section.subtotalRow?.amount != null ? section.subtotalRow.amount === computed + listedTotal : null,
        coverAmount,
        group: curGroup.name,
        pages: section.pages
      });
      // 区分頁の一覧行の合計（工種行）は、各工種頁の小計と照合される（下の工種節）
    } else if (section.level === "workType") {
      if (!curGroup) {
        warnings.push(`${section.page}頁目: 区分頁より前に工種頁があるため取り込みません。`);
        continue;
      }
      curWorkType = { symbol: crumb.symbol, name: crumb.name };
      let computed = 0;
      for (const line of secLines) {
        const f = toItemFields(line);
        line.rows.forEach((r) => mark(r.rowNum));
        if (!f.noteOnly && symbolLevel(f.symbol) === "subType") {
          excluded.listing += line.rows.length; // 種別の一覧行（明細は種別頁にある）
          section.listedSubTypes = (section.listedSubTypes || 0) + 1;
          computed += f.amount ?? 0;
        } else {
          push(f, { group: curGroup, workType: curWorkType }, section);
          computed += f.amount ?? 0;
        }
      }
      subtotals.push({ level: "workType", label: section.subtotalRow?.name ?? "", excelAmount: section.subtotalRow?.amount ?? null, computedAmount: computed, matches: section.subtotalRow?.amount != null ? section.subtotalRow.amount === computed : null, group: curGroup.name, workType: curWorkType.name, pages: section.pages });
    } else if (section.level === "subType") {
      if (!curGroup || !curWorkType || normalizeItemText(curWorkType.name) !== normalizeItemText(crumb.name)) {
        warnings.push(`${section.page}頁目: 種別頁「${crumb.symbol} ${crumb.name} ${crumb.spec}」が直前の工種頁と対応しないため取り込みません。`);
        continue;
      }
      const subType = { symbol: crumb.symbol, name: crumb.spec };
      let computed = 0;
      for (const line of secLines) {
        const f = toItemFields(line);
        line.rows.forEach((r) => mark(r.rowNum));
        push(f, { group: curGroup, workType: curWorkType, subType }, section);
        computed += f.amount ?? 0;
      }
      subtotals.push({ level: "subType", label: section.subtotalRow?.name ?? "", excelAmount: section.subtotalRow?.amount ?? null, computedAmount: computed, matches: section.subtotalRow?.amount != null ? section.subtotalRow.amount === computed : null, group: curGroup.name, workType: curWorkType.name, subType: subType.name, pages: section.pages });
    }
  }

  // ---- 内訳頁を持たない区分は、表紙の1行を「区分全体の1明細」として取り込む ----
  for (const g of groups) {
    if (!g.hasPage && g.coverAmount != null) {
      const coverRow = cover.groups.find((c) => c.symbol === g.symbol);
      push({ name: g.name, spec: "", note: "", quantity: coverRow.quantity, unit: coverRow.unit, unitPrice: coverRow.unitPrice, amount: coverRow.amount, noteOnly: false, ambiguous: false, coverOnly: true, firstRow: g.coverRow, lastRow: g.coverRow }, { group: g }, null);
    }
  }

  // ---- 検算（Excel上の数値同士の整合。金額の根拠には使わない）----
  const groupPageTotals = groups.map((g) => ({ name: g.name, coverAmount: g.coverAmount, pageSubtotal: subtotals.find((s) => s.level === "group" && s.group === g.name)?.excelAmount ?? null }));
  const detailSum = (kinds) => lines.filter((l) => kinds.includes(groups.find((g) => g.symbol === l.groupSymbol)?.kind)).reduce((s, l) => s + (l.amount ?? 0), 0);
  const direct = detailSum(["building"]);
  const common = detailSum(["common_temp_itemized", "common_temp_general"]);
  const mgmt = detailSum(["site_management"]);
  const coverTotals = cover.totals.map((t) => t.amount);
  const coverCheck = coverTotals.length === 3 ? { direct: coverTotals[0] === direct, net: coverTotals[1] === direct + common, cost: coverTotals[2] === direct + common + mgmt } : null;

  // 全行が分類されたかの確認（黙って落とした行が無いことの根拠）
  const unclassifiedRows = [...rows.keys()].filter((r) => rowHasContent(r) && !classified.has(r));
  const sectionRowsUnclassified = unclassifiedRows.length;

  return {
    ok: true,
    errors,
    warnings,
    result: {
      profileSummary: { pageRows, pageCount, trailingRows },
      sheetName,
      pageTitle,
      companyName,
      groups,
      lines,
      subtotals,
      cover: { totals: cover.totals, labelsMatched: cover.labelsMatched },
      checks: { coverCheck, groupPageTotals, subtotalMismatchCount: subtotals.filter((s) => s.matches === false).length, sectionRowsUnclassified, unclassifiedRows },
      stats: {
        rowsTotal: maxRow,
        rowsNonEmpty: nonEmptyRowCount,
        lineCount: lines.length,
        detailWithNumbers: lines.filter((l) => !l.flags.noteOnly).length,
        noteOnlyCount: lines.filter((l) => l.flags.noteOnly).length,
        ambiguousCount: lines.filter((l) => l.flags.ambiguous).length,
        coverOnlyCount: lines.filter((l) => l.flags.coverOnly).length,
        excluded
      }
    }
  };
}
