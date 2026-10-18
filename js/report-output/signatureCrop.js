/* ==========================================================
   職長サインの画像から、線のある範囲だけを切り出し、線を太く・濃くする（印刷用HTMLに貼るときだけ。保存されている署名は変えない）
   サインは日報画面の欄（横長。iPad 横で 1584×360 画素）全体を画像として保存しているため、書いていない余白も含む。
   03-2 のサインの欄（横長の小さな欄）にその画像全体を縦横比を保って収めると、余白の分だけ線が小さくなっていた
   （iPad 横で書いたサインが欄の幅の約3割・高さの約6割）。線のある範囲（＋少しの余白）を切り出してから欄に収める。
   さらに、画面で書いた線（太さ約2画素）は、A3 の欄（幅 約2cm）に縮めると太さ約0.15mm の薄い線になり読みにくいため、
   線を周りへ広げて太くし（画像の大きさに合わせた半径。A3 の欄で 約0.4mm になる見込み）、黒で濃く描き直す（2026-10-18）。
   縦横比は変えない（切り出すだけで、引き伸ばさない）。線が見つからない画像・読めない画像はそのまま使う。
   ========================================================== */

const INK_ALPHA = 24; // これより不透明な画素を線とみなす（透明な背景のサイン）
const PAD_RATIO = 0.08; // 線の範囲の外に足す余白（線の範囲の高さに対する割合）
const THICKEN_DIVISOR = 150; // 線を広げる半径 = 線の範囲の大きさ（幅と、高さ×2.5 の大きい方）÷ この値（最小1画素）
const INK_BOOST = 1.3; // 線の濃さ（不透明度）を強める倍率

/**
 * @param {Blob} blob 署名の画像（PNG）
 * @param {{thicken?: boolean}} [opt] thicken: 線を太く・濃くする（既定 true）
 * @returns {Promise<{blob: Blob, cropped: boolean, box: {x: number, y: number, w: number, h: number}|null, size: [number, number], radius: number}>}
 *   box は元の画像の中で切り出した範囲（元の画像の画素）、radius は線を広げた半径（画素）
 */
export async function cropSignatureToInk(blob, { thicken = true } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return { blob, cropped: false, box: null, size: [0, 0], radius: 0 }; }
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx || !W || !H) { bitmap.close?.(); return { blob, cropped: false, box: null, size: [W, H], radius: 0 }; }
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
  if (x1 < 0) return { blob, cropped: false, box: null, size: [W, H], radius: 0 };
  const inkW = x1 - x0 + 1, inkH = y1 - y0 + 1;
  const radius = thicken ? Math.max(1, Math.round(Math.max(inkW, inkH * 2.5) / THICKEN_DIVISOR)) : 0;
  const pad = Math.max(2, Math.round(inkH * PAD_RATIO)) + radius;
  const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad);
  const w = Math.min(W, x1 + 1 + pad) - x, h = Math.min(H, y1 + 1 + pad) - y;
  if (!thicken && w >= W && h >= H) return { blob, cropped: false, box: { x: 0, y: 0, w: W, h: H }, size: [W, H], radius: 0 };
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  if (!thicken) {
    octx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  } else {
    // 線の濃さ（0〜1）: 不透明度 ×（1 − 明るさ）。透明な背景のサインも、白い背景のサインも、濃い線ほど大きい
    const src = ctx.getImageData(x, y, w, h).data;
    let ink = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const i = k * 4;
      ink[k] = (src[i + 3] / 255) * (1 - (src[i] + src[i + 1] + src[i + 2]) / 765);
    }
    // 線を周りへ広げる（横・縦の順に、半径 radius の範囲の最大値をとる）
    const dilate = (a, horizontal) => {
      const b = new Float32Array(w * h);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          let m = 0;
          for (let t = -radius; t <= radius; t++) {
            const sx = horizontal ? xx + t : xx, sy = horizontal ? yy : yy + t;
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
            const v = a[sy * w + sx];
            if (v > m) m = v;
          }
          b[yy * w + xx] = m;
        }
      }
      return b;
    };
    ink = dilate(dilate(ink, true), false);
    const img = octx.createImageData(w, h);
    for (let k = 0; k < w * h; k++) {
      img.data[k * 4 + 3] = Math.min(255, Math.round(ink[k] * 255 * INK_BOOST)); // 黒（RGB は 0 のまま）を濃さで描く
    }
    octx.putImageData(img, 0, 0);
  }
  const result = await new Promise((r) => out.toBlob(r, "image/png"));
  if (!result) return { blob, cropped: false, box: null, size: [W, H], radius: 0 };
  return { blob: result, cropped: w < W || h < H, box: { x, y, w, h }, size: [W, H], radius };
}
