/* ==========================================================
   JPEG画像1枚を1ページに置いたPDFを作る（外部ライブラリなし。DOM非依存）
   現場掲示のPDF（js/ui/board-pdf.js）で使う。画像は用紙の余白の内側に、縦横比を保って中央に置く。
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
 *   既定の用紙は A3 横（420mm × 297mm）、余白 8mm（現場掲示の @page と同じ）
 * @returns {Uint8Array} PDF のバイト列
 */
export function buildJpegPdf(jpeg, { pxWidth, pxHeight, pageWidthMm = 420, pageHeightMm = 297, marginMm = 8, title = "" } = {}) {
  const pw = +(pageWidthMm * MM).toFixed(2);
  const ph = +(pageHeightMm * MM).toFixed(2);
  const m = marginMm * MM;
  const scale = Math.min((pw - 2 * m) / pxWidth, (ph - 2 * m) / pxHeight);
  const w = +(pxWidth * scale).toFixed(2);
  const h = +(pxHeight * scale).toFixed(2);
  const x = +((pw - w) / 2).toFixed(2);
  const y = +((ph - h) / 2).toFixed(2);
  const content = `q\n${w} 0 0 ${h} ${x} ${y} cm\n/Im0 Do\nQ\n`;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const b = typeof data === "string" ? enc.encode(data) : data; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of body) push(b); push("\nendobj\n"); };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 2進データを含む印
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  obj(5, [`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`]);
  obj(6, [`<< /Title ${pdfTextHex(title)} /Producer (koji-nippou-app) >>`]);
  const xref = length;
  push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}
