/* ==========================================================
   .xlsxテンプレートへのセル単位パッチ（OOXML操作）
   zipUtil.jsが提供する生パート（シートXML・図形XML等）に対し、
   対象セルの中身だけを文字列レベルで書き換える。DOMパーサ等で
   XML全体を再シリアライズしないのは、罫線・書式・他要素を1バイトも
   変えないため（要件「レイアウトを変更しない」を確実に守るには、
   触っていない部分は本当に触らないのが一番安全）。
   ========================================================== */

import { cellRefToRowCol } from "./cellGrid.js";

export function escapeXmlText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  }[ch]));
}

function extractStyleAttr(openTag) {
  const m = /\ss="(\d+)"/.exec(openTag);
  return m ? ` s="${m[1]}"` : "";
}

/**
 * シートXML文字列中の指定セルの中身を書き換える。
 * 既存の書式(s属性)は維持し、値だけをインライン文字列 or 数値として差し込む。
 * 対象セルがXML上に存在しない場合は、同じ行の中の正しい列順の位置へ新規挿入する。
 */
export function setCellInSheetXml(sheetXml, cellRef, value, { numeric = false } = {}) {
  const { row: rowIndex, col: colIndex } = cellRefToRowCol(cellRef);
  const rowNum = rowIndex + 1;

  const existingCellRe = new RegExp(`<c r="${cellRef}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const existingMatch = sheetXml.match(existingCellRe);

  let newCellXml;
  if (numeric && value !== "" && value != null) {
    const styleAttr = existingMatch ? extractStyleAttr(`<c${existingMatch[1]}`) : "";
    newCellXml = `<c r="${cellRef}"${styleAttr}><v>${Number(value)}</v></c>`;
  } else {
    const text = escapeXmlText(value);
    const styleAttr = existingMatch ? extractStyleAttr(`<c${existingMatch[1]}`) : "";
    newCellXml = `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
  }

  if (existingMatch) {
    return sheetXml.slice(0, existingMatch.index) + newCellXml + sheetXml.slice(existingMatch.index + existingMatch[0].length);
  }

  // セルがXML上に存在しない行への新規挿入（列順を守って挿入する）
  const rowRe = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) {
    throw new Error(`テンプレートに行${rowNum}が見つかりません（セル${cellRef}）`);
  }
  const rowInner = rowMatch[2];
  const cellTagRe = /<c r="([A-Z]+)(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g;
  let insertAt = rowInner.length;
  let m;
  while ((m = cellTagRe.exec(rowInner))) {
    const { col } = cellRefToRowCol(`${m[1]}1`);
    if (col > colIndex) {
      insertAt = m.index;
      break;
    }
  }
  const newRowInner = rowInner.slice(0, insertAt) + newCellXml + rowInner.slice(insertAt);
  const newRow = `<row r="${rowNum}"${rowMatch[1]}>${newRowInner}</row>`;
  return sheetXml.slice(0, rowMatch.index) + newRow + sheetXml.slice(rowMatch.index + rowMatch[0].length);
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-07-18" → "2026年7月18日（金）" 。不正な日付はそのまま返す。 */
export function formatJapaneseDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`;
}

const FORMATTERS = {
  japaneseDate: formatJapaneseDate
};

function getFieldValue(model, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), model);
}

/** "工事名：{site.name}" のようなテンプレート文字列にモデルの値を差し込む */
export function renderTemplateString(template, model) {
  return template.replace(/\{([^}|]+)(?:\|([a-zA-Z]+))?\}/g, (_, path, formatterName) => {
    const raw = getFieldValue(model, path.trim());
    const formatter = formatterName ? FORMATTERS[formatterName] : null;
    if (formatter) return formatter(raw ?? "");
    return raw == null ? "" : String(raw);
  });
}

/**
 * シートの印刷設定に「1ページに収める」拡大縮小印刷を追加する。
 * ユーザーの明示的な許可のもとに追加した唯一の例外的な印刷設定変更で、
 * セル・行高さ・列幅・結合・余白等、他の一切の要素には触れない。
 * 対象テンプレートに既にfitToWidth/fitToHeightの指定がある場合は
 * 何もしない（テンプレート側の意図的な設定を上書きしないため）。
 */
export function setSheetFitToPage(sheetXml, { width = 1, height = 1 } = {}) {
  let result = sheetXml.replace(/<pageSetup([^>]*?)\/>/, (match, attrs) => {
    if (/\sfitToWidth=/.test(attrs) || /\sfitToHeight=/.test(attrs)) return match;
    return `<pageSetup${attrs} fitToWidth="${width}" fitToHeight="${height}"/>`;
  });
  if (result === sheetXml) return sheetXml; // pageSetup要素が無い、または既に設定済み

  if (/<sheetPr\b[^>]*\/>/.test(result)) {
    result = result.replace(/<sheetPr([^>]*)\/>/, (_, attrs) => `<sheetPr${attrs}><pageSetUpPr fitToPage="1"/></sheetPr>`);
  } else if (/<sheetPr\b[^>]*>/.test(result)) {
    if (/<pageSetUpPr\b/.test(result)) {
      result = result.replace(/<pageSetUpPr([^>]*)\/>/, (match, attrs) =>
        /\sfitToPage=/.test(attrs) ? match.replace(/fitToPage="[^"]*"/, 'fitToPage="1"') : `<pageSetUpPr${attrs} fitToPage="1"/>`
      );
    } else {
      result = result.replace(/(<sheetPr[^>]*>)/, `$1<pageSetUpPr fitToPage="1"/>`);
    }
  } else {
    result = result.replace(/(<worksheet[^>]*>)/, `$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
  }

  return result;
}

const EMU_PER_POINT = 12700; // 1pt = 1/72inch = 914400/72 EMU
const DEFAULT_ROW_HEIGHT_PT = 15; // sheetFormatPrにdefaultRowHeightが無い場合の保険値
const DEFAULT_COL_WIDTH_CHARS = 8.43; // Excelの標準既定列幅

/**
 * シートXMLの<row ht="...">・<col width="...">から、指定セル1マス分の
 * 概算サイズをEMU単位で求める。桁計算はExcelの内部変換式の近似（多くの
 * OOXML実装で採用されている一般的な近似式）であり、Excelの内部丸めと
 * 完全一致はしないが、貼り付ける画像のアンカーサイズを0のまま残す
 * （＝ビューアによっては非表示・読み込み失敗になりうる）よりも安全。
 */
export function estimateCellExtentEmu(sheetXml, colLetter, rowNum) {
  const { col: colIndex } = cellRefToRowCol(`${colLetter}1`);
  const colNum1Based = colIndex + 1;

  let widthChars = DEFAULT_COL_WIDTH_CHARS;
  const colRe = /<col min="(\d+)" max="(\d+)"[^>]*\swidth="([\d.]+)"/g;
  let m;
  while ((m = colRe.exec(sheetXml))) {
    if (colNum1Based >= Number(m[1]) && colNum1Based <= Number(m[2])) {
      widthChars = Number(m[3]);
      break;
    }
  }

  let heightPt = DEFAULT_ROW_HEIGHT_PT;
  const rowMatch = sheetXml.match(new RegExp(`<row r="${rowNum}"[^>]*\\sht="([\\d.]+)"`));
  if (rowMatch) heightPt = Number(rowMatch[1]);
  else {
    const defaultMatch = sheetXml.match(/<sheetFormatPr[^>]*\sdefaultRowHeight="([\d.]+)"/);
    if (defaultMatch) heightPt = Number(defaultMatch[1]);
  }

  const widthPx = Math.round(widthChars * 7 + 5);
  const heightPx = Math.round((heightPt * 96) / 72);

  return { cx: widthPx * 9525, cy: heightPx * 9525 };
}

/**
 * 図形パート(drawingN.xml)の末尾に、指定セル範囲へアンカーされた画像を追記する。
 * 既存の図形（ロゴ等）は一切変更せず、新しい<xdr:twoCellAnchor>を追加するだけ。
 */
export function appendImageAnchorToDrawingXml(drawingXml, { fromCellRef, toCellRef, relationshipId, shapeId, shapeName, extentEmu }) {
  const from = cellRefToRowCol(fromCellRef);
  const to = cellRefToRowCol(toCellRef);
  const cx = extentEmu?.cx || 1; // 0だと一部ビューアで図形が読み込まれないため最低1EMUは確保する
  const cy = extentEmu?.cy || 1;
  const anchorXml = `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>${from.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${to.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:pic>` +
    `<xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="${escapeXmlText(shapeName)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;

  const closeTag = "</xdr:wsDr>";
  const idx = drawingXml.lastIndexOf(closeTag);
  if (idx === -1) throw new Error("図形パート(drawing.xml)の解析に失敗しました");
  return drawingXml.slice(0, idx) + anchorXml + drawingXml.slice(idx);
}

/** 関係定義パート(.rels)の末尾に新しい<Relationship>を追記する */
export function appendRelationship(relsXml, { id, type, target }) {
  const entry = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const closeTag = "</Relationships>";
  const idx = relsXml.lastIndexOf(closeTag);
  if (idx === -1) throw new Error(".relsパートの解析に失敗しました");
  return relsXml.slice(0, idx) + entry + relsXml.slice(idx);
}

/** [Content_Types].xmlに拡張子の既定Content-Typeが無ければ追記する */
export function ensureDefaultContentType(contentTypesXml, extension, contentType) {
  const re = new RegExp(`<Default Extension="${extension}"`);
  if (re.test(contentTypesXml)) return contentTypesXml;
  const entry = `<Default Extension="${extension}" ContentType="${contentType}"/>`;
  const closeTag = "</Types>";
  const idx = contentTypesXml.lastIndexOf(closeTag);
  if (idx === -1) throw new Error("[Content_Types].xmlの解析に失敗しました");
  return contentTypesXml.slice(0, idx) + entry + contentTypesXml.slice(idx);
}

/** workbook.xml + workbook.xml.rels から、シート表示名に対応するパートパスを求める */
export function resolveSheetPartPath(workbookXml, workbookRelsXml, sheetName) {
  const sheetRe = new RegExp(`<sheet name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*r:id="(rId\\d+)"`);
  const m = workbookXml.match(sheetRe);
  if (!m) throw new Error(`シートが見つかりません: ${sheetName}`);
  const relId = m[1];
  const relRe = new RegExp(`<Relationship Id="${relId}"[^>]*Target="([^"]+)"`);
  const relMatch = workbookRelsXml.match(relRe);
  if (!relMatch) throw new Error(`シートの関係定義が見つかりません: ${sheetName}`);
  return `xl/${relMatch[1]}`;
}
