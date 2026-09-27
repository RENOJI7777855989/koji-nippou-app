/* ==========================================================
   提出内訳書のシートXML再構築（純粋関数、DOM・DB非依存）
   原本テンプレートのシートXMLのうち<sheetData>と<mergeCells>と
   <dimension>だけを作り直し、列幅・書式・余白・用紙・フッター・
   フォント（styles.xml）・テーマ等は1バイトも変えずに引き継ぐ。
   各頁の行は「原本1頁目の同じ行位置の行」を土台にする:
     ・見出し行・空行・会社名行 … 原本の行XMLをそのまま複製
     ・工事名行・頁番号行 … 複製して該当セルだけ差し替え
     ・本体行 … プロファイルの行位置別スタイルで空セルを作り、
       明細の値が入るセルだけ内容を書く（数値／折返し文字は原本と
       同じ規則のスタイルへ切り替え）
   ========================================================== */

import { escapeXmlText } from "../report-output/xlsxTemplateEngine.js";

const NUMERIC_FIELDS = new Set(["quantity", "unitPrice", "amount"]);

const PAPER_SIZES_PT = {
  8: [841.89, 1190.55], // A3
  9: [595.28, 841.89], // A4
  11: [419.53, 595.28], // A5
  12: [515.91, 728.5] // B4(JIS)
};

function rowXmlOf(sheetXml, rowNum) {
  const m = new RegExp(`<row r="${rowNum}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`).exec(sheetXml);
  return m ? m[0] : null;
}

/** 行XMLの行番号とセル参照を付け替える（複製用） */
function renumberRowXml(rowXml, newRow) {
  return rowXml.replace(/<row r="\d+"/, `<row r="${newRow}"`).replace(/<c r="([A-Z]+)\d+"/g, `<c r="$1${newRow}"`);
}

function textCellXml(ref, style, text) {
  const s = style != null ? ` s="${style}"` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(String(text).replace(/\r\n/g, "\n"))}</t></is></c>`;
}

function numberCellXml(ref, style, value) {
  const s = style != null ? ` s="${style}"` : "";
  return `<c r="${ref}"${s}><v>${Number(value)}</v></c>`;
}

function emptyCellXml(ref, style) {
  return style != null ? `<c r="${ref}" s="${style}"/>` : `<c r="${ref}"/>`;
}

/** 複製した行XML中の指定列のセルを、テキストセルで置き換える（既存のs属性は維持） */
function replaceTextCellInRow(rowXml, rowNum, col, text) {
  const ref = `${col}${rowNum}`;
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = re.exec(rowXml);
  const style = m ? /\ss="(\d+)"/.exec(m[1])?.[1] : null;
  const cell = textCellXml(ref, style, text);
  if (!m) throw new Error(`複製元の行にセル${ref}がありません`);
  return rowXml.slice(0, m.index) + cell + rowXml.slice(m.index + m[0].length);
}

function styleFor(profile, pos, colIndex, value, field) {
  const col = profile.columns[colIndex];
  const proto = profile.frameStyles[pos]?.[colIndex] ?? null;
  if (proto == null) return null;
  if (NUMERIC_FIELDS.has(field)) return profile.numberStyle[`${col}:${proto}`] ?? proto;
  if (typeof value === "string" && /[\r\n]/.test(value)) return profile.wrapStyle[`${col}:${proto}`] ?? proto;
  return proto;
}

function bodyRowXml(profile, rowNum, pos, cells) {
  const attrs = profile.rowAttrs[pos];
  const inner = profile.columns
    .map((col, ci) => {
      const ref = `${col}${rowNum}`;
      const field = Object.keys(profile.fieldColumns).find((key) => profile.fieldColumns[key] === col);
      const value = field ? cells?.[field] : undefined;
      if (value === undefined || value === null || value === "") return emptyCellXml(ref, profile.frameStyles[pos]?.[ci] ?? null);
      const style = styleFor(profile, pos, ci, value, field);
      return NUMERIC_FIELDS.has(field) ? numberCellXml(ref, style, value) : textCellXml(ref, style, value);
    })
    .join("");
  return `<row r="${rowNum}" ${attrs}>${inner}</row>`;
}

/** 印刷の「1頁に収める」拡大率(%)。用紙・余白・行高・列幅から算出。判別できなければnull */
export function computeFitScalePercent(sheetXml, profile) {
  const setup = /<pageSetup([^>]*)\/>/.exec(sheetXml);
  const margins = /<pageMargins([^>]*)\/>/.exec(sheetXml);
  if (!setup || !margins) return null;
  const paper = PAPER_SIZES_PT[Number(/\spaperSize="(\d+)"/.exec(setup[1])?.[1] ?? 9)];
  if (!paper) return null;
  const landscape = /\sorientation="landscape"/.test(setup[1]);
  const [w, h] = landscape ? [Math.max(...paper), Math.min(...paper)] : [Math.min(...paper), Math.max(...paper)];
  const margin = (name) => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(margins[1])?.[1]) * 72;
  const printableW = w - margin("left") - margin("right");
  const printableH = h - margin("top") - margin("bottom");

  const defaultHeight = Number(/<sheetFormatPr[^>]*\sdefaultRowHeight="([\d.]+)"/.exec(sheetXml)?.[1] ?? 15);
  let pageHeight = 0;
  for (let pos = 1; pos <= profile.pageRows; pos++) {
    pageHeight += Number(/\sht="([\d.]+)"/.exec(profile.rowAttrs[pos] || "")?.[1] ?? defaultHeight);
  }

  // 列幅（文字数）→ 概算px。1文字=8pxと見て少し余裕を持たせる（実際のフォントより広めに見積もる）
  let widthPx = 0;
  const colRe = /<col min="(\d+)" max="(\d+)"[^>]*\swidth="([\d.]+)"/g;
  let m;
  while ((m = colRe.exec(sheetXml))) {
    const min = Number(m[1]);
    const max = Math.min(Number(m[2]), profile.columns.length);
    for (let c = min; c <= max; c++) widthPx += Number(m[3]) * 8 + 5;
  }
  const widthPt = widthPx * 0.75;
  if (!pageHeight || !widthPt) return null;

  const scale = Math.floor(Math.min(1, printableH / pageHeight, printableW / widthPt) * 100);
  return Math.max(10, Math.min(100, scale));
}

function applyFitPrintSettings(tail, sheetXml, profile, pageCount) {
  const scale = computeFitScalePercent(sheetXml, profile);
  let result = tail;
  if (scale != null && scale < 100) {
    result = result.replace(/<pageSetup([^>]*?)\/>/, (match, attrs) => {
      const cleaned = attrs.replace(/\sscale="[^"]*"/, "").replace(/\sfitToWidth="[^"]*"/, "").replace(/\sfitToHeight="[^"]*"/, "");
      return `<pageSetup${cleaned} scale="${scale}"/>`;
    });
  }
  result = result.replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/, "");
  const breaks = [];
  for (let p = 1; p < pageCount; p++) breaks.push(`<brk id="${p * profile.pageRows}" max="16383" man="1"/>`);
  if (breaks.length > 0) {
    const rowBreaks = `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.join("")}</rowBreaks>`;
    if (/<\/headerFooter>/.test(result)) result = result.replace(/<\/headerFooter>/, `</headerFooter>${rowBreaks}`);
    else if (/<pageSetup[^>]*\/>/.test(result)) result = result.replace(/(<pageSetup[^>]*\/>)/, `$1${rowBreaks}`);
    else result = result.replace(/<\/worksheet>/, `${rowBreaks}</worksheet>`);
  }
  return { tail: result, scale };
}

/**
 * @param {object} params
 * @param {string} params.templateSheetXml 原本のシートXML
 * @param {object} params.profile analyzeSubmissionTemplate()のprofile
 * @param {object[]} params.pages buildSubmissionPages().pages
 * @param {string} params.projectTitle 各頁の工事名
 * @param {string} params.companyName 各頁の会社名（原本の文言と同じなら原本のまま）
 * @param {"original"|"fit"} [params.printMode] fit=1頁ごとの改頁と拡大縮小を追加（既定は原本の印刷設定のまま）
 * @returns {{ sheetXml: string, pageCount: number, printScale: number|null }}
 */
export function buildSubmissionSheetXml({ templateSheetXml, profile, pages, projectTitle, companyName, printMode = "original" }) {
  const { pageRows, positions, titleColumn } = profile;
  const dataStart = templateSheetXml.indexOf("<sheetData>");
  const dataEnd = templateSheetXml.indexOf("</sheetData>");
  if (dataStart < 0 || dataEnd < 0) throw new Error("テンプレートのシートXMLを解析できません（sheetDataが見つかりません）");

  const fixed = {};
  for (const key of ["title", "header", "pageMark", "company"]) fixed[positions[key]] = rowXmlOf(templateSheetXml, positions[key]);
  const blankFirstRow = rowXmlOf(templateSheetXml, 1);
  for (let pos = 1; pos < positions.firstBody; pos++) {
    if (!fixed[pos]) fixed[pos] = pos === 1 ? blankFirstRow : rowXmlOf(templateSheetXml, pos);
  }
  for (const [pos, xml] of Object.entries(fixed)) if (!xml) throw new Error(`テンプレートの${pos}行目が見つかりません`);

  const rowsXml = [];
  const companyText = companyName ?? profile.defaults.companyName;
  pages.forEach((page, pageIndex) => {
    const base = pageIndex * pageRows;
    const byPos = new Map(page.rows.map((r) => [r.pos, r]));
    if (page.subtotal) byPos.set(page.subtotal.pos, page.subtotal);

    for (let pos = 1; pos <= pageRows; pos++) {
      const rowNum = base + pos;
      if (pos === positions.title) {
        rowsXml.push(replaceTextCellInRow(renumberRowXml(fixed[pos], rowNum), rowNum, titleColumn, projectTitle));
      } else if (pos === positions.pageMark) {
        rowsXml.push(replaceTextCellInRow(renumberRowXml(fixed[pos], rowNum), rowNum, profile.pageMarkColumn, `P-${pageIndex + 1}`));
      } else if (pos === positions.company) {
        const xml = renumberRowXml(fixed[pos], rowNum);
        rowsXml.push(companyText === profile.defaults.companyName ? xml : replaceTextCellInRow(xml, rowNum, titleColumn, companyText));
      } else if (pos < positions.firstBody) {
        rowsXml.push(renumberRowXml(fixed[pos], rowNum));
      } else {
        rowsXml.push(bodyRowXml(profile, rowNum, pos, byPos.get(pos)?.cells));
      }
    }
  });

  const lastRow = pages.length * pageRows;
  const firstCol = profile.columns[0];
  const lastCol = profile.columns[profile.columns.length - 1];
  const mergeXml =
    `<mergeCells count="${pages.length}">` +
    pages.map((_, i) => `<mergeCell ref="${firstCol}${(i + 1) * pageRows}:${lastCol}${(i + 1) * pageRows}"/>`).join("") +
    `</mergeCells>`;

  let head = templateSheetXml.slice(0, dataStart).replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${firstCol}1:${lastCol}${lastRow}"/>`);
  let tail = templateSheetXml.slice(dataEnd + "</sheetData>".length);
  tail = /<mergeCells[\s\S]*?<\/mergeCells>/.test(tail) ? tail.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, mergeXml) : mergeXml + tail;

  let printScale = null;
  if (printMode === "fit") {
    const applied = applyFitPrintSettings(tail, templateSheetXml, profile, pages.length);
    tail = applied.tail;
    printScale = applied.scale;
  }

  return { sheetXml: `${head}<sheetData>${rowsXml.join("")}</sheetData>${tail}`, pageCount: pages.length, printScale };
}
