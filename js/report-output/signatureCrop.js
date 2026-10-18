/* ==========================================================
   職長サインの画像から、線のある範囲だけを切り出す（印刷用HTMLに貼るときだけ。保存されている署名は変えない）
   サインは日報画面の欄（横長。iPad 横で 1584×360 画素）全体を画像として保存しているため、書いていない余白も含む。
   03-2 のサインの欄（横:縦 ≈ 5:1 の小さな欄）にその画像全体を縦横比を保って収めると、余白の分だけ線が小さくなっていた
   （iPad 横で書いたサインが欄の幅の約3割・高さの約6割）。線のある範囲（＋少しの余白）を切り出してから欄に収める。
   縦横比は変えない（切り出すだけで、引き伸ばさない）。線が見つからない画像はそのまま使う。
   ========================================================== */

const INK_ALPHA = 24; // これより不透明な画素を線とみなす（透明な背景のサイン）
const PAD_RATIO = 0.08; // 線の範囲の外に足す余白（線の範囲の高さに対する割合）

/**
 * @param {Blob} blob 署名の画像（PNG）
 * @returns {Promise<{blob: Blob, cropped: boolean, box: {x: number, y: number, w: number, h: number}|null, size: [number, number]}>}
 */
export async function cropSignatureToInk(blob) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return { blob, cropped: false, box: null, size: [0, 0] }; }
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx || !W || !H) { bitmap.close?.(); return { blob, cropped: false, box: null, size: [W, H] }; }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // 線: ある程度不透明で、白でない画素（白い背景で保存された画像の背景は線にしない）
      if (d[i + 3] > INK_ALPHA && d[i] + d[i + 1] + d[i + 2] < 720) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { blob, cropped: false, box: null, size: [W, H] };
  const pad = Math.max(2, Math.round((y1 - y0 + 1) * PAD_RATIO));
  const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad);
  const w = Math.min(W, x1 + 1 + pad) - x, h = Math.min(H, y1 + 1 + pad) - y;
  if (w >= W && h >= H) return { blob, cropped: false, box: { x: 0, y: 0, w: W, h: H }, size: [W, H] };
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
  const cropped = await new Promise((r) => out.toBlob(r, "image/png"));
  if (!cropped) return { blob, cropped: false, box: null, size: [W, H] };
  return { blob: cropped, cropped: true, box: { x, y, w, h }, size: [W, H] };
}
