/* ==========================================================
   積算資料 × 業者見積 の比較エンジン（純粋関数）
   積算項目配列・業者見積項目配列・確定済み対応関係・許容差設定を
   受け取り、一致/数量差/単価差/金額差/見積漏れの可能性/積算漏れの
   可能性/重複の可能性/要確認 に分類した結果配列を返す。
   DOM・IndexedDBに依存しないため単体で検証しやすい。
   比較結果そのものは保存しない（呼び出しのたびに再計算する）。

   「漏れ」を断定しないという指示に合わせ、ラベル・注記は必ず
   「〜の可能性」「確認が必要」という表現に統一する。
   ========================================================== */

import { itemSimilarity, buildItemKey } from "./itemNormalize.js";

// 類似度スコアの解釈:
//   AUTO_MATCH_THRESHOLD 以上   → 自動的に対応ありとみなす
//   REVIEW_THRESHOLD 以上未満   → 「要確認」としてユーザーの判断を仰ぐ
//   REVIEW_THRESHOLD 未満       → 対応候補にしない
const AUTO_MATCH_THRESHOLD = 0.82;
const REVIEW_THRESHOLD = 0.55;
// 同一項目に対し、僅差の候補が複数ある場合は「重複の可能性」として
// 機械的な確定をしない（例: 同じ工種が複数行に分割されている等）
const DUPLICATE_SCORE_MARGIN = 0.05;

export const DEFAULT_TOLERANCE = {
  quantityTolerancePercent: 5,
  quantityAlertPercent: 10,
  priceTolerancePercent: 5,
  priceAlertPercent: 10,
  amountTolerancePercent: 5,
  amountAlertPercent: 10
};

function pairScore(estItem, vqItem) {
  const nameScore = itemSimilarity(estItem.itemName, vqItem.itemName);
  const hasSpec = (estItem.spec || "").trim() || (vqItem.spec || "").trim();
  if (!hasSpec) return nameScore;
  const specScore = itemSimilarity(estItem.spec, vqItem.spec);
  return nameScore * 0.7 + specScore * 0.3;
}

function diffPercent(estVal, vqVal) {
  if (estVal == null || vqVal == null) return null;
  const base = estVal !== 0 ? Math.abs(estVal) : Math.abs(vqVal);
  if (base === 0) return 0;
  return (Math.abs(estVal - vqVal) / base) * 100;
}

function classifySeverity(pct, tolerancePercent, alertPercent) {
  if (pct == null) return null;
  if (pct <= tolerancePercent) return null;
  return pct > alertPercent ? "alert" : "warn";
}

const FLAG_LABELS = { quantity: "数量差", unitPrice: "単価差", amount: "金額差" };

function buildMatchedResult(estItem, vqItem, tol, matchType) {
  const quantityDiffPct = diffPercent(estItem.quantity, vqItem.quantity);
  const unitPriceDiffPct = diffPercent(estItem.unitPrice, vqItem.unitPrice);
  const amountDiffPct = diffPercent(estItem.amount, vqItem.amount);

  const quantitySeverity = classifySeverity(quantityDiffPct, tol.quantityTolerancePercent, tol.quantityAlertPercent);
  const priceSeverity = classifySeverity(unitPriceDiffPct, tol.priceTolerancePercent, tol.priceAlertPercent);
  const amountSeverity = classifySeverity(amountDiffPct, tol.amountTolerancePercent, tol.amountAlertPercent);

  const flags = [];
  if (quantitySeverity) flags.push("quantity");
  if (priceSeverity) flags.push("unitPrice");
  if (amountSeverity) flags.push("amount");

  return {
    type: flags.length === 0 ? "match" : "diff",
    matchType, // "confirmed"（ユーザー確定）| "auto"（類似度による自動対応）
    estimateItem: estItem,
    vendorItem: vqItem,
    estimateItemKey: buildItemKey(estItem),
    vendorItemKey: buildItemKey(vqItem),
    quantityDiffPct,
    unitPriceDiffPct,
    amountDiffPct,
    quantitySeverity,
    priceSeverity,
    amountSeverity,
    flags,
    label: flags.length === 0 ? "一致" : flags.map((f) => FLAG_LABELS[f]).join("・")
  };
}

function buildNeedsReviewResult(estItem, vqItem, score) {
  return {
    type: "needs_review",
    matchType: null,
    estimateItem: estItem,
    vendorItem: vqItem,
    estimateItemKey: buildItemKey(estItem),
    vendorItemKey: buildItemKey(vqItem),
    similarityScore: score,
    label: "要確認",
    note: "積算と業者見積で項目名・仕様の表記が異なりますが、内容が近い可能性があります。同一項目かご確認ください。"
  };
}

function buildUnmatchedEstimateResult(estItem) {
  return {
    type: "estimate_only",
    estimateItem: estItem,
    vendorItem: null,
    estimateItemKey: buildItemKey(estItem),
    vendorItemKey: null,
    label: "見積漏れの可能性",
    note: "この積算項目に対応する業者見積の項目が見つかりませんでした。見積書への記載漏れ、または表記の違いによる可能性があります。確認が必要です。"
  };
}

function buildUnmatchedVendorResult(vqItem) {
  return {
    type: "vendor_only",
    estimateItem: null,
    vendorItem: vqItem,
    estimateItemKey: null,
    vendorItemKey: buildItemKey(vqItem),
    label: "積算漏れの可能性",
    note: "この業者見積項目に対応する積算項目が見つかりませんでした。積算への計上漏れ、または表記の違いによる可能性があります。確認が必要です。"
  };
}

function buildDuplicateResult(item, side, candidateCount) {
  return {
    type: "duplicate_possible",
    estimateItem: side === "estimate" ? item : null,
    vendorItem: side === "vendor" ? item : null,
    estimateItemKey: side === "estimate" ? buildItemKey(item) : null,
    vendorItemKey: side === "vendor" ? buildItemKey(item) : null,
    label: "重複の可能性",
    candidateCount,
    note: "類似度が近い対応候補が複数見つかりました。同一項目が重複して計上されている可能性、または表記の近い別項目の可能性があります。確認が必要です。"
  };
}

/**
 * @param {object[]} estimateItems 積算項目（現場の全件）。呼び出し側が
 *   itemMasterMatch.jsのresolveToMaster()で共通積算項目マスターへ解決
 *   済みの場合、各要素に`_masterItemCode`/`_masterMatchType`("exact"|"fuzzy")
 *   を付与しておくと、その解決結果を最優先で対応付けに使う（マスター未解決の
 *   項目や、呼び出し側がそもそも解決していない場合は何もしない＝既存動作と
 *   完全に同一になる）。
 * @param {object[]} vendorItems 比較対象の業者見積バッチの全件（同上）
 * @param {object[]} overrides itemMatchOverrides.js のレコード配列
 * @param {object} tolerance DEFAULT_TOLERANCEを上書きする許容差設定
 * @returns {object[]} 分類済みの比較結果配列
 */
export function compareEstimateToQuote({ estimateItems = [], vendorItems = [], overrides = [], tolerance = {} } = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };

  const overrideMap = new Map();
  for (const o of overrides) {
    if (!overrideMap.has(o.estimateItemKey)) overrideMap.set(o.estimateItemKey, new Map());
    overrideMap.get(o.estimateItemKey).set(o.vendorItemKey, o.decision);
  }

  const estList = estimateItems.map((item) => ({ item, key: buildItemKey(item), matched: false, excluded: false }));
  const vqList = vendorItems.map((item) => ({ item, key: buildItemKey(item), matched: false, excluded: false }));

  const results = [];

  // 1. 確定済み「同一項目」を最優先で対応付ける
  for (const est of estList) {
    const vendorDecisions = overrideMap.get(est.key);
    if (!vendorDecisions) continue;
    for (const vq of vqList) {
      if (vq.matched) continue;
      if (vendorDecisions.get(vq.key) === "same") {
        results.push(buildMatchedResult(est.item, vq.item, tol, "confirmed"));
        est.matched = true;
        vq.matched = true;
        break;
      }
    }
  }

  // 1.5. 共通積算項目マスターに同じ項目コードで解決された項目同士を、
  //      文字列類似度の再計算なしで最優先に対応付ける（マスターが空、
  //      または呼び出し側で解決していない場合はこのステップは何もしない）。
  //      両側とも完全一致解決なら自動対応、片方でも曖昧一致(fuzzy)なら
  //      要確認に留める。同じコードに複数件ある場合は重複の可能性があるため
  //      ここでは確定させず、後段の類似度ベース処理・重複判定に委ねる。
  const masterGroups = new Map();
  for (const est of estList) {
    if (est.matched || !est.item._masterItemCode) continue;
    const code = est.item._masterItemCode;
    if (!masterGroups.has(code)) masterGroups.set(code, { est: [], vq: [] });
    masterGroups.get(code).est.push(est);
  }
  for (const vq of vqList) {
    if (vq.matched || !vq.item._masterItemCode) continue;
    const code = vq.item._masterItemCode;
    if (!masterGroups.has(code)) masterGroups.set(code, { est: [], vq: [] });
    masterGroups.get(code).vq.push(vq);
  }
  for (const { est: estGroup, vq: vqGroup } of masterGroups.values()) {
    if (estGroup.length !== 1 || vqGroup.length !== 1) continue;
    const [est] = estGroup;
    const [vq] = vqGroup;
    const bothExact = est.item._masterMatchType === "exact" && vq.item._masterMatchType === "exact";
    if (bothExact) {
      results.push(buildMatchedResult(est.item, vq.item, tol, "auto"));
    } else {
      results.push(buildNeedsReviewResult(est.item, vq.item, 1));
    }
    est.matched = true;
    vq.matched = true;
  }

  // 2. 残った項目同士のペアスコアを計算（確定済み「別項目」は候補から除外）
  const remainingEst = estList.filter((e) => !e.matched);
  const remainingVq = vqList.filter((v) => !v.matched);
  const candidatesByEst = new Map();
  const candidatesByVq = new Map();

  for (const est of remainingEst) {
    const decisions = overrideMap.get(est.key);
    for (const vq of remainingVq) {
      if (decisions?.get(vq.key) === "different") continue;
      const score = pairScore(est.item, vq.item);
      if (score < REVIEW_THRESHOLD) continue;
      if (!candidatesByEst.has(est)) candidatesByEst.set(est, []);
      candidatesByEst.get(est).push({ vq, score });
      if (!candidatesByVq.has(vq)) candidatesByVq.set(vq, []);
      candidatesByVq.get(vq).push({ est, score });
    }
  }
  for (const list of candidatesByEst.values()) list.sort((a, b) => b.score - a.score);
  for (const list of candidatesByVq.values()) list.sort((a, b) => b.score - a.score);

  // 3. 「重複の可能性」の判定: 同程度のスコアの候補が複数ある項目は、
  //    機械的に1件へ確定させず、対応未確定のまま別枠で報告する
  for (const est of remainingEst) {
    const list = candidatesByEst.get(est);
    if (list && list.length >= 2 && list[0].score - list[1].score < DUPLICATE_SCORE_MARGIN) {
      est.excluded = true;
      results.push(buildDuplicateResult(est.item, "estimate", list.length));
    }
  }
  for (const vq of remainingVq) {
    const list = candidatesByVq.get(vq);
    if (list && list.length >= 2 && list[0].score - list[1].score < DUPLICATE_SCORE_MARGIN) {
      vq.excluded = true;
      results.push(buildDuplicateResult(vq.item, "vendor", list.length));
    }
  }

  // 4. 貪欲法で対応付け（スコアが高い順に、双方まだ未確定のペアを確定させる）
  const pairs = [];
  for (const [est, list] of candidatesByEst) {
    if (est.excluded) continue;
    for (const { vq, score } of list) {
      if (vq.excluded) continue;
      pairs.push({ est, vq, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  for (const { est, vq, score } of pairs) {
    if (est.matched || vq.matched) continue;
    if (score >= AUTO_MATCH_THRESHOLD) {
      results.push(buildMatchedResult(est.item, vq.item, tol, "auto"));
    } else {
      results.push(buildNeedsReviewResult(est.item, vq.item, score));
    }
    est.matched = true;
    vq.matched = true;
  }

  // 5. 最後まで対応が付かなかった項目（重複判定で除外された項目も含む）
  for (const est of estList) {
    if (!est.matched && !est.excluded) results.push(buildUnmatchedEstimateResult(est.item));
  }
  for (const vq of vqList) {
    if (!vq.matched && !vq.excluded) results.push(buildUnmatchedVendorResult(vq.item));
  }

  return results;
}

/** 比較画面のサマリー表示用（総額・差額・件数の集計） */
export function summarizeComparison({ estimateItems = [], vendorItems = [], results = [] }) {
  const estimateTotalAmount = estimateItems.reduce((sum, i) => sum + (i.amount || 0), 0);
  const vendorTotalAmount = vendorItems.reduce((sum, i) => sum + (i.amount || 0), 0);
  const diffAmount = vendorTotalAmount - estimateTotalAmount;
  const diffPercentValue = estimateTotalAmount !== 0 ? (diffAmount / estimateTotalAmount) * 100 : null;

  const counts = { match: 0, diff: 0, needs_review: 0, estimate_only: 0, vendor_only: 0, duplicate_possible: 0 };
  for (const r of results) counts[r.type] = (counts[r.type] || 0) + 1;

  return { estimateTotalAmount, vendorTotalAmount, diffAmount, diffPercent: diffPercentValue, counts };
}
