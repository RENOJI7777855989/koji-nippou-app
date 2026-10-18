/* ==========================================================
   会社指定様式（03-2 等）の日報を、A3横・1日報1ページのPDFにする（2026-10-18）
   iPad の Safari では、印刷画面（ブラウザの印刷）で様式の用紙・余白の指定どおりに収まらず、表の下の部分が
   2ページ目に出ることがあった（プリンターの印刷できない余白が加わるため。様式の右余白は 0mm）。そこで、
   印刷用HTML（companyPdfFromXlsx.js の buildCompanyPdfFromXlsx。印刷画面と同じもの）の紙面を画像にし、
   様式の用紙（@page の size）の1ページに、余白（@page の margin）の内側に収めて置いたPDFを作る。
   画像はページからはみ出さないので、日報1件＝必ず1ページになる（プリンターでも「用紙に合わせて」縮小される）。
     ① 印刷用HTMLを画面の外の枠（iframe）に表示する（セルの文字の自動縮小もここで済む）
     ② 紙面（.xlsx-sheet-wrap。まとめて印刷では日報ごとに1つ）を等倍にして、SVG（foreignObject）でキャンバスへ描き、JPEGにする
        職長サイン・様式の図（画像）は、SVG の中では描かれない環境があるため、外してから、同じ位置・同じ置き方で
        キャンバスへ別に描く（object-fit: contain・切り抜き（srcRect）も同じ計算）
     ③ JPEG をページごとに1枚ずつ置いたPDFにする（report-output/imagePdf.js）
   PDFの文字は画像なので、選択・検索はできない。データ・様式・Excel出力・印刷画面の印刷は変えない。
   ========================================================== */

import { buildJpegPdfPages } from "../report-output/imagePdf.js";
import { printFileName } from "../printSupport.js";

const RENDER_SCALES = [2.5, 2, 1.5]; // キャンバスを作れない端末では小さくしてやり直す
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 印刷用HTMLの @page から、用紙（mm）と余白（mm）を読む。無ければ A3 横・余白 0 */
export function pageSetupFromHtml(html) {
  const m = /@page\s*\{\s*size:\s*([\d.]+)mm\s+([\d.]+)mm;\s*margin:\s*([\d.]+)mm\s+([\d.]+)mm\s+([\d.]+)mm\s+([\d.]+)mm/.exec(html || "");
  if (!m) return { pageWidthMm: 420, pageHeightMm: 297, margins: { top: 0, right: 0, bottom: 0, left: 0 } };
  return { pageWidthMm: +m[1], pageHeightMm: +m[2], margins: { top: +m[3], right: +m[4], bottom: +m[5], left: +m[6] } };
}

/** 画像の要素1つを、キャンバスに描く位置（紙面の左上を原点、CSS の画素）と、元画像の切り出し範囲 */
function imageDrawPlan(img, origin) {
  const crop = img.parentElement?.classList.contains("xlsx-overlay-crop") ? img.parentElement : null;
  const box = (crop || img).getBoundingClientRect();
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh || !box.width || !box.height) return null;
  if (crop) {
    // 切り抜き: 中の img（拡大して負の位置に置いたもの）のうち、枠の中だけを描く
    const ir = img.getBoundingClientRect();
    const sx = ((box.left - ir.left) / ir.width) * nw, sy = ((box.top - ir.top) / ir.height) * nh;
    const sw = (box.width / ir.width) * nw, sh = (box.height / ir.height) * nh;
    return { sx, sy, sw, sh, dx: box.left - origin.left, dy: box.top - origin.top, dw: box.width, dh: box.height };
  }
  // object-fit: contain（縦横比を保って枠の中央に）
  const s = Math.min(box.width / nw, box.height / nh);
  const dw = nw * s, dh = nh * s;
  return { sx: 0, sy: 0, sw: nw, sh: nh, dx: box.left - origin.left + (box.width - dw) / 2, dy: box.top - origin.top + (box.height - dh) / 2, dw, dh };
}

/**
 * 印刷用HTMLの紙面（.xlsx-sheet-wrap ごと）をJPEG画像にする
 * @returns {Promise<{jpeg: Uint8Array, pxWidth: number, pxHeight: number}[]>}
 */
export async function renderCompanySheetsToJpegs(html) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-40000px;top:0;width:2600px;height:2000px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("印刷用の紙面の表示に時間がかかりすぎました。")), 20000);
      frame.onload = () => { clearTimeout(t); resolve(); };
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument;
    try { await doc.fonts?.ready; } catch { /* フォントの読み込み待ちに未対応でも続ける */ }
    await wait(200); // 読み込み時のセルの文字の自動縮小が終わるのを待つ
    const wraps = [...doc.querySelectorAll(".xlsx-sheet-wrap")];
    if (!wraps.length) throw new Error("会社指定様式の紙面が見つかりません。");
    // 画像の読み込み（職長サイン・様式の図）を待つ
    await Promise.all([...doc.images].map((im) => (im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
    const css = escXml([...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n"));
    const body = getComputedStyle(doc.body);
    const out = [];
    for (const wrap of wraps) {
      wrap.style.zoom = "1"; // 等倍で描く（用紙への縮小は PDF の側で行う）
      const table = wrap.querySelector("table.xlsx-sheet");
      const origin = (table || wrap).getBoundingClientRect();
      const W = Math.ceil(origin.width), H = Math.ceil(origin.height);
      if (!W || !H) throw new Error("紙面の大きさを測れませんでした。");
      // 画像は別に描くので、SVG に入れる複製からは外す
      const plans = [...wrap.querySelectorAll("img")].map((im) => ({ im, plan: imageDrawPlan(im, origin) })).filter((x) => x.plan);
      const clone = wrap.cloneNode(true);
      clone.style.zoom = "1";
      clone.querySelectorAll("img").forEach((im) => im.remove());
      const xml = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;margin:0;background:#fff;color:${body.color};font-family:${escXml(body.fontFamily).replace(/"/g, "'")};position:relative;overflow:hidden">`
        + `<style>${css}</style>${xml}</div></foreignObject></svg>`;
      const svgImg = new Image();
      svgImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await svgImg.decode();
      await wait(30);
      let done = null;
      for (const scale of RENDER_SCALES) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(W * scale);
        canvas.height = Math.round(H * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
        for (const { im, plan: p } of plans) {
          try { ctx.drawImage(im, p.sx, p.sy, p.sw, p.sh, p.dx * scale, p.dy * scale, p.dw * scale, p.dh * scale); } catch { /* 描けない画像は飛ばす（文字の紙面は残す） */ }
        }
        const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
        if (blob && blob.size > 0) { done = { jpeg: new Uint8Array(await blob.arrayBuffer()), pxWidth: canvas.width, pxHeight: canvas.height }; break; }
      }
      if (!done) throw new Error("PDFの画像を作れませんでした（端末のメモリが足りない可能性があります）。");
      out.push(done);
    }
    return out;
  } finally {
    frame.remove();
  }
}

/** 会社指定様式の印刷用HTMLか（紙面 .xlsx-sheet-wrap がある） */
export const isCompanySheetHtml = (html) => /class="xlsx-sheet-wrap"/.test(html || "");

/**
 * 会社指定様式の印刷用HTMLから、1日報1ページのPDFファイルを作る（用紙・余白は様式の @page と同じ）
 * @returns {Promise<{file: File, pages: number}>}
 */
export async function buildCompanyOnePagePdf(html, baseName) {
  const pages = await renderCompanySheetsToJpegs(html);
  const setup = pageSetupFromHtml(html);
  const name = printFileName(baseName || "工事日報", "pdf");
  const pdf = buildJpegPdfPages(pages, { ...setup, align: "top-left", title: name.replace(/\.pdf$/, "") });
  return { file: new File([pdf], name, { type: "application/pdf" }), pages: pages.length };
}
