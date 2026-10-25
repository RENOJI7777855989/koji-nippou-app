/* ==========================================================
   所長欄の電子印（2026-10-24）
   日報の任意の項目 directorSeal = { name, offsetX, offsetY, stampedAt } に保存する（null＝押印なし。DBの構造・版は変えない）。
   印影の画像は保存しない。表示・印刷のたびに、名前から赤い丸印を描く（実際の印影の画像は登録されていないため）。
   職長サイン（signatures ストア・業者の行ごと）とは別のもので、まったく関係しない。
   位置: offsetX・offsetY は −100〜100。所長欄の中で、印が欄からはみ出さずに動ける幅に対する割合（0＝中央）。
   ========================================================== */

export const SEAL_COLOR = "#d7000f";
export const SEAL_OFFSET_LIMIT = 100;
export const SEAL_OFFSET_STEP = 25;
/** 印の直径（所長欄の短い辺に対する割合）。罫線・見出しの文字に重ならないよう少し小さくする */
export const SEAL_SIZE_RATIO = 0.78;
const MAX_NAME_LENGTH = 4;

const clampOffset = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-SEAL_OFFSET_LIMIT, Math.min(SEAL_OFFSET_LIMIT, n));
};

/** 印の名前（前後の空白・途中の空白を除き、最大4文字） */
export function normalizeSealName(name) {
  return [...String(name ?? "").replace(/\s+/g, "")].slice(0, MAX_NAME_LENGTH).join("");
}

/** 保存する形にそろえる。名前が無ければ null（押印なし） */
export function normalizeDirectorSeal(v) {
  if (!v || typeof v !== "object") return null;
  const name = normalizeSealName(v.name);
  if (!name) return null;
  return { name, offsetX: clampOffset(v.offsetX), offsetY: clampOffset(v.offsetY), stampedAt: typeof v.stampedAt === "string" && v.stampedAt ? v.stampedAt : new Date().toISOString() };
}

/**
 * 所長欄（box: 画素）の中の印の位置と大きさ。欄の短い辺×SEAL_SIZE_RATIO の円を、中央から offset の割合だけ動かす（欄の外へは出ない）
 * @returns {{left: number, top: number, size: number}}
 */
export function sealPlacement(box, seal) {
  const size = Math.max(1, Math.min(box.width, box.height) * SEAL_SIZE_RATIO);
  const freeX = Math.max(0, (box.width - size) / 2), freeY = Math.max(0, (box.height - size) / 2);
  return {
    left: box.left + freeX + (freeX * clampOffset(seal?.offsetX)) / SEAL_OFFSET_LIMIT,
    top: box.top + freeY + (freeY * clampOffset(seal?.offsetY)) / SEAL_OFFSET_LIMIT,
    size
  };
}

/** 赤い丸印をキャンバスに描く（名前は縦書き。1文字は中央、2文字以上は上から下へ） */
export function drawSealCanvas(name, sizePx = 240) {
  const chars = [...normalizeSealName(name)];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = sizePx;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const c = sizePx / 2;
  const ring = Math.max(2, sizePx * 0.055);
  ctx.strokeStyle = SEAL_COLOR;
  ctx.fillStyle = SEAL_COLOR;
  ctx.lineWidth = ring;
  ctx.beginPath();
  ctx.arc(c, c, c - ring / 2 - 1, 0, Math.PI * 2);
  ctx.stroke();
  if (chars.length) {
    const inner = sizePx - ring * 2 - sizePx * 0.12; // 文字を置ける高さ
    const n = chars.length;
    const fontPx = Math.min(inner / n, sizePx * (n === 1 ? 0.56 : 0.42));
    ctx.font = `bold ${fontPx}px "Hiragino Mincho ProN","Hiragino Mincho Pro","Yu Mincho","YuMincho","MS Mincho",serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = fontPx * (n === 1 ? 1 : 1.02);
    const top = c - (lineH * (n - 1)) / 2;
    chars.forEach((ch, i) => ctx.fillText(ch, c, top + lineH * i));
  }
  return canvas;
}

/** 印の画像（PNG の data URL）。印刷用HTML・画面の見本に使う */
export function sealPngDataUrl(name, sizePx = 240) {
  return drawSealCanvas(name, sizePx).toDataURL("image/png");
}

/** 様式のシートから所長欄（「所長」の見出しの真下の欄）を探す。見つからなければ null */
export function findDirectorSealCell(layout) {
  for (const [ref, cell] of layout.cells) {
    if (String(cell?.text || "").replace(/[\s　]/g, "") !== "所長") continue;
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    const row = Number(m[2]);
    const merge = layout.merges.find((g) => row >= g.r1 && row <= g.r2 && g.c1 <= colIndexOf(m[1]) && colIndexOf(m[1]) <= g.c2);
    return { col: merge ? merge.c1 : colIndexOf(m[1]), row: (merge ? merge.r2 : row) + 1 };
  }
  return null;
}

function colIndexOf(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
