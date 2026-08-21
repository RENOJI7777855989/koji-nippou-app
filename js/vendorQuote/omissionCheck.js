/* ==========================================================
   見積落とし候補の抽出・リスク判定エンジン（純粋関数、DOM非依存）
   compareEstimateToQuote()の比較結果を土台に、「本来必要な工事・
   材料・労務・経費が業者見積から抜け落ちていないか」という観点で
   優先度（リスク）付けし直す。compareEstimateToQuote.js自体は
   変更しない（既存の分類ロジックは温存し、この上に判断レイヤーを
   足すだけ）。

   リスク判定はあくまでヒューリスティックによる「気づきの補助」で
   あり、自動で「見積落とし」と断定したり「一式に含まれるのでOK」
   と確定させたりはしない。確定はユーザーがomissionDispositionsに
   保存した場合のみ。
   ========================================================== */

import { buildItemKey } from "./itemNormalize.js";

const LUMP_SUM_MARK = "一式";
const LUMP_SUM_UNIT = "式";

// 積算側の項目名・工種にこれらの語を含む場合、他の経費項目にまとめて
// 計上されやすい（＝見つからなくても即「見積落とし」とは言えない）
const BUNDLE_PRONE_KEYWORDS = ["養生", "安全", "現場管理", "諸経費", "交通誘導", "雑費"];
// 業者見積側でこれらの語を含む項目があれば、上記の受け皿になっている可能性がある
const BUNDLE_RECEIVER_KEYWORDS = ["現場管理費", "諸経費", "共通仮設費", "一般管理費", "安全対策費", "仮設共通費"];

function includesAny(text, keywords) {
  const t = text || "";
  return keywords.some((kw) => t.includes(kw));
}

/** 積算項目と同じ工種内で、「一式」計上と思われる業者見積項目を探す（確定済み1:1ペアの項目は除外） */
function findLumpSumCandidate(estimateItem, vendorItems, excludedVendorKeys) {
  return vendorItems.find((v) => {
    if (excludedVendorKeys.has(buildItemKey(v))) return false;
    if ((v.category || "") !== (estimateItem.category || "")) return false;
    return (v.itemName || "").includes(LUMP_SUM_MARK) || (v.spec || "").includes(LUMP_SUM_MARK) || (v.unit || "") === LUMP_SUM_UNIT;
  });
}

function findBundleReceiver(vendorItems, excludedVendorKeys) {
  return vendorItems.find((v) => {
    if (excludedVendorKeys.has(buildItemKey(v))) return false;
    return includesAny(v.itemName, BUNDLE_RECEIVER_KEYWORDS) || includesAny(v.category, BUNDLE_RECEIVER_KEYWORDS);
  });
}

function fmtYen(n) {
  return n == null ? "" : `${n.toLocaleString("ja-JP")}円`;
}

const RISK_LABEL = { high: "見積落としの可能性：高", medium: "見積落としの可能性：中", low: "見積落としの可能性：低", needs_review: "要確認" };
const ESTIMATE_DISPOSITION_LABEL = {
  omission_confirmed: "見積落とし",
  included_in_other_item: "別項目に含む",
  included_in_lump_sum: "一式に含む",
  not_applicable: "対象外",
  ok: "問題なし",
  needs_review: "要確認（保留中）"
};
const VENDOR_DISPOSITION_LABEL = {
  additional_work: "追加工事",
  separate_contract: "別途工事",
  out_of_scope: "積算対象外",
  possible_duplicate: "二重計上の可能性",
  ok: "問題なし",
  needs_review: "要確認（保留中）"
};
// 見積落とし候補側で「解消済み」とみなすdisposition（omission_confirmedは
// 確定した高リスクとして候補に残し続ける、needs_reviewは「保留」を明示的に
// 記録するだけで未解決のまま＝どちらも解消扱いにはしない）
const RESOLVING_ESTIMATE_DISPOSITIONS = new Set(["included_in_other_item", "included_in_lump_sum", "not_applicable", "ok"]);
// 逆方向チェック側で「解消済み」とみなすdisposition（needs_reviewは保留中のまま候補に残す）
const RESOLVING_VENDOR_DISPOSITIONS = new Set(["additional_work", "separate_contract", "out_of_scope", "possible_duplicate", "ok"]);

function computeEstimateRisk(result, item, vendorItems, excludedVendorKeys) {
  if (result.type === "needs_review" || result.type === "duplicate_possible") {
    return {
      risk: "needs_review", riskLabel: RISK_LABEL.needs_review,
      reason: result.note, lumpSumCandidate: null, ambiguousVendorItem: result.vendorItem || null
    };
  }

  const lumpSumCandidate = findLumpSumCandidate(item, vendorItems, excludedVendorKeys);
  if (lumpSumCandidate) {
    return {
      risk: "medium", riskLabel: RISK_LABEL.medium,
      reason: `業者見積の同じ工種「${item.category || "（工種未設定）"}」内に「${lumpSumCandidate.itemName}」（${fmtYen(lumpSumCandidate.amount)}）という一式計上があり、この中に含まれている可能性があります。`,
      lumpSumCandidate
    };
  }

  if (includesAny(item.itemName, BUNDLE_PRONE_KEYWORDS) || includesAny(item.category, BUNDLE_PRONE_KEYWORDS)) {
    const receiver = findBundleReceiver(vendorItems, excludedVendorKeys);
    if (receiver) {
      return {
        risk: "low", riskLabel: RISK_LABEL.low,
        reason: `業者見積の「${receiver.itemName}」（${fmtYen(receiver.amount)}）等、他の経費項目に含まれている可能性があります。`,
        lumpSumCandidate: null, bundleReceiver: receiver
      };
    }
  }

  return { risk: "high", riskLabel: RISK_LABEL.high, reason: "業者見積内に対応する項目が確認できません。", lumpSumCandidate: null };
}

function buildEstimateCandidate(result, vendorItems, excludedVendorKeys, disposition) {
  const item = result.estimateItem;
  const key = buildItemKey(item);

  if (disposition && RESOLVING_ESTIMATE_DISPOSITIONS.has(disposition.disposition)) {
    return { resolved: true, item, itemKey: key, disposition: disposition.disposition, dispositionLabel: ESTIMATE_DISPOSITION_LABEL[disposition.disposition], linkedItemKey: disposition.linkedItemKey, note: disposition.note };
  }

  if (disposition && disposition.disposition === "omission_confirmed") {
    return {
      resolved: false, confirmed: true, item, itemKey: key, risk: "high", riskLabel: RISK_LABEL.high,
      reason: "現場監督により「見積落とし」と確定済みです。", referenceAmount: item.amount ?? null,
      lumpSumCandidate: null, dispositionLabel: ESTIMATE_DISPOSITION_LABEL.omission_confirmed
    };
  }

  const computed = computeEstimateRisk(result, item, vendorItems, excludedVendorKeys);
  const deferred = disposition && disposition.disposition === "needs_review";
  return {
    resolved: false, confirmed: false, item, itemKey: key, referenceAmount: item.amount ?? null,
    dispositionLabel: deferred ? ESTIMATE_DISPOSITION_LABEL.needs_review : null,
    ...computed
  };
}

function buildVendorCandidate(result, disposition) {
  const item = result.vendorItem;
  const key = buildItemKey(item);
  if (disposition && RESOLVING_VENDOR_DISPOSITIONS.has(disposition.disposition)) {
    return { resolved: true, item, itemKey: key, disposition: disposition.disposition, dispositionLabel: VENDOR_DISPOSITION_LABEL[disposition.disposition], note: disposition.note };
  }
  const deferred = disposition && disposition.disposition === "needs_review";
  return { resolved: false, item, itemKey: key, reason: result.note, dispositionLabel: deferred ? VENDOR_DISPOSITION_LABEL.needs_review : null };
}

/**
 * @param {object[]} compareResults compareEstimateToQuote()の戻り値
 * @param {object[]} vendorItems 比較対象バッチの業者見積全項目（一式候補探索用）
 * @param {object[]} dispositions listOmissionDispositionsByBatch()の戻り値
 * @returns {{ candidates: object[], reverseCandidates: object[], resolved: object[], resolvedReverse: object[], summary: object }}
 */
export function checkOmissions({ compareResults = [], vendorItems = [], dispositions = [] } = {}) {
  const estimateDispositionByKey = new Map(dispositions.filter((d) => d.side === "estimate").map((d) => [d.itemKey, d]));
  const vendorDispositionByKey = new Map(dispositions.filter((d) => d.side === "vendor").map((d) => [d.itemKey, d]));

  // 「一式」候補探索から除外する、既に1:1で確定的に対応付けられた業者見積項目
  const excludedVendorKeys = new Set(
    compareResults.filter((r) => (r.type === "match" || r.type === "diff") && r.vendorItem).map((r) => buildItemKey(r.vendorItem))
  );

  const candidates = [];
  const resolved = [];
  for (const r of compareResults) {
    if (r.type === "estimate_only" || r.type === "needs_review" || (r.type === "duplicate_possible" && r.estimateItem)) {
      const disposition = estimateDispositionByKey.get(buildItemKey(r.estimateItem));
      const built = buildEstimateCandidate(r, vendorItems, excludedVendorKeys, disposition);
      (built.resolved ? resolved : candidates).push(built);
    }
  }

  const reverseCandidates = [];
  const resolvedReverse = [];
  for (const r of compareResults) {
    if (r.type === "vendor_only" || (r.type === "duplicate_possible" && r.vendorItem && !r.estimateItem)) {
      const disposition = vendorDispositionByKey.get(buildItemKey(r.vendorItem));
      const built = buildVendorCandidate(r, disposition);
      (built.resolved ? resolvedReverse : reverseCandidates).push(built);
    }
  }

  const riskOrder = { high: 0, medium: 1, low: 2, needs_review: 3 };
  candidates.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);

  const counts = { high: 0, medium: 0, low: 0, needs_review: 0 };
  let referenceAmountTotal = 0;
  for (const c of candidates) {
    counts[c.risk]++;
    if (c.referenceAmount != null) referenceAmountTotal += c.referenceAmount;
  }

  const overallStatus = candidates.length === 0 ? "ok" : counts.high > 0 ? "attention" : "partial";

  return {
    candidates,
    reverseCandidates,
    resolved,
    resolvedReverse,
    summary: { overallStatus, counts, referenceAmountTotal, candidateCount: candidates.length, reverseCandidateCount: reverseCandidates.length }
  };
}
