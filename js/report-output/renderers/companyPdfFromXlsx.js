/* ==========================================================
   ①会社指定PDF（rendererId: "xlsx-template-print-html"）
   会社指定のExcelテンプレート（.xlsx）を、レイアウト（セル結合・
   罫線・列幅・行高さ・A3横などの印刷設定）を保ったままHTMLとして
   再現し、ブラウザの印刷機能でPDF化するためのレンダラー。
   このアプリは外部ライブラリに依存しない方針のため、xlsxを直接
   バイナリPDFへ変換するのではなく、Excelの見た目をHTML+CSSで
   再現する方式を採用している（実際のPDF化は印刷ダイアログ経由）。

   「どのセルに何を書き込むか」はxlsxCellPlan.js（Excelバイナリ出力
   と共有）で計算し、その結果をxlsxSheetReader.jsで再解析して
   HTMLテーブルを組み立てる。ロゴ・職長サイン画像は、シートの
   図形パート(drawing*.xml)のアンカー位置をそのままCSSの絶対配置に
   変換して重ねる。

   完全なOOXMLレンダラーではなく、Excel本体のPDF出力とピクセル単位
   で完全一致する保証はない（罫線・フォント・配置・セル結合・列幅
   行高さ・印刷範囲・用紙サイズ/向きは再現するが、斜め罫線や
   テーマ色などは簡略化している）。
   ========================================================== */

import { registerPdfRenderer } from "../rendererRegistry.js";
import { loadZip, readZipEntryText, readZipEntryBytes } from "../../zipUtil.js";
import { setCellInSheetXml, resolveSheetPartPath } from "../xlsxTemplateEngine.js";
import { buildXlsxCellPlan } from "../xlsxCellPlan.js";
import { parseXlsxStyles, parseSharedStrings, readSheetLayout, colLettersToIndex } from "../xlsxSheetReader.js";
import { escapeHtml } from "../../utils.js";
import { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING } from "./mappings/anzenEiseiUchiawaseNisshi.js";

const EMU_PER_PX = 9525;
const PAPER_SIZE_MM = {
  1: [216, 279], 3: [216, 356], 5: [216, 356], 8: [297, 420], 9: [210, 297], 11: [148, 210]
};

function guessMimeType(path) {
  const ext = path.split(".").pop().toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" }[ext] || "image/png";
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function bytesToDataUrl(bytes, mimeType) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** 列/行の累積オフセット(px)配列を作る（インデックス1がA列/1行目の開始位置=0） */
function buildOffsets(sizesPx) {
  const offsets = [0];
  for (let i = 1; i < sizesPx.length; i++) offsets.push(offsets[i - 1] + (sizesPx[i - 1] || 0));
  return offsets;
}

async function loadDrawingParts(zip, sheetPath) {
  const sheetRelsPath = sheetPath.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels";
  const sheetRelsXml = await readZipEntryText(zip, sheetRelsPath);
  const m = sheetRelsXml?.match(/Target="([^"]*drawings\/(drawing\d+\.xml))"/);
  if (!m) return null;
  const drawingPath = `xl/drawings/${m[2]}`;
  const drawingRelsPath = `xl/drawings/_rels/${m[2]}.rels`;
  const drawingXml = await readZipEntryText(zip, drawingPath);
  const drawingRelsXml = await readZipEntryText(zip, drawingRelsPath);
  return { drawingXml, drawingRelsXml };
}

/** 図形パートの画像(<xdr:pic>)・テキストのみの図形(<xdr:sp>)を抽出し、px座標に変換する */
async function collectTemplateShapes(zip, sheetPath, colOffsetPx, rowOffsetPx) {
  const parts = await loadDrawingParts(zip, sheetPath);
  if (!parts) return { images: [], textShapes: [] };
  const doc = new DOMParser().parseFromString(parts.drawingXml, "application/xml");
  const relsDoc = parts.drawingRelsXml ? new DOMParser().parseFromString(parts.drawingRelsXml, "application/xml") : null;
  const relTargets = new Map();
  if (relsDoc) {
    Array.from(relsDoc.getElementsByTagName("Relationship")).forEach((r) => {
      relTargets.set(r.getAttribute("Id"), r.getAttribute("Target"));
    });
  }

  function anchorBoxFromTwoCell(anchorEl) {
    const from = anchorEl.getElementsByTagName("xdr:from")[0];
    const to = anchorEl.getElementsByTagName("xdr:to")[0];
    const fromCol = Number(from.getElementsByTagName("xdr:col")[0].textContent);
    const fromRow = Number(from.getElementsByTagName("xdr:row")[0].textContent);
    const toCol = Number(to.getElementsByTagName("xdr:col")[0].textContent);
    const toRow = Number(to.getElementsByTagName("xdr:row")[0].textContent);
    return {
      left: colOffsetPx[fromCol + 1] || 0,
      top: rowOffsetPx[fromRow + 1] || 0,
      width: (colOffsetPx[toCol + 1] || 0) - (colOffsetPx[fromCol + 1] || 0),
      height: (rowOffsetPx[toRow + 1] || 0) - (rowOffsetPx[fromRow + 1] || 0)
    };
  }

  function anchorBoxFromOneCell(anchorEl) {
    const from = anchorEl.getElementsByTagName("xdr:from")[0];
    const fromCol = Number(from.getElementsByTagName("xdr:col")[0].textContent);
    const fromRow = Number(from.getElementsByTagName("xdr:row")[0].textContent);
    const colOff = Number(from.getElementsByTagName("xdr:colOff")[0]?.textContent) || 0;
    const rowOff = Number(from.getElementsByTagName("xdr:rowOff")[0]?.textContent) || 0;
    const ext = anchorEl.getElementsByTagName("xdr:ext")[0];
    const cx = Number(ext?.getAttribute("cx")) || 0;
    const cy = Number(ext?.getAttribute("cy")) || 0;
    return {
      left: (colOffsetPx[fromCol + 1] || 0) + colOff / EMU_PER_PX,
      top: (rowOffsetPx[fromRow + 1] || 0) + rowOff / EMU_PER_PX,
      width: cx / EMU_PER_PX,
      height: cy / EMU_PER_PX
    };
  }

  const images = [];
  const textShapes = [];

  for (const anchorEl of Array.from(doc.getElementsByTagName("xdr:twoCellAnchor"))) {
    const pic = anchorEl.getElementsByTagName("xdr:pic")[0];
    if (!pic) continue;
    const blip = pic.getElementsByTagName("a:blip")[0];
    const rEmbed = blip?.getAttribute("r:embed");
    const target = rEmbed && relTargets.get(rEmbed);
    if (!target) continue;
    const mediaPath = `xl/${target.replace(/^\.\.\//, "")}`;
    const bytes = await readZipEntryBytes(zip, mediaPath);
    if (!bytes) continue;
    images.push({ ...anchorBoxFromTwoCell(anchorEl), dataUrl: bytesToDataUrl(bytes, guessMimeType(mediaPath)) });
  }

  for (const anchorEl of Array.from(doc.getElementsByTagName("xdr:oneCellAnchor"))) {
    const sp = anchorEl.getElementsByTagName("xdr:sp")[0];
    if (!sp) continue;
    const texts = Array.from(sp.getElementsByTagName("a:t")).map((t) => t.textContent).join("");
    if (!texts.trim()) continue;
    const szAttr = sp.getElementsByTagName("a:rPr")[0]?.getAttribute("sz");
    const fontSizePx = szAttr ? Math.round((Number(szAttr) / 100) * (96 / 72)) : 11;
    textShapes.push({ ...anchorBoxFromOneCell(anchorEl), text: texts, fontSizePx });
  }

  return { images, textShapes };
}

function cellStyleToCss(style) {
  const parts = [];
  if (style.font.bold) parts.push("font-weight:bold");
  if (style.font.italic) parts.push("font-style:italic");
  if (style.font.underline) parts.push("text-decoration:underline");
  parts.push(`font-size:${Math.round((style.font.sizePt || 11) * (96 / 72))}px`);
  parts.push(`font-family:'${(style.font.name || "sans-serif").replace(/'/g, "")}',sans-serif`);
  if (style.font.color) parts.push(`color:${style.font.color}`);
  if (style.fill) parts.push(`background-color:${style.fill}`);
  const align = style.alignment;
  if (align.horizontal) parts.push(`text-align:${align.horizontal === "center" ? "center" : align.horizontal === "right" ? "right" : "left"}`);
  parts.push(`vertical-align:${align.vertical === "center" ? "middle" : align.vertical === "top" ? "top" : "bottom"}`);
  // wrapText指定のセルは折り返して自セル内に収める。それ以外はExcelと同じく
  // クリップせず、隣接する空白セルへ視覚的にはみ出すことを許容する
  // （結合していないのに長いラベル文字列が1セルに収まっている、というこの
  // テンプレート特有の作り方（例:E2セルの「工事名：」欄）に対応するため）。
  if (align.wrapText) parts.push("white-space:pre-wrap;word-break:break-word;overflow:hidden");
  else parts.push("white-space:pre;overflow:visible");
  const b = style.border;
  if (b.top) parts.push(`border-top:${b.top}`);
  if (b.bottom) parts.push(`border-bottom:${b.bottom}`);
  if (b.left) parts.push(`border-left:${b.left}`);
  if (b.right) parts.push(`border-right:${b.right}`);
  return parts.join(";");
}

function buildTableHtml(layout, styles) {
  const covered = new Set(); // "r,c" 形式で、結合セルに覆われて描画をスキップする位置
  const spanAt = new Map(); // "r,c" -> {rowspan, colspan}（結合の左上セルのみ）
  layout.merges.forEach((m) => {
    spanAt.set(`${m.r1},${m.c1}`, { rowspan: m.r2 - m.r1 + 1, colspan: m.c2 - m.c1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) {
        if (r === m.r1 && c === m.c1) continue;
        covered.add(`${r},${c}`);
      }
    }
  });

  const colWidths = layout.colWidthPx.slice(1, layout.maxCol + 1);
  const totalWidthPx = colWidths.reduce((a, b) => a + b, 0);
  const colGroup = colWidths.map((w) => `<col style="width:${w}px">`).join("");

  const rowsHtml = [];
  for (let r = 1; r <= layout.maxRow; r++) {
    const cellsHtml = [];
    for (let c = 1; c <= layout.maxCol; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;
      const colLetter = colIndexToLetters(c);
      const ref = `${colLetter}${r}`;
      const cellData = layout.cells.get(ref);
      const style = styles.resolveStyle(cellData?.styleIndex || 0);
      const span = spanAt.get(key);
      const spanAttrs = span ? ` rowspan="${span.rowspan}" colspan="${span.colspan}"` : "";
      const text = escapeHtml(cellData?.text || "").replace(/\n/g, "<br>");
      // styles.xmlの色・フォント名は外部提供の.xlsxテンプレート由来のためHTML属性値として無害化する
      cellsHtml.push(`<td${spanAttrs} style="${escapeHtml(cellStyleToCss(style))}">${text}</td>`);
    }
    rowsHtml.push(`<tr style="height:${layout.rowHeightPx[r]}px">${cellsHtml.join("")}</tr>`);
  }

  return `<table class="xlsx-sheet" style="width:${totalWidthPx}px"><colgroup>${colGroup}</colgroup><tbody>${rowsHtml.join("")}</tbody></table>`;
}

function colIndexToLetters(n) {
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

async function render(model, mapping, companyProfile, template) {
  const cfg = mapping || ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING;
  if (!template?.sourceFileBlob) {
    throw new Error("このテンプレートには元になる.xlsxファイルが登録されていません。テンプレート管理画面からファイルを登録してください。");
  }

  const zip = loadZip(await template.sourceFileBlob.arrayBuffer());
  const workbookXml = await readZipEntryText(zip, "xl/workbook.xml");
  const workbookRelsXml = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
  const sheetPath = resolveSheetPartPath(workbookXml, workbookRelsXml, cfg.sheetName);

  let sheetXml = await readZipEntryText(zip, sheetPath);
  const plan = buildXlsxCellPlan(model, cfg);
  plan.cellWrites.forEach(({ cell, value, numeric }) => {
    sheetXml = setCellInSheetXml(sheetXml, cell, value, { numeric });
  });

  const stylesXml = await readZipEntryText(zip, "xl/styles.xml");
  const sharedStringsXml = await readZipEntryText(zip, "xl/sharedStrings.xml");
  const styles = parseXlsxStyles(stylesXml);
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const layout = readSheetLayout(sheetXml, sharedStrings);

  const colOffsetPx = buildOffsets(layout.colWidthPx);
  const rowOffsetPx = buildOffsets(layout.rowHeightPx);

  const { images: templateImages, textShapes } = await collectTemplateShapes(zip, sheetPath, colOffsetPx, rowOffsetPx);

  // 職長サイン画像は、Excel出力(excelXlsxTemplate.js)と同じくplan.imagesのセル位置に貼る
  const signatureImages = await Promise.all(
    plan.images.map(async ({ cell, blob }) => {
      const col = colLettersToIndex(cell.match(/^[A-Z]+/)[0]);
      const row = Number(cell.match(/\d+$/)[0]);
      return {
        left: colOffsetPx[col] || 0,
        top: rowOffsetPx[row] || 0,
        width: layout.colWidthPx[col] || 0,
        height: layout.rowHeightPx[row] || 0,
        dataUrl: await blobToDataUrl(blob)
      };
    })
  );

  const tableHtml = buildTableHtml(layout, styles);

  const [paperW, paperH] = PAPER_SIZE_MM[layout.pageSetup.paperSize] || [297, 420];
  const isLandscape = layout.pageSetup.orientation === "landscape";
  const pageSizeMm = isLandscape ? [Math.max(paperW, paperH), Math.min(paperW, paperH)] : [Math.min(paperW, paperH), Math.max(paperW, paperH)];
  const marginTopMm = layout.pageMarginsIn.top * 25.4;
  const marginBottomMm = layout.pageMarginsIn.bottom * 25.4;
  const marginLeftMm = layout.pageMarginsIn.left * 25.4;
  const marginRightMm = layout.pageMarginsIn.right * 25.4;

  const imagesHtml = [...templateImages, ...signatureImages]
    .map((img) => `<img class="xlsx-overlay-img" style="left:${img.left}px;top:${img.top}px;width:${img.width}px;height:${img.height}px" src="${img.dataUrl}" alt="">`)
    .join("");
  const textShapesHtml = textShapes
    .map((s) => `<div class="xlsx-overlay-text" style="left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;font-size:${s.fontSizePx}px">${escapeHtml(s.text)}</div>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(model.site.name || "工事日報")}（会社指定様式）</title>
<style>
  @page { size: ${pageSizeMm[0]}mm ${pageSizeMm[1]}mm; margin: ${marginTopMm}mm ${marginRightMm}mm ${marginBottomMm}mm ${marginLeftMm}mm; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .xlsx-sheet-wrap { position: relative; }
  table.xlsx-sheet { border-collapse: collapse; table-layout: fixed; }
  table.xlsx-sheet td { padding: 1px 2px; }
  .xlsx-overlay-img { position: absolute; object-fit: contain; }
  .xlsx-overlay-text { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; }
</style>
</head>
<body>
  <div class="xlsx-sheet-wrap">
    ${tableHtml}
    ${imagesHtml}
    ${textShapesHtml}
  </div>
</body>
</html>`;

  const filename = `${model.site.name || "現場"}_${model.report.date || "日付未定"}_日報（会社指定様式）.html`;
  return { html, filename, warnings: plan.warnings };
}

registerPdfRenderer("xlsx-template-print-html", render);
