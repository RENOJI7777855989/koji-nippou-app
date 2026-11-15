/* ==========================================================
   現場掲示のPDF保存・共有（A3横・1ページ）
   「🖨 現場掲示をA3印刷」と同じ印刷用HTML（todaySheetHtml.js の buildTodaySheetHtml(現在の表示のモデル)）を
   そのまま使う。PDF専用のデータ・レイアウトは作らない。
     ① 印刷用HTMLを画面の外の枠（iframe）に表示する（A3の各欄の文字の自動縮小もここで済む）
     ② 紙面（.sheet）をSVG（foreignObject）にしてキャンバスへ描き、JPEG画像にする
     ③ 画像をA3横・余白8mm（@page と同じ）の1ページのPDFにする（report-output/imagePdf.js）
   PDFの文字は画像なので、選択・検索はできない（見る・送る・印刷する用途）。
   共有は Web Share API（iPadの共有メニュー → LINE・ファイルに保存・AirDrop・メール等）。共有できない環境は
   ファイルとして保存する。共有はボタンを押した直後に呼ぶ必要があるため、PDFを作ってから［共有］を押してもらう。
   2026-11-15: 同じ方式を「業者別稼働・請求人工一覧」（A4横・複数ページ。billing/dailyBillingSheet.js）にも使う。
     印刷用HTMLの紙面（.sheet）を1つずつ画像にして1ページずつ並べる（renderSheetsHtmlToJpegs・buildSheetsPdfFile）。
     現場掲示は従来どおり1つ目の紙面だけを A3横・余白8mm で作る（処理も結果も同じ）。
   ========================================================== */

import { buildJpegPdf, buildJpegPdfPages } from "../report-output/imagePdf.js";
import { printFileName } from "../printSupport.js";

const PDF_TYPE = "application/pdf";
const RENDER_SCALES = [2.5, 2, 1.5]; // キャンバスを作れない端末では小さくしてやり直す

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** ファイル名: 現場掲示_現場名_YYYY-MM-DD.pdf（使えない文字は _ に置き換える） */
export const boardPdfFileName = (siteName, date) => printFileName(`現場掲示_${siteName || "現場"}_${date || ""}`, "pdf");

/**
 * 印刷用HTML（A3現場掲示）からJPEG画像を作る
 * @returns {Promise<{jpeg: Uint8Array, width: number, height: number}>}
 */
export async function renderSheetHtmlToJpeg(html) {
  return (await renderSheetsHtmlToJpegs(html, { max: 1 }))[0];
}

/**
 * 印刷用HTMLの紙面（.sheet）を、1つずつJPEG画像にする（max を指定すれば最初の max 個だけ）
 * @returns {Promise<{jpeg: Uint8Array, width: number, height: number}[]>}
 */
export async function renderSheetsHtmlToJpegs(html, { max = Infinity } = {}) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-30000px;top:0;width:1700px;height:1300px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("PDFにする内容の表示に時間がかかりすぎました。")), 15000);
      frame.onload = () => { clearTimeout(t); resolve(); };
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument;
    try { await doc.fonts?.ready; } catch { /* フォントの読み込み待ちに未対応でも続ける */ }
    await wait(150); // 読み込み時の文字の自動縮小（fit）が終わるのを待つ
    const sheets = [...doc.querySelectorAll(".sheet")].slice(0, max);
    if (!sheets.length) throw new Error("PDFにする紙面が見つかりません。");
    const css = escXml([...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n"));
    const body = getComputedStyle(doc.body);
    const out = [];
    for (const sheet of sheets) out.push(await sheetToJpeg(sheet, css, body));
    return out;
  } finally {
    frame.remove();
  }
}

async function sheetToJpeg(sheet, css, body) {
    const rect = sheet.getBoundingClientRect();
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    const sheetXml = new XMLSerializer().serializeToString(sheet);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;margin:0;background:#fff;color:${body.color};font-family:${escXml(body.fontFamily).replace(/"/g, "'")}">`
      + `<style>${css}</style>${sheetXml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    await wait(50);
    for (const scale of RENDER_SCALES) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(W * scale);
      canvas.height = Math.round(H * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      if (blob && blob.size > 0) return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
    }
    throw new Error("PDFの画像を作れませんでした（端末のメモリが足りない可能性があります）。");
}

/**
 * 印刷用HTMLの紙面すべてを1ページずつ並べたPDFファイルを作る（業者別稼働・請求人工一覧など）
 * @param {{fileName: string, paper: {widthMm: number, heightMm: number, marginMm: number}}} opt
 * @returns {Promise<{file: File, jpeg: Uint8Array, pages: number}>} jpeg は1ページ目の画像（見本の表示用）
 */
export async function buildSheetsPdfFile(html, { fileName, paper }) {
  const imgs = await renderSheetsHtmlToJpegs(html);
  const m = paper.marginMm;
  const pdf = buildJpegPdfPages(imgs.map((x) => ({ jpeg: x.jpeg, pxWidth: x.width, pxHeight: x.height })), { pageWidthMm: paper.widthMm, pageHeightMm: paper.heightMm, margins: { top: m, right: m, bottom: m, left: m }, align: "center", title: fileName.replace(/\.pdf$/, "") });
  return { file: new File([pdf], fileName, { type: PDF_TYPE }), jpeg: imgs[0].jpeg, pages: imgs.length };
}

/**
 * 印刷用HTMLからA3横・1ページのPDFファイルを作る
 * @returns {Promise<{file: File, jpeg: Uint8Array}>} jpeg はPDFに入れた画像（見本の表示用）
 */
export async function buildBoardPdfFile(html, { siteName, date } = {}) {
  const { jpeg, width, height } = await renderSheetHtmlToJpeg(html);
  const name = boardPdfFileName(siteName, date);
  const pdf = buildJpegPdf(jpeg, { pxWidth: width, pxHeight: height, title: name.replace(/\.pdf$/, "") });
  return { file: new File([pdf], name, { type: PDF_TYPE }), jpeg };
}

/** PDFファイルを共有メニューへ渡せる環境か */
export function canSharePdf(file) {
  try {
    return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/* ---------- 画面（ダイアログ）---------- */
const dialog = document.getElementById("boardPdfDialog");
const statusEl = document.getElementById("boardPdfStatus");
const previewEl = document.getElementById("boardPdfPreview");
const shareBtn = document.getElementById("boardPdfShareBtn");
const saveBtn = document.getElementById("boardPdfSaveBtn");
const noteEl = document.getElementById("boardPdfNote");
const headingEl = document.getElementById("boardPdfHeading");
const sourceEl = document.getElementById("boardPdfSource");
const printBtn = document.getElementById("boardPdfPrintBtn");
// 現場掲示の表示（従来どおり）。ほかの帳票は openBoardPdfDialog の引数で置き換える
const BOARD_HEADING = headingEl?.textContent || "";
const BOARD_SOURCE = sourceEl?.textContent || "";
let currentPrint = null;
let currentFile = null;
let previewUrl = null;

function setReady(file) {
  currentFile = file;
  const sharable = !!file && canSharePdf(file);
  shareBtn.hidden = !sharable;
  shareBtn.disabled = !file;
  saveBtn.disabled = !file;
  saveBtn.classList.toggle("secondary-btn", sharable);
  noteEl.textContent = !file ? "" : sharable
    ? "［共有］でiPadの共有メニューが開きます。LINE・ファイルに保存・AirDrop・メールなどを選べます。"
    : "この端末・ブラウザはファイルの共有に対応していないため、［PDFを保存］で保存してから送ってください。";
}

/**
 * @param {{html: string, siteName: string, date: string}} p 印刷ボタンと同じ印刷用HTML
 *   ほかの帳票（2026-11-15）: fileName・paper（{label, widthMm, heightMm, marginMm}）を渡すと、紙面すべてを
 *   1ページずつのPDFにする。heading・source でダイアログの見出し・説明を、onPrint で［印刷］ボタンを出す。
 */
export async function openBoardPdfDialog({ html, siteName, date, fileName, paper, heading, source, onPrint }) {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (headingEl) headingEl.textContent = heading || BOARD_HEADING;
  if (sourceEl) sourceEl.textContent = source || BOARD_SOURCE;
  currentPrint = onPrint || null;
  if (printBtn) printBtn.hidden = !onPrint;
  previewEl.hidden = true;
  previewEl.removeAttribute("src");
  setReady(null);
  shareBtn.hidden = false;
  statusEl.textContent = "PDFを作成しています…（数秒かかります）";
  if (!dialog.open) dialog.showModal();
  try {
    const made = paper && fileName
      ? await buildSheetsPdfFile(html, { fileName, paper })
      : { ...(await buildBoardPdfFile(html, { siteName, date })), pages: 1 };
    const { file, jpeg } = made;
    // 見本: PDFに入れた画像そのものを小さく表示する
    previewUrl = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    previewEl.src = previewUrl;
    previewEl.hidden = false;
    statusEl.textContent = `作成しました: ${file.name}（${paper?.label || "A3横"}・${made.pages}ページ、${Math.max(1, Math.round(file.size / 1024))}KB）${made.pages > 1 ? "。見本は1ページ目です" : ""}`;
    setReady(file);
  } catch (err) {
    statusEl.textContent = `PDFを作成できませんでした: ${err.message}`;
    setReady(null);
    shareBtn.hidden = true;
  }
}

shareBtn?.addEventListener("click", async () => {
  if (!currentFile) return;
  try {
    // ボタンを押した直後に呼ぶ（間に待ちを挟むと共有が許可されない）
    await navigator.share({ files: [currentFile], title: currentFile.name.replace(/\.pdf$/, "") });
    statusEl.textContent = `共有しました: ${currentFile.name}`;
  } catch (err) {
    if (err?.name === "AbortError") return; // 利用者が共有メニューを閉じた
    statusEl.textContent = `共有できませんでした（${err?.name || "エラー"}）。［PDFを保存］で保存してから送ってください。`;
  }
});

saveBtn?.addEventListener("click", () => {
  if (!currentFile) return;
  const url = URL.createObjectURL(currentFile);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  statusEl.textContent = `保存しました: ${currentFile.name}`;
});

document.getElementById("boardPdfCloseBtn")?.addEventListener("click", () => dialog.close());
// ［印刷］: このダイアログを閉じて、同じ印刷用HTMLを既存の印刷ダイアログで開く（ほかの帳票だけ。現場掲示は「🖨 現場掲示をA3印刷」）
printBtn?.addEventListener("click", () => {
  const go = currentPrint;
  if (!go) return;
  dialog.close();
  go();
});
