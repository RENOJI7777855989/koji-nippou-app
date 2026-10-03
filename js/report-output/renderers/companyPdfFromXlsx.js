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
import { applyDiagonalBorders } from "../xlsxDiagonal.js";
import { parseXlsxStyles, parseSharedStrings, readSheetLayout, colLettersToIndex } from "../xlsxSheetReader.js";
import { escapeHtml } from "../../utils.js";
import { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING } from "./mappings/anzenEiseiUchiawaseNisshi.js";
import { getLayoutProfile } from "../layoutProfiles.js";
import "../layouts/index.js";

const EMU_PER_PX = 9525;
export const PAPER_SIZE_MM = {
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

/**
 * 列/行の累積オフセット(px)配列を作る。offsets[i]＝i番目（1始まり）の列/行の開始位置。
 * sizesPxのインデックス0は未使用（readSheetLayoutの配列は1始まり）なので、
 * 先頭に足し込まない（足し込むと図形・職長サインが列幅・行高ぶん右下にずれる）。
 */
export function buildOffsets(sizesPx) {
  const offsets = [0, 0];
  for (let i = 2; i < sizesPx.length; i++) offsets.push(offsets[i - 1] + (sizesPx[i - 1] || 0));
  // 最終の列/行の終端（範囲末尾を指すアンカーのto用）
  offsets.push(offsets[sizesPx.length - 1] + (sizesPx[sizesPx.length - 1] || 0));
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
export async function collectTemplateShapes(zip, sheetPath, colOffsetPx, rowOffsetPx) {
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
    // 元画像の一部だけを表示する設定（<a:srcRect l t r b>、1/1000%単位）。無視すると画像全体が枠に押し込まれて別物に見える
    const srcRect = pic.getElementsByTagName("a:srcRect")[0];
    const crop = srcRect
      ? { l: Number(srcRect.getAttribute("l")) || 0, t: Number(srcRect.getAttribute("t")) || 0, r: Number(srcRect.getAttribute("r")) || 0, b: Number(srcRect.getAttribute("b")) || 0 }
      : null;
    images.push({ ...anchorBoxFromTwoCell(anchorEl), dataUrl: bytesToDataUrl(bytes, guessMimeType(mediaPath)), crop });
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

/** 図形の重ね描きHTML。切り抜き指定（crop）があれば、元画像の該当部分だけを枠いっぱいに表示する */
export function overlayImageHtml(img) {
  const box = `left:${img.left}px;top:${img.top}px;width:${img.width}px;height:${img.height}px`;
  const c = img.crop;
  if (c && (c.l || c.t || c.r || c.b)) {
    const visW = 100000 - c.l - c.r;
    const visH = 100000 - c.t - c.b;
    if (visW > 0 && visH > 0) {
      const w = (img.width * 100000) / visW;
      const h = (img.height * 100000) / visH;
      const left = -(w * c.l) / 100000;
      const top = -(h * c.t) / 100000;
      return `<div class="xlsx-overlay-crop" style="${box}"><img src="${img.dataUrl}" alt="" style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;max-width:none"></div>`;
    }
  }
  return `<img class="xlsx-overlay-img" style="${box}" src="${img.dataUrl}" alt="">`;
}

export function cellStyleToCss(style) {
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
  // 斜線（Excelの罫線の diagonal）。セルの角から角へ細い線を引く。背景の印刷を切っていても出るよう、このセルだけ印刷時も色を残す
  const diag = [];
  if (b.diagonalDown) diag.push("linear-gradient(to top right, transparent calc(50% - 0.6px), #000 calc(50% - 0.6px), #000 calc(50% + 0.6px), transparent calc(50% + 0.6px))");
  if (b.diagonalUp) diag.push("linear-gradient(to bottom right, transparent calc(50% - 0.6px), #000 calc(50% - 0.6px), #000 calc(50% + 0.6px), transparent calc(50% + 0.6px))");
  if (diag.length) parts.push(`background-image:${diag.join(",")};-webkit-print-color-adjust:exact;print-color-adjust:exact`);
  return parts.join(";");
}

/**
 * 表のHTML。PDF（印刷）でExcelの見た目を保つため、各セルの中身を「Excelの行の高さ・列の幅の箱」（div.xc）に入れる。
 *  ・行の高さを固定する: 表の行（tr）の高さは「最低の高さ」でしかなく、文字の高さや長い文章で伸びてしまい、
 *    Excelの行の高さで位置を計算して重ねる職長サイン・様式の図がずれて重なっていた。箱の高さを固定して防ぐ。
 *  ・折り返し指定の無いセル: Excelと同じく、右隣の空いたセル（data-spill の幅）までは1行ではみ出して表示する。
 *    それでも収まらない長い文字は、隣の欄に重ねず、そのセルの中で折り返す（下のPDF_CELL_FIT_SCRIPT）。
 *  ・折り返し指定のセル・折り返したセルは、箱に収まるまで文字を小さくする（省略しない。最小5px）。
 *  ・真下のセルが空で、間に罫線が無い（見た目は1つの欄）場合は、その高さも箱に含める（例: 03-2の協力会社欄は
 *    1社ごとに1行空けており、作業内容の欄は罫線の無い2行分に見える）。罫線をまたいで他の欄に重ねることはしない。
 *  ・箱はセルの上に重ねて置く（position:absolute）ので、中身が多くても表の行は伸びない。
 * 様式のセル・結合・罫線・列幅・行の高さは変えない（表示のしかただけ）。
 */
function buildTableHtml(layout, styles) {
  const covered = new Set(); // "r,c" 形式で、結合セルに覆われて描画をスキップする位置
  const spanAt = new Map(); // "r,c" -> {rowspan, colspan}（結合の左上セルのみ）
  const mergeAnchorOf = new Map(); // "r,c" -> 結合の左上セルの "r,c"（結合に含まれる全セル）
  layout.merges.forEach((m) => {
    spanAt.set(`${m.r1},${m.c1}`, { rowspan: m.r2 - m.r1 + 1, colspan: m.c2 - m.c1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) mergeAnchorOf.set(`${r},${c}`, [m.r1, m.c1]);
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) {
        if (r === m.r1 && c === m.c1) continue;
        covered.add(`${r},${c}`);
      }
    }
  });

  const colWidths = layout.colWidthPx.slice(1, layout.maxCol + 1);
  const hasText = (r, c) => !!String(layout.cells.get(`${colIndexToLetters(c)}${r}`)?.text || "").length;
  const styleAt = (r, c) => styles.resolveStyle(layout.cells.get(`${colIndexToLetters(c)}${r}`)?.styleIndex || 0);
  // 真下の空いたセルへ、罫線で区切られていない範囲だけ箱を下に伸ばせる高さ（列 c1〜c2 のすべてで空いていること）
  const extendDown = (rBelow, c1, c2) => {
    let h = 0;
    for (let k = rBelow; k <= layout.maxRow; k++) {
      let ok = true;
      for (let cc = c1; cc <= c2; cc++) {
        const key = `${k},${cc}`;
        if (covered.has(key) || spanAt.has(key) || hasText(k, cc) || styleAt(k - 1, cc).border.bottom || styleAt(k, cc).border.top) { ok = false; break; }
      }
      if (!ok) break;
      h += layout.rowHeightPx[k] || 0;
    }
    return h;
  };
  // 折り返さないセルが、隣の空いたセルへはみ出せる幅（Excelと同じく、左寄せは右へ・右寄せは左へ・中央は左右へ。
  // 文字のあるセル・文字のある結合セルで止まる。中が空欄の結合セル（例: 03-2の印鑑欄）へは、従来の表示どおりはみ出してよい）
  const freeWidth = (r, from, step) => {
    let w = 0;
    for (let k = from; k >= 1 && k <= layout.maxCol; k += step) {
      const anchor = mergeAnchorOf.get(`${r},${k}`);
      if (anchor ? hasText(anchor[0], anchor[1]) : hasText(r, k)) break;
      w += layout.colWidthPx[k] || 0;
    }
    return w;
  };
  const spillWidth = (r, cFirst, cLast, ownWidth, horizontal) => {
    if (horizontal === "right") return ownWidth + freeWidth(r, cFirst - 1, -1);
    if (horizontal === "center") return ownWidth + 2 * Math.min(freeWidth(r, cFirst - 1, -1), freeWidth(r, cLast + 1, 1));
    return ownWidth + freeWidth(r, cLast + 1, 1);
  };
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
      const rows = span?.rowspan || 1;
      const cols = span?.colspan || 1;
      let boxH = 0;
      for (let k = r; k < r + rows; k++) boxH += layout.rowHeightPx[k] || 0;
      if (text) boxH += extendDown(r + rows, c, c + cols - 1);
      let boxW = 0;
      for (let k = c; k < c + cols; k++) boxW += layout.colWidthPx[k] || 0;
      // 縦書き（textRotation=255）のセルは縦書きで表示し、箱に収まるよう縮める（横書きだと細い枠からはみ出していた）
      const vertical = style.alignment.textRotation === 255;
      const wrap = !!style.alignment.wrapText || vertical;
      const spill = !wrap && text ? spillWidth(r, c, c + cols - 1, boxW, style.alignment.horizontal) : boxW;
      const valign = vertical || style.alignment.vertical === "center" ? "center" : style.alignment.vertical === "top" ? "flex-start" : "flex-end";
      // 文字の幅を測れるよう、中身は伸ばさず文字の幅にする（左右の寄せはここで指定）
      const halign = vertical ? "center" : style.alignment.horizontal === "center" ? "center" : style.alignment.horizontal === "right" ? "flex-end" : "flex-start";
      const inner = text
        ? `<div class="xc${vertical ? " xc-vert" : ""}" data-w="${Math.round(boxW)}" data-spill="${Math.round(spill)}" data-wrap="${wrap ? 1 : 0}" style="width:${Math.max(1, Math.round(boxW) - 4)}px;height:${Math.max(0, boxH - 1)}px;justify-content:${valign};align-items:${halign}"><span>${text}</span></div>`
        : "";
      // styles.xmlの色・フォント名は外部提供の.xlsxテンプレート由来のためHTML属性値として無害化する
      cellsHtml.push(`<td${spanAttrs} style="${escapeHtml(cellStyleToCss(style))}">${inner}</td>`);
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

/**
 * セルの箱に文字を収める（印刷用HTMLの中で表示時・印刷前に実行。何度実行しても同じ結果）。
 *  ・折り返さないセル: 1行ではみ出せる幅（data-spill）に収まればそのまま。収まらなければそのセルの中で折り返す
 *  ・折り返したセル: 箱（高さ・幅）に収まるまで文字を小さくする（最小5px）。それでも収まらないセルの数を
 *    window.__xlsxCellsClipped に残す（検証用）
 * まとめて印刷（複数の日報を1文書に結合）でも各シートに効くよう、文書全体の .xc を対象にする。
 */
export const PDF_CELL_FIT_SCRIPT = `(function(){
  var MIN=5;
  function fitCell(c){
    var sp=c.firstElementChild; if(!sp) return true;
    c.classList.remove("xc-fit"); c.style.fontSize="";
    var own=+c.getAttribute("data-w"), spill=+c.getAttribute("data-spill"), wrap=c.getAttribute("data-wrap")==="1";
    if(!wrap && sp.offsetWidth<=spill+0.5 && sp.offsetHeight<=c.clientHeight+1) return true;
    c.classList.add("xc-fit");
    var size=parseFloat(getComputedStyle(c).fontSize)||14;
    function over(){return c.scrollHeight>c.clientHeight||c.scrollWidth>c.clientWidth;}
    while(over()&&size>MIN){size-=0.5;c.style.fontSize=size+"px";}
    return !over();
  }
  // 全体の縮小（下の fitScript）は、この後に計算し直す。縮小したまま測ると幅・高さを誤るので一度戻す
  function fitAll(){var ws=document.querySelectorAll(".xlsx-sheet-wrap");for(var j=0;j<ws.length;j++)ws[j].style.zoom="1";var n=0,cs=document.querySelectorAll("table.xlsx-sheet .xc[data-w]");for(var i=0;i<cs.length;i++){if(!fitCell(cs[i]))n++;}window.__xlsxCellsClipped=n;}
  fitAll();window.addEventListener("load",fitAll);window.addEventListener("beforeprint",fitAll);
})();`;

async function render(model, mapping, companyProfile, template) {
  const cfg = mapping || getLayoutProfile(template?.layoutId)?.dailyMapping || ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING;
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

  let stylesXml = await readZipEntryText(zip, "xl/styles.xml");
  // 巡回点検の欄の斜線（Excel出力と同じ処理。休工日・作業なし・事務作業日で点検記録が無い日）
  if (plan.diagonalCells?.length) ({ sheetXml, stylesXml } = applyDiagonalBorders({ sheetXml, stylesXml, cells: plan.diagonalCells }));
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

  // 会社様式が「1ページに収める」印刷設定（mappingのfitToPage、Excel出力にも同じ設定を適用）の場合、
  // 印刷用HTMLも用紙の印刷可能領域に収まる倍率で縮小する。縮小しないと、A3横でも下部が2ページ目にはみ出す。
  // HTMLの表は、セルの余白・文字の高さ分だけExcelの行高より大きく描画されるため、倍率は「実際に描画された
  // 表の大きさ」から表示時・印刷時に計算する（下のscript）。
  const mmToPx = (mm) => (mm / 25.4) * 96;
  const fitToPage = !!plan.fitToPage;
  const availWpx = mmToPx(pageSizeMm[0] - marginLeftMm - marginRightMm);
  const availHpx = mmToPx(pageSizeMm[1] - marginTopMm - marginBottomMm);
  const fitScript = fitToPage
    ? `<script>(function(){var AW=${availWpx.toFixed(1)},AH=${availHpx.toFixed(1)};function fit(){var ws=document.querySelectorAll(".xlsx-sheet-wrap");for(var i=0;i<ws.length;i++){var w=ws[i];var t=w.querySelector("table.xlsx-sheet");if(!t)continue;w.style.zoom="1";var r=t.getBoundingClientRect();if(!r.width||!r.height)continue;w.style.zoom=String(Math.min(1,AW/r.width*0.99,AH/r.height*0.99));}}fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();</script>`
    : "";

  const imagesHtml = [...templateImages, ...signatureImages].map(overlayImageHtml).join("");
  const cellFitScript = `<script>${PDF_CELL_FIT_SCRIPT}</script>`;
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
  table.xlsx-sheet td { padding: 0 2px; position: relative; }
  /* セルの中身の箱: Excelの行の高さに固定し、セルの上に重ねて置く（行が伸びて重ね描きの図・サインがずれるのを防ぐ） */
  table.xlsx-sheet td .xc { position: absolute; left: 2px; top: 0; display: flex; flex-direction: column; overflow: visible; line-height: 1.15; }
  table.xlsx-sheet td .xc.xc-fit { overflow: hidden; white-space: pre-wrap; word-break: break-all; align-items: stretch; }
  /* 縦書きのセル（様式の textRotation=255）: 文字を縦に並べ、箱の中央に置く */
  table.xlsx-sheet td .xc.xc-vert > span { writing-mode: vertical-rl; text-orientation: upright; letter-spacing: 0.05em; }
  table.xlsx-sheet td .xc.xc-vert, table.xlsx-sheet td .xc.xc-vert.xc-fit { align-items: center; justify-content: center; }
  .xlsx-overlay-img { position: absolute; object-fit: contain; }
  .xlsx-overlay-crop { position: absolute; overflow: hidden; }
  .xlsx-overlay-text { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; }
</style>
</head>
<body>
  <div class="xlsx-sheet-wrap">
    ${tableHtml}
    ${imagesHtml}
    ${textShapesHtml}
  </div>
  ${cellFitScript}
  ${fitScript}
</body>
</html>`;

  const filename = `${model.site.name || "現場"}_${model.report.date || "日付未定"}_日報（会社指定様式）.html`;
  return { html, filename, warnings: plan.warnings };
}

registerPdfRenderer("xlsx-template-print-html", render);
