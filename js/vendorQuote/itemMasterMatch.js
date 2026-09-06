/* ==========================================================
   積算項目・業者見積項目を共通積算項目マスターへ解決する（純粋関数）
   完全一致（正規化した別名・標準項目名との一致）を最優先し、
   無ければ類似度スコアで候補を提示する（要確認扱い、自動確定しない）。
   itemNormalize.jsの正規化・類似度ロジックをそのまま使い、
   マスター専用の新しい判定ロジックは作らない。
   ========================================================== */

import { normalizeItemText, itemSimilarity } from "./itemNormalize.js";

// マスター候補として提示する最低スコア。項目同士の直接比較(compareEstimateToQuote.js
// のREVIEW_THRESHOLD=0.55)より高めに設定し、マスター辞書が誤った別名で
// 汚れることを避ける（低い確信度の候補は「候補なし」として人間の判断に委ねる）。
const MASTER_SUGGEST_THRESHOLD = 0.75;

/**
 * @param {{itemName: string}} item 積算項目 or 業者見積項目
 * @param {object[]} masterItems listMasterItems()の戻り値
 * @returns {{ masterItem: object|null, matchType: "exact"|"fuzzy"|"none", score: number|null }}
 */
export function resolveToMaster(item, masterItems) {
  const normalizedName = normalizeItemText(item?.itemName);
  if (!normalizedName || !masterItems || masterItems.length === 0) {
    return { masterItem: null, matchType: "none", score: null };
  }

  for (const masterItem of masterItems) {
    const candidates = [masterItem.standardName, ...(masterItem.aliases || [])];
    if (candidates.some((c) => normalizeItemText(c) === normalizedName)) {
      return { masterItem, matchType: "exact", score: 1 };
    }
  }

  let best = null;
  for (const masterItem of masterItems) {
    const candidates = [masterItem.standardName, ...(masterItem.aliases || [])];
    for (const candidate of candidates) {
      const score = itemSimilarity(item.itemName, candidate);
      if (!best || score > best.score) best = { masterItem, score };
    }
  }

  if (best && best.score >= MASTER_SUGGEST_THRESHOLD) {
    return { masterItem: best.masterItem, matchType: "fuzzy", score: best.score };
  }
  return { masterItem: null, matchType: "none", score: null };
}
