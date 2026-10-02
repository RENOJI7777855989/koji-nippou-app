/* ==========================================================
   台帳Excel → 印刷用HTML（ブラウザの印刷・PDF保存で使う）
   renderLedgerWorkbook() が作った台帳.xlsxそのものを読み、印刷範囲を
   1頁（様式の行数）ずつ切り出してHTMLの表にする。Excelと印刷の内容が
   食い違わないよう、日報データからではなく出力済みの台帳から作る。

   ・罫線・フォント・列幅・行高・結合は会社様式PDF（companyPdfFromXlsx.js）と
     同じ部品で再現する。書式はセル毎ではなくクラスにまとめ、1年分
     （365頁）でも文書が重くなりすぎないようにする
   ・日付は表示形式（例「作業日："yyyy"年"m"月"d"日"(aaa)」）どおりに整形する
   ・シートの「ゼロ値を表示しない」設定（showZeros="0"）に従い0は空欄にする
   ・様式の図形（測量機器の表・注記）は、台帳と同じ配置の様式シートの図形を
     各頁に重ねる（台帳シート側はグループ図形で、位置・内容は同じ）
   ========================================================== */

import { loadZip, readZipEntryText } from "../../zipUtil.js";
import { WorkbookPackage, parseDefinedNames, parseRelationships, resolvePartPath } from "./workbookPackage.js";
import { parseXlsxStyles, parseSharedStrings, readSheetLayout } from "../xlsxSheetReader.js";
import { resolveSheetPartPath } from "../xlsxTemplateEngine.js";
import { PAPER_SIZE_MM, buildOffsets, collectTemplateShapes, cellStyleToCss, overlayImageHtml } from "../renderers/companyPdfFromXlsx.js";
import { escapeHtml } from "../../utils.js";
import { indexToCol } from "./sheetCells.js";

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
const BUILTIN_DATE_FORMATS = { 14: "yyyy/m/d", 31: 'yyyy"年"m"月"d"日"', 57: 'yyyy"年"m"月"', 58: 'm"月"d"日"' };

/** styles.xmlから「スタイル番号→表示形式コード」を引けるようにする */
export function parseNumberFormats(stylesXml) {
  const custom = new Map(
    [...stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [
      Number(m[1]),
      m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'")
    ])
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || "";
  const ids = [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] || 0));
  return (styleIndex) => {
    const id = ids[styleIndex] ?? 0;
    return custom.get(id) ?? BUILTIN_DATE_FORMATS[id] ?? null;
  };
}

function isDateFormat(code) {
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[yd]|aaa|ge/i.test(bare);
}

/** 日付シリアル値を表示形式どおりに整形する（日付の書式要素だけに対応） */
export function formatExcelDate(serial, code) {
  const section = code.split(";")[0].replace(/\[[^\]]*\]/g, "");
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const wd = d.getUTCDay();
  let out = "";
  let i = 0;
  while (i < section.length) {
    const rest = section.slice(i);
    let m;
    if (rest[0] === '"') {
      const end = section.indexOf('"', i + 1);
      out += section.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? section.length : end + 1;
    } else if (rest[0] === "\\") {
      out += rest[1] ?? "";
      i += 2;
    } else if ((m = /^(yyyy|yy|mm|m|dd|d|aaaa|aaa)/i.exec(rest))) {
      const t = m[1].toLowerCase();
      out += {
        yyyy: String(y),
        yy: String(y).slice(-2),
        mm: String(mo).padStart(2, "0"),
        m: String(mo),
        dd: String(day).padStart(2, "0"),
        d: String(day),
        aaaa: `${WEEKDAYS_JA[wd]}曜日`,
        aaa: WEEKDAYS_JA[wd]
      }[t];
      i += m[1].length;
    } else if (rest[0] === "_" || rest[0] === "*") {
      i += 2;
    } else {
      out += rest[0];
      i += 1;
    }
  }
  return out;
}

/**
 * シートXMLから1頁分の行を切り出し、1行目から始まるシートXMLに作り直す。
 * 数値セルは表示形式に従った文字列（インライン文字列）に置き換える。
 */
function slicePageSheetXml(sheetXml, { firstRow, pageRows, lastCol, formatOf, hideZeros }) {
  const lastRow = firstRow + pageRows - 1;
  const rows = [];
  for (const m of sheetXml.matchAll(/<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(m[1]);
    if (r < firstRow || r > lastRow) continue;
    const newR = r - firstRow + 1;
    const cells = (m[3] || "").replace(/<c r="([A-Z]+)\d+"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, (whole, col, attrs, tail, body = "") => {
      const s = /\ss="(\d+)"/.exec(attrs)?.[1];
      const t = /\st="(\w+)"/.exec(attrs)?.[1];
      const sAttr = s != null ? ` s="${s}"` : "";
      if (tail === "/>") return `<c r="${col}${newR}"${sAttr}/>`;
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if ((t == null || t === "n") && v != null) {
        const num = Number(v);
        const code = s != null ? formatOf(Number(s)) : null;
        let text;
        if (hideZeros && num === 0) text = "";
        else if (code && isDateFormat(code)) text = formatExcelDate(num, code);
        else text = String(Math.round(num * 1e9) / 1e9);
        return `<c r="${col}${newR}"${sAttr} t="inlineStr"><is><t>${escapeHtml(text)}</t></is></c>`;
      }
      if (t === "str" && v != null) return `<c r="${col}${newR}"${sAttr} t="inlineStr"><is><t>${v}</t></is></c>`;
      return `<c r="${col}${newR}"${attrs.replace(/\sr="[^"]*"/, "")}>${body.replace(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/, "")}</c>`;
    });
    rows.push(`<row r="${newR}"${m[2]}>${cells}</row>`);
  }
  const merges = [...sheetXml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)]
    .filter((m) => Number(m[2]) >= firstRow && Number(m[4]) <= lastRow)
    .map((m) => `<mergeCell ref="${m[1]}${Number(m[2]) - firstRow + 1}:${m[3]}${Number(m[4]) - firstRow + 1}"/>`);
  const head = sheetXml.slice(0, sheetXml.indexOf("<sheetData")).replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${lastCol}${pageRows}"/>`);
  const tailStart = sheetXml.indexOf("</sheetData>") + "</sheetData>".length;
  const tail = sheetXml
    .slice(tailStart)
    .replace(/<mergeCells[\s\S]*?<\/mergeCells>/, "")
    .replace(/<\/worksheet>[\s\S]*$/, "");
  return `${head}<sheetData>${rows.join("")}</sheetData><mergeCells count="${merges.length}">${merges.join("")}</mergeCells>${tail.replace(/<(conditionalFormatting|dataValidations)[\s\S]*?<\/\1>/g, "")}</worksheet>`;
}

/**
 * 台帳シートの1頁目にある図形（グループ化された画像＋注記テキスト）を、頁内のpx座標で返す。
 * グループ内の子図形は、グループ内座標（chOff/chExt）から実際の枠（アンカー）へ拡縮して配置する。
 * 台帳シートには様式の図形が頁ごとに置かれているため、1頁目の分を全頁に重ねる。
 */
async function collectLedgerPageShapes(pkg, sheet, { pageRows, colOffsetPx, rowOffsetPx }) {
  const rel = parseRelationships(await pkg.getText(sheet.path.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels")).find((r) => r.type.endsWith("/drawing"));
  if (!rel) return { images: [], texts: [] };
  const drawingPath = resolvePartPath(sheet.path, rel.target);
  const doc = new DOMParser().parseFromString(await pkg.getText(drawingPath), "application/xml");
  const rels = parseRelationships(await pkg.getText(drawingPath.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels"));
  const num = (el, tag) => Number(el.getElementsByTagName(tag)[0]?.textContent) || 0;
  const point = (el) => ({
    left: (colOffsetPx[num(el, "xdr:col") + 1] || 0) + num(el, "xdr:colOff") / 9525,
    top: (rowOffsetPx[num(el, "xdr:row") + 1] || 0) + num(el, "xdr:rowOff") / 9525,
    row: num(el, "xdr:row")
  });
  const images = [];
  const texts = [];
  for (const anchor of Array.from(doc.getElementsByTagName("xdr:twoCellAnchor"))) {
    const from = point(anchor.getElementsByTagName("xdr:from")[0]);
    const to = point(anchor.getElementsByTagName("xdr:to")[0]);
    if (from.row >= pageRows) continue; // 1頁目の図形だけ
    const grp = Array.from(anchor.children).find((c) => c.tagName === "xdr:grpSp");
    if (!grp) continue;
    if (/foreman-signature/.test(new XMLSerializer().serializeToString(anchor))) continue;
    const xfrm = grp.getElementsByTagName("xdr:grpSpPr")[0]?.getElementsByTagName("a:xfrm")[0];
    const chOff = xfrm?.getElementsByTagName("a:chOff")[0];
    const chExt = xfrm?.getElementsByTagName("a:chExt")[0];
    if (!chOff || !chExt) continue;
    const cx0 = Number(chOff.getAttribute("x")), cy0 = Number(chOff.getAttribute("y"));
    const cw = Number(chExt.getAttribute("cx")) || 1, ch = Number(chExt.getAttribute("cy")) || 1;
    const gw = to.left - from.left, gh = to.top - from.top;
    const mapBox = (child) => {
      const x = child.getElementsByTagName("a:xfrm")[0];
      const off = x.getElementsByTagName("a:off")[0], ext = x.getElementsByTagName("a:ext")[0];
      return {
        left: from.left + ((Number(off.getAttribute("x")) - cx0) / cw) * gw,
        top: from.top + ((Number(off.getAttribute("y")) - cy0) / ch) * gh,
        width: (Number(ext.getAttribute("cx")) / cw) * gw,
        height: (Number(ext.getAttribute("cy")) / ch) * gh
      };
    };
    for (const pic of Array.from(grp.getElementsByTagName("xdr:pic"))) {
      const embed = pic.getElementsByTagName("a:blip")[0]?.getAttribute("r:embed");
      const target = rels.find((r) => r.id === embed)?.target;
      const bytes = target && (await pkg.getBytes(resolvePartPath(drawingPath, target)));
      if (!bytes) continue;
      const src = pic.getElementsByTagName("a:srcRect")[0];
      const crop = src ? { l: Number(src.getAttribute("l")) || 0, t: Number(src.getAttribute("t")) || 0, r: Number(src.getAttribute("r")) || 0, b: Number(src.getAttribute("b")) || 0 } : null;
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const mime = /\.png$/i.test(target) ? "image/png" : "image/jpeg";
      images.push({ ...mapBox(pic), crop, dataUrl: `data:${mime};base64,${btoa(bin)}` });
    }
    for (const sp of Array.from(grp.getElementsByTagName("xdr:sp"))) {
      const text = Array.from(sp.getElementsByTagName("a:t")).map((t) => t.textContent).join("");
      if (!text.trim()) continue;
      const sz = sp.getElementsByTagName("a:rPr")[0]?.getAttribute("sz");
      texts.push({ ...mapBox(sp), text, fontSizePx: sz ? Math.round((Number(sz) / 100) * (96 / 72)) : 11 });
    }
  }
  return { images, texts };
}

/**
 * 台帳シートの図形から職長サイン（名前がforeman-signatureの画像）を頁ごとに集める。
 * 位置は座標ではなく「頁内の列・行」で返す（HTMLの表は内容に合わせて行が伸びるため、
 * 絶対座標で重ねると位置がずれる。該当セルの中に画像を入れる）。
 */
async function collectSignaturesByPage(pkg, sheet, { pageRows, pageBase }) {
  const byPage = new Map();
  const rel = parseRelationships(await pkg.getText(sheet.path.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels")).find((r) => r.type.endsWith("/drawing"));
  if (!rel) return byPage;
  const drawingPath = resolvePartPath(sheet.path, rel.target);
  const drawingXml = await pkg.getText(drawingPath);
  const drawingRels = parseRelationships(await pkg.getText(drawingPath.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels"));
  for (const m of drawingXml.matchAll(/<xdr:twoCellAnchor\b[^>]*>([\s\S]*?)<\/xdr:twoCellAnchor>/g)) {
    if (!/<xdr:cNvPr\b[^>]*name="foreman-signature/.test(m[1])) continue;
    const from = /<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(m[1]);
    const embed = /r:embed="([^"]+)"/.exec(m[1])?.[1];
    const target = drawingRels.find((r) => r.id === embed)?.target;
    if (!from || !target) continue;
    const bytes = await pkg.getBytes(resolvePartPath(drawingPath, target));
    if (!bytes) continue;
    const col = Number(from[1]) + 1;
    const row0 = Number(from[2]);
    const rowInPage = (row0 % pageRows) + 1;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const page = pageBase + Math.floor(row0 / pageRows);
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ col, row: rowInPage, dataUrl: `data:image/png;base64,${btoa(bin)}` });
  }
  return byPage;
}

function buildPageTable(layout, classOf, inlineImages = []) {
  const inlineAt = new Map(inlineImages.map((i) => [`${i.row},${i.col}`, i]));
  const covered = new Set();
  const spanAt = new Map();
  for (const m of layout.merges) {
    spanAt.set(`${m.r1},${m.c1}`, { rowspan: m.r2 - m.r1 + 1, colspan: m.c2 - m.c1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r},${c}`);
  }
  const rows = [];
  for (let r = 1; r <= layout.maxRow; r++) {
    const tds = [];
    for (let c = 1; c <= layout.maxCol; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = layout.cells.get(`${indexToCol(c)}${r}`);
      const span = spanAt.get(`${r},${c}`);
      const spanAttrs = span ? ` rowspan="${span.rowspan}" colspan="${span.colspan}"` : "";
      const inline = inlineAt.get(`${r},${c}`);
      const inlineHtml = inline ? `<img src="${inline.dataUrl}" alt="" style="display:block;max-width:100%;max-height:${layout.rowHeightPx[r]}px;object-fit:contain">` : "";
      const text = escapeHtml(cell?.text || "").replace(/\n/g, "<br>");
      // 文字は span.tx に入れる（縦書きのセルは CSS で span を縦書きにする）
      tds.push(`<td class="${classOf(cell?.styleIndex || 0)}"${spanAttrs}>${text ? `<span class="tx">${text}</span>` : ""}${inlineHtml}</td>`);
    }
    rows.push(`<tr style="height:${layout.rowHeightPx[r]}px">${tds.join("")}</tr>`);
  }
  return rows.join("");
}

/**
 * @param {object} params
 * @param {Blob} params.ledgerBlob renderLedgerWorkbook() の出力
 * @param {ArrayBuffer} [params.templateBuffer] 原本テンプレート（様式シートの図形を重ねる場合）
 * @param {string} [params.formSheetName] 様式シート名（図形の取得元）
 * @param {number} params.pageRows 1頁の行数
 * @param {string} params.title 文書タイトル
 * @returns {Promise<{html: string, pageCount: number}>}
 */
export async function buildLedgerPrintHtml({ ledgerBlob, templateBuffer = null, formSheetName = null, pageRows, title }) {
  const pkg = await WorkbookPackage.open(await ledgerBlob.arrayBuffer());
  const sheets = await pkg.listSheets();
  const names = parseDefinedNames(await pkg.getText("xl/workbook.xml"));
  const stylesXml = await pkg.getText("xl/styles.xml");
  const styles = parseXlsxStyles(stylesXml);
  const formatOf = parseNumberFormats(stylesXml);
  const sharedStrings = parseSharedStrings(await pkg.getText("xl/sharedStrings.xml"));

  const classNames = new Map();
  const classOf = (styleIndex) => {
    if (!classNames.has(styleIndex)) classNames.set(styleIndex, `s${styleIndex}`);
    return classNames.get(styleIndex);
  };

  const pagesHtml = [];
  const sheetsWithPages = [];
  let pageLayout = null;
  for (const sheet of sheets) {
    const area = names.find((d) => d.name === "_xlnm.Print_Area" && d.localSheetId === sheet.index)?.formula || "";
    const m = /!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(area);
    if (!m) continue;
    const lastCol = m[3];
    const totalRows = Number(m[4]) - Number(m[2]) + 1;
    const sheetXml = await pkg.getText(sheet.path);
    sheetsWithPages.push({ sheet, pageBase: pagesHtml.length });
    const signatures = await collectSignaturesByPage(pkg, sheet, { pageRows, pageBase: 0 });
    const hideZeros = /<sheetView\b[^>]*\sshowZeros="0"/.test(sheetXml);
    for (let p = 0; p < Math.ceil(totalRows / pageRows); p++) {
      const pageXml = slicePageSheetXml(sheetXml, { firstRow: Number(m[2]) + p * pageRows, pageRows, lastCol, formatOf, hideZeros });
      const layout = readSheetLayout(pageXml, sharedStrings);
      pageLayout ||= layout;
      pagesHtml.push(buildPageTable(layout, classOf, signatures.get(p) || []));
    }
  }
  if (!pageLayout) throw new Error("台帳に印刷範囲のあるシートがありません。");

  // 様式の図形（各頁の同じ位置に重ねる）。台帳シート自身の図形を使い、無ければ様式シートの図形で代用する
  let overlayHtml = "";
  const textHtml = (s) => `<div class="xlsx-overlay-text" style="left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;font-size:${s.fontSizePx}px">${escapeHtml(s.text)}</div>`;
  const ledgerShapes = await collectLedgerPageShapes(pkg, sheetsWithPages[0].sheet, { pageRows, colOffsetPx: buildOffsets(pageLayout.colWidthPx), rowOffsetPx: buildOffsets(pageLayout.rowHeightPx) });
  if (ledgerShapes.images.length + ledgerShapes.texts.length > 0) {
    overlayHtml = ledgerShapes.images.map(overlayImageHtml).join("") + ledgerShapes.texts.map(textHtml).join("");
  } else if (templateBuffer && formSheetName) {
    const zip = loadZip(templateBuffer);
    const sheetPath = resolveSheetPartPath(await readZipEntryText(zip, "xl/workbook.xml"), await readZipEntryText(zip, "xl/_rels/workbook.xml.rels"), formSheetName);
    const { images, textShapes } = await collectTemplateShapes(zip, sheetPath, buildOffsets(pageLayout.colWidthPx), buildOffsets(pageLayout.rowHeightPx));
    overlayHtml =
      images.map(overlayImageHtml).join("") +
      textShapes.map((s) => `<div class="xlsx-overlay-text" style="left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;font-size:${s.fontSizePx}px">${escapeHtml(s.text)}</div>`).join("");
  }

  const colWidths = pageLayout.colWidthPx.slice(1, pageLayout.maxCol + 1);
  const totalWidthPx = colWidths.reduce((a, b) => a + b, 0);
  const colGroup = colWidths.map((w) => `<col style="width:${w}px">`).join("");
  const styleCss = [...classNames]
    .map(([idx, cls]) => {
      const st = styles.resolveStyle(idx);
      const base = `table.xlsx-sheet td.${cls}{${cellStyleToCss(st).replace(/[<>]/g, "")}}`;
      // 縦書き（textRotation=255）のセル（巡回点検の分類名など）は縦書きで表示する（横書きだと細い枠からはみ出す）
      return st.alignment?.textRotation === 255
        ? `${base}\ntable.xlsx-sheet td.${cls}{text-align:center;vertical-align:middle;white-space:normal}table.xlsx-sheet td.${cls}>.tx{writing-mode:vertical-rl;text-orientation:upright;display:inline-block;max-height:100%}`
        : base;
    })
    .join("\n");

  const [paperW, paperH] = PAPER_SIZE_MM[pageLayout.pageSetup.paperSize] || [297, 420];
  const landscape = pageLayout.pageSetup.orientation === "landscape";
  const pageSizeMm = landscape ? [Math.max(paperW, paperH), Math.min(paperW, paperH)] : [Math.min(paperW, paperH), Math.max(paperW, paperH)];
  const mg = pageLayout.pageMarginsIn;
  const mmToPx = (mm) => (mm / 25.4) * 96;
  const availW = mmToPx(pageSizeMm[0] - (mg.left + mg.right) * 25.4);
  const availH = mmToPx(pageSizeMm[1] - (mg.top + mg.bottom) * 25.4);
  // 1頁が用紙の印刷可能範囲に収まる倍率（描画された表の実寸から計算。会社様式PDFと同じ方式）
  const fitScript = `<script>(function(){var AW=${availW.toFixed(1)},AH=${availH.toFixed(1)};function fit(){var w=document.querySelector(".ledger-page");if(!w)return;var t=w.querySelector("table.xlsx-sheet");w.style.zoom="1";var r=t.getBoundingClientRect();if(!r.width||!r.height)return;var z=String(Math.min(1,AW/r.width*0.99,AH/r.height*0.99));var ws=document.querySelectorAll(".ledger-page");for(var i=0;i<ws.length;i++)ws[i].style.zoom=z;}fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();</script>`;

  const sections = pagesHtml
    .map(
      (rows, i) =>
        `<section class="ledger-page"${i < pagesHtml.length - 1 ? ' style="break-after:page;page-break-after:always"' : ""}><table class="xlsx-sheet" style="width:${totalWidthPx}px"><colgroup>${colGroup}</colgroup><tbody>${rows}</tbody></table>${overlayHtml}</section>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${pageSizeMm[0]}mm ${pageSizeMm[1]}mm; margin: ${mg.top * 25.4}mm ${mg.right * 25.4}mm ${mg.bottom * 25.4}mm ${mg.left * 25.4}mm; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .ledger-page { position: relative; }
  table.xlsx-sheet { border-collapse: collapse; table-layout: fixed; }
  table.xlsx-sheet td { padding: 1px 2px; }
  .xlsx-overlay-img { position: absolute; object-fit: contain; }
  .xlsx-overlay-crop { position: absolute; overflow: hidden; }
  .xlsx-overlay-text { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; }
${styleCss}
</style>
</head>
<body>
${sections}
${fitScript}
</body>
</html>`;
  return { html, pageCount: pagesHtml.length };
}
