/* ==========================================================
   JPEG画像1枚を1ページに置いたPDFを作る（外部ライブラリなし。DOM非依存）
   現場掲示のPDF（js/ui/board-pdf.js）と、会社指定様式の1ページのPDF（js/ui/company-pdf.js）で使う。
   画像は用紙の余白の内側に、縦横比を保って置く（はみ出さないので、必ず1枚の画像＝1ページになる）。
   ========================================================== */

const MM = 72 / 25.4; // 1mm = 2.8346pt

/** PDFの文字列（UTF-16BE の16進）。日本語の題名用 */
function pdfTextHex(text) {
  let hex = "FEFF";
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

/**
 * @param {Uint8Array} jpeg JPEG のバイト列
 * @param {{pxWidth: number, pxHeight: number, pageWidthMm?: number, pageHeightMm?: number, marginMm?: number, title?: string}} opt
 *   既定の用紙は A3 横（420mm × 297mm）、余白 8mm（現場掲示の @page と同じ）。画像は余白の内側の中央に置く
 * @returns {Uint8Array} PDF のバイト列
 */
export function buildJpegPdf(jpeg, { pxWidth, pxHeight, pageWidthMm = 420, pageHeightMm = 297, marginMm = 8, title = "" } = {}) {
  return buildJpegPdfPages([{ jpeg, pxWidth, pxHeight }], { pageWidthMm, pageHeightMm, margins: { top: marginMm, right: marginMm, bottom: marginMm, left: marginMm }, align: "center", title });
}

/**
 * JPEG画像を1ページに1枚ずつ置いたPDF（複数ページ）。どのページも同じ用紙・余白
 * （会社指定様式の印刷: 用紙・余白は様式の @page と同じ。画像は余白の内側に、縦横比を保って収める）。
 * @param {{jpeg: Uint8Array, pxWidth: number, pxHeight: number}[]} pages
 * @param {{pageWidthMm?: number, pageHeightMm?: number, margins?: {top: number, right: number, bottom: number, left: number}, align?: "center"|"top-left", title?: string}} opt
 *   align: "center"＝余白の内側の中央／"top-left"＝余白の内側の左上（ブラウザの印刷と同じ置き方）
 * @returns {Uint8Array} PDF のバイト列
 */
export function buildJpegPdfPages(pages, { pageWidthMm = 420, pageHeightMm = 297, margins = { top: 8, right: 8, bottom: 8, left: 8 }, align = "center", title = "" } = {}) {
  if (!pages.length) throw new Error("PDFにするページがありません");
  const pw = +(pageWidthMm * MM).toFixed(2);
  const ph = +(pageHeightMm * MM).toFixed(2);
  const mt = (margins.top || 0) * MM, mr = (margins.right || 0) * MM, mb = (margins.bottom || 0) * MM, ml = (margins.left || 0) * MM;
  const availW = pw - ml - mr;
  const availH = ph - mt - mb;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const b = typeof data === "string" ? enc.encode(data) : data; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of body) push(b); push("\nendobj\n"); };

  // オブジェクト番号: 1 カタログ・2 ページの一覧・3 情報・ページごとに 3つ（ページ・画像・描画内容）
  const pageObj = (i) => 4 + i * 3;
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 2進データを含む印
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  obj(3, [`<< /Title ${pdfTextHex(title)} /Producer (koji-nippou-app) >>`]);
  pages.forEach(({ jpeg, pxWidth, pxHeight }, i) => {
    const scale = Math.min(availW / pxWidth, availH / pxHeight);
    const w = +(pxWidth * scale).toFixed(2);
    const h = +(pxHeight * scale).toFixed(2);
    const x = +(align === "top-left" ? ml : ml + (availW - w) / 2).toFixed(2);
    const y = +(align === "top-left" ? ph - mt - h : mb + (availH - h) / 2).toFixed(2); // PDF の座標は下から
    const content = `q\n${w} 0 0 ${h} ${x} ${y} cm\n/Im0 Do\nQ\n`;
    const n = pageObj(i);
    obj(n, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`]);
    obj(n + 1, [`<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
    obj(n + 2, [`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`]);
  });
  const count = 4 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1, count).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}
