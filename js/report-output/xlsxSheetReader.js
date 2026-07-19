/* ==========================================================
   .xlsxのstyles.xml／シートXML／共有文字列を読み取り専用で解析する。
   会社指定PDF（companyPdfFromXlsx.js）が、Excelの見た目（罫線・
   フォント・塗り・列幅・行高さ・セル結合・印刷設定）をHTMLで
   再現するために使う。
   xlsxTemplateEngine.js（書き込み側）とは違い、こちらは書き戻しを
   行わないため、正規表現ではなくDOMParserで正規に解析する。
   ========================================================== */

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function parseXml(xmlText) {
  return new DOMParser().parseFromString(xmlText, "application/xml");
}

function children(el, tagName) {
  return el ? Array.from(el.getElementsByTagName(tagName)) : [];
}

/** attrがnull/未指定/非数値の場合だけfallbackを使う（"0"という正当な値を || で握りつぶさないため） */
function numOr(attrValue, fallback) {
  if (attrValue == null) return fallback;
  const n = Number(attrValue);
  return Number.isNaN(n) ? fallback : n;
}

// Excelの既定インデックスカラーパレット（0〜63）のうち、実務でよく使われる範囲のみ。
// 該当が無い場合はnull（＝CSS側で既定色を継承）を返す。
const INDEXED_COLORS = {
  0: "#000000", 1: "#FFFFFF", 2: "#FF0000", 3: "#00FF00", 4: "#0000FF",
  5: "#FFFF00", 6: "#FF00FF", 7: "#00FFFF", 8: "#000000", 9: "#FFFFFF",
  10: "#FF0000", 11: "#00FF00", 12: "#0000FF", 13: "#FFFF00", 14: "#FF00FF",
  15: "#00FFFF"
};

function resolveColor(colorEl) {
  if (!colorEl) return null;
  const rgb = colorEl.getAttribute("rgb");
  if (rgb && rgb.length >= 6) return `#${rgb.slice(-6)}`;
  const indexed = colorEl.getAttribute("indexed");
  if (indexed != null) {
    const idx = Number(indexed);
    if (idx === 64 || idx === 65) return null; // automatic/system色は既定に任せる
    return INDEXED_COLORS[idx] || null;
  }
  return null; // theme色は簡略化のため既定色にフォールバック
}

const BORDER_STYLE_CSS = {
  thin: "1px solid",
  hair: "0.5px solid",
  medium: "2px solid",
  thick: "3px solid",
  dashed: "1px dashed",
  dotted: "1px dotted",
  double: "3px double",
  mediumDashed: "2px dashed",
  dashDot: "1px dashed",
  mediumDashDot: "2px dashed"
};

function parseBorderSide(sideEl) {
  const style = sideEl?.getAttribute("style");
  if (!style) return null;
  const color = resolveColor(sideEl.getElementsByTagName("color")[0]) || "#000000";
  return `${BORDER_STYLE_CSS[style] || "1px solid"} ${color}`;
}

function parseFontEl(fontEl) {
  return {
    sizePt: Number(fontEl.getElementsByTagName("sz")[0]?.getAttribute("val")) || 11,
    name: fontEl.getElementsByTagName("name")[0]?.getAttribute("val") || "ＭＳ Ｐゴシック",
    bold: fontEl.getElementsByTagName("b").length > 0,
    italic: fontEl.getElementsByTagName("i").length > 0,
    underline: fontEl.getElementsByTagName("u").length > 0,
    color: resolveColor(fontEl.getElementsByTagName("color")[0])
  };
}

function parseFillEl(fillEl) {
  const pattern = fillEl.getElementsByTagName("patternFill")[0];
  if (!pattern || pattern.getAttribute("patternType") !== "solid") return null;
  return resolveColor(pattern.getElementsByTagName("fgColor")[0]);
}

function parseBorderEl(borderEl) {
  return {
    left: parseBorderSide(borderEl.getElementsByTagName("left")[0]),
    right: parseBorderSide(borderEl.getElementsByTagName("right")[0]),
    top: parseBorderSide(borderEl.getElementsByTagName("top")[0]),
    bottom: parseBorderSide(borderEl.getElementsByTagName("bottom")[0])
  };
}

function parseXfEl(xfEl) {
  const alignEl = xfEl.getElementsByTagName("alignment")[0];
  return {
    fontId: Number(xfEl.getAttribute("fontId")) || 0,
    fillId: Number(xfEl.getAttribute("fillId")) || 0,
    borderId: Number(xfEl.getAttribute("borderId")) || 0,
    alignment: {
      horizontal: alignEl?.getAttribute("horizontal") || null,
      vertical: alignEl?.getAttribute("vertical") || null,
      wrapText: alignEl?.getAttribute("wrapText") === "1"
    }
  };
}

/** styles.xmlを解析し、セルのスタイルインデックス(s属性)から見た目を引けるようにする */
export function parseXlsxStyles(stylesXml) {
  const doc = parseXml(stylesXml);
  const fontsRoot = doc.getElementsByTagName("fonts")[0];
  const fillsRoot = doc.getElementsByTagName("fills")[0];
  const bordersRoot = doc.getElementsByTagName("borders")[0];
  const xfsRoot = doc.getElementsByTagName("cellXfs")[0];

  const fonts = children(fontsRoot, "font").map(parseFontEl);
  const fills = children(fillsRoot, "fill").map(parseFillEl);
  const borders = children(bordersRoot, "border").map(parseBorderEl);
  const cellXfs = children(xfsRoot, "xf").map(parseXfEl);

  return {
    resolveStyle(styleIndex) {
      const xf = cellXfs[styleIndex] || cellXfs[0] || { fontId: 0, fillId: 0, borderId: 0, alignment: {} };
      return {
        font: fonts[xf.fontId] || {},
        fill: fills[xf.fillId] || null,
        border: borders[xf.borderId] || {},
        alignment: xf.alignment
      };
    }
  };
}

/**
 * sharedStrings.xmlを文字列配列に変換する（<si>のテキストランを連結）。
 * <rPh>（フリガナ用の読み情報）の中の<t>は表示用の本文ではないため、
 * 直下の<t>／<r><t>だけを対象にし、<rPh>配下は明示的に除外する。
 */
export function parseSharedStrings(sharedStringsXml) {
  if (!sharedStringsXml) return [];
  const doc = parseXml(sharedStringsXml);
  return children(doc.documentElement, "si").map((si) => {
    let text = "";
    for (const child of Array.from(si.children)) {
      if (child.tagName === "t") text += child.textContent;
      else if (child.tagName === "r") {
        const t = Array.from(child.children).find((c) => c.tagName === "t");
        if (t) text += t.textContent;
      }
      // rPh（フリガナ）・phoneticPrは読み上げ用メタデータのため無視する
    }
    return text;
  });
}

const EXCEL_COL_WIDTH_TO_PX = (chars) => Math.round(chars * 7 + 5);
const PT_TO_PX = (pt) => Math.round((pt * 96) / 72);

/**
 * シートXML（データ差し込み済み）から、HTML描画に必要なレイアウト情報一式を読み取る。
 * @returns {{
 *   maxRow: number, maxCol: number,
 *   colWidthPx: number[], rowHeightPx: number[],
 *   merges: Array<{r1:number,c1:number,r2:number,c2:number}>,
 *   cells: Map<string, {text: string, styleIndex: number}>,
 *   pageSetup: {paperSize: string, orientation: string},
 *   pageMarginsIn: {left:number,right:number,top:number,bottom:number}
 * }}
 */
export function readSheetLayout(sheetXml, sharedStrings) {
  const doc = parseXml(sheetXml);
  const root = doc.documentElement;

  const dimensionRef = root.getElementsByTagName("dimension")[0]?.getAttribute("ref") || "A1:A1";
  const [, endRef] = dimensionRef.split(":");
  const endMatch = /^([A-Z]+)(\d+)$/.exec((endRef || dimensionRef).toUpperCase());
  const maxCol = endMatch ? colLettersToIndex(endMatch[1]) : 1;
  const maxRow = endMatch ? Number(endMatch[2]) : 1;

  const defaultColWidth = Number(root.getElementsByTagName("sheetFormatPr")[0]?.getAttribute("defaultColWidth")) || 8.43;
  const defaultRowHeightPt = Number(root.getElementsByTagName("sheetFormatPr")[0]?.getAttribute("defaultRowHeight")) || 15;

  const colWidthChars = new Array(maxCol + 1).fill(defaultColWidth);
  children(root.getElementsByTagName("cols")[0], "col").forEach((colEl) => {
    const min = Number(colEl.getAttribute("min"));
    const max = Number(colEl.getAttribute("max"));
    const width = Number(colEl.getAttribute("width"));
    if (!width) return;
    for (let c = min; c <= Math.min(max, maxCol); c++) colWidthChars[c] = width;
  });
  const colWidthPx = colWidthChars.map(EXCEL_COL_WIDTH_TO_PX);

  const rowHeightPt = new Array(maxRow + 1).fill(defaultRowHeightPt);
  const rowEls = children(root.getElementsByTagName("sheetData")[0], "row");
  rowEls.forEach((rowEl) => {
    const r = Number(rowEl.getAttribute("r"));
    const ht = Number(rowEl.getAttribute("ht"));
    if (r <= maxRow && ht) rowHeightPt[r] = ht;
  });
  const rowHeightPx = rowHeightPt.map(PT_TO_PX);

  const merges = children(root.getElementsByTagName("mergeCells")[0], "mergeCell").map((mc) => {
    const [start, end] = mc.getAttribute("ref").split(":");
    const s = /^([A-Z]+)(\d+)$/.exec(start);
    const e = /^([A-Z]+)(\d+)$/.exec(end || start);
    return { r1: Number(s[2]), c1: colLettersToIndex(s[1]), r2: Number(e[2]), c2: colLettersToIndex(e[1]) };
  });

  const cells = new Map();
  rowEls.forEach((rowEl) => {
    children(rowEl, "c").forEach((cEl) => {
      const ref = cEl.getAttribute("r");
      const styleIndex = Number(cEl.getAttribute("s")) || 0;
      const type = cEl.getAttribute("t");
      let text = "";
      if (type === "inlineStr") {
        text = cEl.getElementsByTagName("t")[0]?.textContent || "";
      } else if (type === "s") {
        const idx = Number(cEl.getElementsByTagName("v")[0]?.textContent);
        text = sharedStrings[idx] || "";
      } else {
        text = cEl.getElementsByTagName("v")[0]?.textContent || "";
      }
      if (text !== "" || styleIndex) cells.set(ref, { text, styleIndex });
    });
  });

  const pageSetupEl = root.getElementsByTagName("pageSetup")[0];
  const pageMarginsEl = root.getElementsByTagName("pageMargins")[0];

  return {
    maxRow,
    maxCol,
    colWidthPx,
    rowHeightPx,
    merges,
    cells,
    pageSetup: {
      paperSize: pageSetupEl?.getAttribute("paperSize") || "9",
      orientation: pageSetupEl?.getAttribute("orientation") || "portrait"
    },
    pageMarginsIn: {
      left: numOr(pageMarginsEl?.getAttribute("left"), 0.7),
      right: numOr(pageMarginsEl?.getAttribute("right"), 0.7),
      top: numOr(pageMarginsEl?.getAttribute("top"), 0.75),
      bottom: numOr(pageMarginsEl?.getAttribute("bottom"), 0.75)
    }
  };
}

export function colLettersToIndex(letters) {
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}
