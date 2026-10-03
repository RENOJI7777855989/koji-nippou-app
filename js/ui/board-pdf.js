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
   ========================================================== */

import { buildJpegPdf } from "../report-output/imagePdf.js";
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
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-30000px;top:0;width:1700px;height:1300px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("現場掲示の表示に時間がかかりすぎました。")), 15000);
      frame.onload = () => { clearTimeout(t); resolve(); };
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument;
    try { await doc.fonts?.ready; } catch { /* フォントの読み込み待ちに未対応でも続ける */ }
    await wait(150); // 読み込み時の文字の自動縮小（fit）が終わるのを待つ
    const sheet = doc.querySelector(".sheet");
    if (!sheet) throw new Error("現場掲示の紙面が見つかりません。");
    const rect = sheet.getBoundingClientRect();
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    const css = escXml([...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n"));
    const body = getComputedStyle(doc.body);
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
  } finally {
    frame.remove();
  }
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
 */
export async function openBoardPdfDialog({ html, siteName, date }) {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  previewEl.hidden = true;
  previewEl.removeAttribute("src");
  setReady(null);
  shareBtn.hidden = false;
  statusEl.textContent = "PDFを作成しています…（数秒かかります）";
  if (!dialog.open) dialog.showModal();
  try {
    const { file, jpeg } = await buildBoardPdfFile(html, { siteName, date });
    // 見本: PDFに入れた画像そのものを小さく表示する
    previewUrl = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    previewEl.src = previewUrl;
    previewEl.hidden = false;
    statusEl.textContent = `作成しました: ${file.name}（A3横・1ページ、${Math.max(1, Math.round(file.size / 1024))}KB）`;
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
