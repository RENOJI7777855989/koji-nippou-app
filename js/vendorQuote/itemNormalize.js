/* ==========================================================
   項目名の正規化・類似度計算（完全オフライン・ネットワーク不要）
   積算資料と業者見積では同じ工事内容でも表記が異なることが多い
   （例:「コンクリート打設」≒「生コン打設」）。AIには頼らず、
   文字列正規化＋レーベンシュタイン距離ベースの類似度のみで
   ゆらぎを吸収する。
   ========================================================== */

// 比較のノイズになりやすい語尾。緩和用の比較にのみ使い、
// 保存データ自体（itemName）は書き換えない。
const RELAX_SUFFIXES = ["工事", "工", "費", "代", "一式", "施工", "作業"];

/** 全角英数字・記号を半角に統一し、空白を除去、小文字化する */
export function normalizeItemText(text) {
  let s = String(text ?? "").trim();
  if (!s) return "";
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[－]/g, "-").replace(/[／]/g, "/").replace(/[（]/g, "(").replace(/[）]/g, ")");
  s = s.replace(/[\s　]+/g, "");
  return s.toLowerCase();
}

/** 類似度計算専用: よくある語尾（工事／工等）を緩和したキーを返す */
function relaxedKey(text) {
  let s = normalizeItemText(text);
  for (const suf of RELAX_SUFFIXES) {
    if (s.length > suf.length && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 0〜1の類似度（1が完全一致）。よくある語尾の違いは緩和して比較する */
export function itemSimilarity(textA, textB) {
  const a = relaxedKey(textA);
  const b = relaxedKey(textB);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/**
 * itemMatchOverrides保存・照合用のキー。再取込でIDが変わっても
 * 同じ項目名・仕様であれば同じキーになるよう、正規化した文字列を使う。
 */
export function buildItemKey(item) {
  return `${normalizeItemText(item?.itemName)}|${normalizeItemText(item?.spec)}`;
}
