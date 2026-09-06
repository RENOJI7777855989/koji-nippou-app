/* ==========================================================
   見積・積算比較画面（積算チェックシステム）
   積算資料（現場の全estimateItemsをそのまま再利用）と、選択した
   業者見積バッチ（vendorQuoteItems）を、js/vendorQuote/
   compareEstimateToQuote.js（純粋関数・文字列類似度のみ・
   ネットワーク不要）で比較する。この画面の最優先の目的は
   「見積比較」ではなく「見積落としの発見」であり、比較結果を
   js/vendorQuote/omissionCheck.jsでリスク判定（高/中/低/要確認）
   付きの「見積落とし候補」に組み替えて最上部に表示する。
   ユーザーの最終判断（見積落とし／別項目に含む／一式に含む／
   対象外／問題なし／要確認）はomissionDispositionsに保存し、
   次回以降の比較に自動適用される。「要確認」項目（あいまい一致）
   はその場で「同一項目」「別項目」も選択でき、itemMatchOverrides
   に保存される。比較結果自体は保存しない（開くたびに再計算する）。
   ========================================================== */

import { getSite } from "../sites.js";
import { listEstimateItemsBySite } from "../estimate/index.js";
import {
  listVendorQuoteBatchesBySite,
  listVendorQuoteItemsByBatch,
  listItemMatchOverridesBySite,
  setItemMatchOverride,
  compareEstimateToQuote,
  summarizeComparison,
  DEFAULT_TOLERANCE,
  checkOmissions,
  listOmissionDispositionsByBatch,
  setOmissionDisposition,
  buildItemKey,
  exportComparisonCsv,
  buildComparisonPrintHtml,
  listMasterItems,
  createMasterItem,
  addAliasToMasterItem,
  resolveToMaster
} from "../vendorQuote/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite } from "../auth.js";

const siteNameEl = document.getElementById("comparisonSiteName");
const backBtn = document.getElementById("backToVendorQuoteListFromComparisonBtn");
const goToMasterItemsBtn = document.getElementById("goToMasterItemsFromComparisonBtn");
const vendorSelect = document.getElementById("comparisonVendorSelect");
const headerInfoEl = document.getElementById("comparisonHeaderInfo");
const noBatchMsg = document.getElementById("comparisonNoBatchMessage");
const mainArea = document.getElementById("comparisonMainArea");

const toleranceInputs = {
  quantityTolerancePercent: document.getElementById("toleranceQuantityWarn"),
  quantityAlertPercent: document.getElementById("toleranceQuantityAlert"),
  priceTolerancePercent: document.getElementById("tolerancePriceWarn"),
  priceAlertPercent: document.getElementById("tolerancePriceAlert")
};
const toleranceApplyBtn = document.getElementById("toleranceApplyBtn");

const summaryPanel = document.getElementById("comparisonSummaryPanel");
const filterSelect = document.getElementById("comparisonFilterSelect");
const searchInput = document.getElementById("comparisonSearchInput");
const tableWrap = document.getElementById("comparisonTableWrap");
const tableBody = document.getElementById("comparisonTableBody");
const emptyEl = document.getElementById("comparisonEmpty");

const omissionOverallPanel = document.getElementById("omissionOverallPanel");
const omissionCandidatesEmpty = document.getElementById("omissionCandidatesEmpty");
const omissionCandidatesTableWrap = document.getElementById("omissionCandidatesTableWrap");
const omissionCandidatesTableBody = document.getElementById("omissionCandidatesTableBody");
const reverseCandidatesEmpty = document.getElementById("reverseCandidatesEmpty");
const reverseCandidatesTableWrap = document.getElementById("reverseCandidatesTableWrap");
const reverseCandidatesTableBody = document.getElementById("reverseCandidatesTableBody");
const resolvedEstimateEmpty = document.getElementById("resolvedEstimateEmpty");
const resolvedEstimateTableWrap = document.getElementById("resolvedEstimateTableWrap");
const resolvedEstimateTableBody = document.getElementById("resolvedEstimateTableBody");
const resolvedVendorEmpty = document.getElementById("resolvedVendorEmpty");
const resolvedVendorTableWrap = document.getElementById("resolvedVendorTableWrap");
const resolvedVendorTableBody = document.getElementById("resolvedVendorTableBody");

const exportCsvBtn = document.getElementById("comparisonExportCsvBtn");
const exportPdfBtn = document.getElementById("comparisonExportPdfBtn");
const printBtn = document.getElementById("comparisonPrintBtn");
const pdfPreviewFrame = document.getElementById("comparisonPdfPreviewFrame");

let currentSite = null;
let allBatches = [];
let currentBatch = null;
let estimateItems = [];
let vendorItems = [];
let overrides = [];
let dispositions = [];
let masterItems = []; // 共通積算項目マスター（全現場共通のグローバル辞書）
let currentResults = [];
let currentSummary = null;
let omissionResult = null;
let tolerance = { ...DEFAULT_TOLERANCE };
// 「別項目に含む」「一式に含む」選択時、対応するvendor項目を選ぶまでの一時状態
let pendingPick = null; // { idx, disposition }

const TYPE_LABEL = {
  match: "一致",
  diff: "差あり",
  needs_review: "要確認",
  estimate_only: "見積漏れの可能性",
  vendor_only: "積算漏れの可能性",
  duplicate_possible: "重複の可能性"
};

const ESTIMATE_ACTIONS = [
  { action: "omission_confirmed", label: "見積落とし" },
  { action: "included_in_other_item", label: "別項目に含む" },
  { action: "included_in_lump_sum", label: "一式に含む" },
  { action: "not_applicable", label: "対象外" },
  { action: "ok", label: "問題なし" },
  { action: "needs_review", label: "要確認" }
];
const VENDOR_ACTIONS = [
  { action: "additional_work", label: "追加工事" },
  { action: "separate_contract", label: "別途工事" },
  { action: "out_of_scope", label: "積算対象外" },
  { action: "possible_duplicate", label: "二重計上の可能性" },
  { action: "ok", label: "問題なし" },
  { action: "needs_review", label: "要確認" }
];
const LINK_PICKER_ACTIONS = new Set(["included_in_other_item", "included_in_lump_sum"]);

function fmt(n) {
  return n == null ? "" : n.toLocaleString("ja-JP");
}
function fmtPct(n) {
  return n == null ? "-" : `${n.toFixed(1)}%`;
}
function vendorItemLabel(key) {
  const v = vendorItems.find((item) => buildItemKey(item) === key);
  return v ? `${v.itemName}${v.spec ? `（${v.spec}）` : ""}` : "";
}
function estimateItemLabel(key) {
  const e = estimateItems.find((item) => buildItemKey(item) === key);
  return e ? `${e.itemName}${e.spec ? `（${e.spec}）` : ""}` : "";
}
function masterCodeBadge(item) {
  return item?._masterItemCode ? `<span class="master-code-badge" title="共通積算項目マスター">${escapeHtml(item._masterItemCode)}</span>` : "";
}

function readToleranceFromForm() {
  const t = { ...DEFAULT_TOLERANCE };
  for (const [key, input] of Object.entries(toleranceInputs)) {
    const v = Number(input.value);
    if (!Number.isNaN(v) && v >= 0) t[key] = v;
  }
  // 金額の許容差は単価と同じ既定値を使う（指示書の「数量5%/10%、単価も同様の2段階」に合わせる）
  t.amountTolerancePercent = t.priceTolerancePercent;
  t.amountAlertPercent = t.priceAlertPercent;
  return t;
}

function writeToleranceToForm() {
  toleranceInputs.quantityTolerancePercent.value = tolerance.quantityTolerancePercent;
  toleranceInputs.quantityAlertPercent.value = tolerance.quantityAlertPercent;
  toleranceInputs.priceTolerancePercent.value = tolerance.priceTolerancePercent;
  toleranceInputs.priceAlertPercent.value = tolerance.priceAlertPercent;
}

/**
 * 積算項目・業者見積項目を共通積算項目マスターへ解決し、解決できた
 * ものには_masterItemCode/_masterMatchTypeを付与したコピーを返す
 * （元のレコードは変更しない）。マスターが空なら全件そのまま返る
 * ため、compareEstimateToQuote.js側の新ステップは何もせず、
 * 既存の動作と完全に同一になる。
 */
function resolveItemsForMaster(items) {
  return items.map((item) => {
    const resolution = resolveToMaster(item, masterItems);
    if (!resolution.masterItem) return item;
    return { ...item, _masterItemCode: resolution.masterItem.itemCode, _masterMatchType: resolution.matchType };
  });
}

function recomputeAll() {
  const estimateItemsForCompare = resolveItemsForMaster(estimateItems);
  const vendorItemsForCompare = resolveItemsForMaster(vendorItems);
  currentResults = compareEstimateToQuote({ estimateItems: estimateItemsForCompare, vendorItems: vendorItemsForCompare, overrides, tolerance });
  currentSummary = summarizeComparison({ estimateItems: estimateItemsForCompare, vendorItems: vendorItemsForCompare, results: currentResults });
  omissionResult = checkOmissions({ compareResults: currentResults, vendorItems: vendorItemsForCompare, dispositions });
  renderSummary();
  renderOmissionOverall();
  renderOmissionCandidates();
  renderReverseCandidates();
  renderResolvedLists();
  renderTable();
}

function renderSummary() {
  const diffLabel = currentSummary.diffAmount >= 0 ? "増" : "減";
  const needsAttentionCount =
    (currentSummary.counts.needs_review || 0) +
    (currentSummary.counts.estimate_only || 0) +
    (currentSummary.counts.vendor_only || 0) +
    (currentSummary.counts.duplicate_possible || 0);
  summaryPanel.innerHTML = `
    <div class="comparison-summary-box"><dt>積算総額</dt><dd>${fmt(currentSummary.estimateTotalAmount)}円</dd></div>
    <div class="comparison-summary-box"><dt>見積総額</dt><dd>${fmt(currentSummary.vendorTotalAmount)}円</dd></div>
    <div class="comparison-summary-box"><dt>差額</dt><dd>${fmt(Math.abs(currentSummary.diffAmount))}円（${diffLabel}）</dd></div>
    <div class="comparison-summary-box"><dt>差率</dt><dd>${currentSummary.diffPercent != null ? fmtPct(currentSummary.diffPercent) : "-"}</dd></div>
    <div class="comparison-summary-box"><dt>一致</dt><dd>${currentSummary.counts.match || 0}件</dd></div>
    <div class="comparison-summary-box comparison-summary-attention"><dt>確認が必要</dt><dd>${needsAttentionCount}件</dd></div>
  `;
}

const OVERALL_STATUS_META = {
  attention: { cls: "status-attention", label: "🔴 要確認" },
  partial: { cls: "status-partial", label: "🟡 一部要確認" },
  ok: { cls: "status-ok", label: "🟢 問題なし" }
};

function renderOmissionOverall() {
  const s = omissionResult.summary;
  const meta = OVERALL_STATUS_META[s.overallStatus];
  omissionOverallPanel.className = `omission-overall-panel ${meta.cls}`;
  omissionOverallPanel.innerHTML = `
    <span>積算チェック 総合判定: ${meta.label}</span>
    <span class="omission-overall-detail">見積落としの可能性: 高 ${s.counts.high}件／中 ${s.counts.medium}件／低 ${s.counts.low}件／要確認 ${s.counts.needs_review}件</span>
    <span class="omission-overall-detail">見積落とし候補 概算金額（積算資料の金額ベース・参考値）: ${fmt(s.referenceAmountTotal)}円</span>
  `;
}

function omissionActionButtonsHtml(idx, actions, prefix) {
  return `<div class="omission-decision-actions">${actions
    .map(({ action, label }) => `<button type="button" class="secondary-btn ${prefix}ActionBtn" data-idx="${idx}" data-action="${action}">${escapeHtml(label)}</button>`)
    .join("")}</div>`;
}

function linkPickerHtml(idx) {
  const options = vendorItems.map((v) => `<option value="${escapeHtml(buildItemKey(v))}">${escapeHtml(v.itemName)}${v.spec ? `（${escapeHtml(v.spec)}）` : ""} - ${fmt(v.amount)}円</option>`).join("");
  return `<div class="omission-link-picker">
    <select class="omissionLinkSelect" data-idx="${idx}">${options}</select>
    <button type="button" class="secondary-btn omissionLinkConfirmBtn" data-idx="${idx}">確定</button>
    <button type="button" class="secondary-btn omissionLinkCancelBtn" data-idx="${idx}">キャンセル</button>
  </div>`;
}

function omissionCandidateRowHtml(c, idx) {
  const item = c.item;
  const actionsHtml =
    pendingPick && pendingPick.idx === idx ? linkPickerHtml(idx) : omissionActionButtonsHtml(idx, ESTIMATE_ACTIONS, "omission");
  const tag = c.dispositionLabel ? `<span class="omission-disposition-tag">${escapeHtml(c.dispositionLabel)}</span>` : "";
  return `<tr>
    <td><span class="risk-badge risk-${c.risk}">${escapeHtml(c.riskLabel)}</span></td>
    <td>${escapeHtml(item.category)}</td>
    <td>${masterCodeBadge(item)}${escapeHtml(item.itemName)}${item.spec ? `（${escapeHtml(item.spec)}）` : ""}<br>${fmt(item.quantity)}${escapeHtml(item.unit)} ／ 積算金額(参考) ${fmt(c.referenceAmount)}円</td>
    <td class="comparison-note">${escapeHtml(c.reason || "")}</td>
    <td>${actionsHtml}${tag}</td>
  </tr>`;
}

function renderOmissionCandidates() {
  const list = omissionResult.candidates;
  omissionCandidatesEmpty.style.display = list.length === 0 ? "block" : "none";
  omissionCandidatesTableWrap.hidden = list.length === 0;
  omissionCandidatesTableBody.innerHTML = list.map((c, idx) => omissionCandidateRowHtml(c, idx)).join("");
}

/** この一式行(vendorItem)を「一式に含む」として紐付け済みの積算項目名一覧 */
function includedInLumpSumLabels(vendorItem) {
  const key = buildItemKey(vendorItem);
  return dispositions
    .filter((d) => d.side === "estimate" && d.disposition === "included_in_lump_sum" && d.linkedItemKey === key)
    .map((d) => estimateItemLabel(d.itemKey))
    .filter(Boolean);
}

function reverseCandidateRowHtml(c, idx) {
  const item = c.item;
  const actionsHtml = omissionActionButtonsHtml(idx, VENDOR_ACTIONS, "reverse");
  const tag = c.dispositionLabel ? `<span class="omission-disposition-tag">${escapeHtml(c.dispositionLabel)}</span>` : "";
  const includedNames = includedInLumpSumLabels(item);
  const includedHtml = includedNames.length
    ? `<p class="omission-disposition-tag">この一式に含まれると確認済み: ${includedNames.map((n) => escapeHtml(n)).join("、")}</p>`
    : "";
  return `<tr>
    <td>${escapeHtml(item.category)}</td>
    <td>${masterCodeBadge(item)}${escapeHtml(item.itemName)}${item.spec ? `（${escapeHtml(item.spec)}）` : ""}<br>${fmt(item.quantity)}${escapeHtml(item.unit)} ／ ${fmt(item.amount)}円</td>
    <td class="comparison-note">${escapeHtml(c.reason || "")}${includedHtml}</td>
    <td>${actionsHtml}${tag}</td>
  </tr>`;
}

function renderReverseCandidates() {
  const list = omissionResult.reverseCandidates;
  reverseCandidatesEmpty.style.display = list.length === 0 ? "block" : "none";
  reverseCandidatesTableWrap.hidden = list.length === 0;
  reverseCandidatesTableBody.innerHTML = list.map((c, idx) => reverseCandidateRowHtml(c, idx)).join("");
}

function resolvedRowHtml(c, idx, prefix) {
  const linked = c.linkedItemKey ? `（${escapeHtml(vendorItemLabel(c.linkedItemKey))}）` : "";
  return `<tr>
    <td>${escapeHtml(c.item.category)}</td>
    <td>${escapeHtml(c.item.itemName)}${c.item.spec ? `（${escapeHtml(c.item.spec)}）` : ""}</td>
    <td>${escapeHtml(c.dispositionLabel || "")}${linked}</td>
    <td><button type="button" class="secondary-btn ${prefix}ResetBtn" data-idx="${idx}">見直す</button></td>
  </tr>`;
}

function renderResolvedLists() {
  const est = omissionResult.resolved;
  resolvedEstimateEmpty.style.display = est.length === 0 ? "block" : "none";
  resolvedEstimateTableWrap.hidden = est.length === 0;
  resolvedEstimateTableBody.innerHTML = est.map((c, idx) => resolvedRowHtml(c, idx, "resolvedEstimate")).join("");

  const vq = omissionResult.resolvedReverse;
  resolvedVendorEmpty.style.display = vq.length === 0 ? "block" : "none";
  resolvedVendorTableWrap.hidden = vq.length === 0;
  resolvedVendorTableBody.innerHTML = vq.map((c, idx) => resolvedRowHtml(c, idx, "resolvedVendor")).join("");
}

function applyListFilters(results) {
  const type = filterSelect.value;
  const q = searchInput.value.trim().toLowerCase();
  return results.filter((r) => {
    if (type && r.type !== type) return false;
    if (q) {
      const hay = [
        r.estimateItem?.category, r.estimateItem?.itemName, r.estimateItem?.spec,
        r.vendorItem?.category, r.vendorItem?.itemName, r.vendorItem?.spec
      ].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function resultRowHtml(r, idx) {
  const est = r.estimateItem;
  const vq = r.vendorItem;
  const typeClass = `comparison-type-${r.type.replace(/_/g, "-")}`;
  const flagBadges = (r.flags || [])
    .map((f) => `<span class="status-badge status-warning">${{ quantity: "数量差", unitPrice: "単価差", amount: "金額差" }[f]}</span>`)
    .join(" ");

  const decisionButtons =
    r.type === "needs_review"
      ? `<div class="comparison-decision-actions">
          <button type="button" class="secondary-btn decisionSameBtn" data-idx="${idx}">同一項目</button>
          <button type="button" class="secondary-btn decisionDifferentBtn" data-idx="${idx}">別項目</button>
        </div>`
      : "";

  return `<tr class="${typeClass}">
    <td><span class="status-badge ${r.type === "match" ? "" : "status-warning"}">${escapeHtml(TYPE_LABEL[r.type] || r.type)}</span>${flagBadges}</td>
    <td>${escapeHtml(est?.category || vq?.category || "")}</td>
    <td>
      <p class="comparison-item-name">積算: ${est ? `${masterCodeBadge(est)}${escapeHtml(est.itemName)}` : "-"}</p>
      <p class="comparison-item-name">見積: ${vq ? `${masterCodeBadge(vq)}${escapeHtml(vq.itemName)}` : "-"}</p>
    </td>
    <td class="num">${fmt(est?.quantity)} / ${fmt(vq?.quantity)}${r.quantityDiffPct != null ? `<br>(${fmtPct(r.quantityDiffPct)})` : ""}</td>
    <td class="num">${fmt(est?.unitPrice)} / ${fmt(vq?.unitPrice)}${r.unitPriceDiffPct != null ? `<br>(${fmtPct(r.unitPriceDiffPct)})` : ""}</td>
    <td class="num">${fmt(est?.amount)} / ${fmt(vq?.amount)}${r.amountDiffPct != null ? `<br>(${fmtPct(r.amountDiffPct)})` : ""}</td>
    <td class="comparison-note">${escapeHtml(r.note || "")}${decisionButtons}</td>
  </tr>`;
}

function renderTable() {
  const filtered = applyListFilters(currentResults);
  emptyEl.style.display = currentResults.length === 0 ? "block" : "none";
  tableWrap.hidden = currentResults.length === 0;
  // data-idxはcurrentResults全体（フィルター前）でのインデックスを指す必要があるため、
  // フィルター後の配列でも元のインデックスを保持して埋め込む
  tableBody.innerHTML = filtered.map((r) => resultRowHtml(r, currentResults.indexOf(r))).join("");
}

async function reloadOverrides() {
  overrides = await listItemMatchOverridesBySite(currentSite.id);
}

async function reloadDispositions() {
  dispositions = await listOmissionDispositionsByBatch(currentSite.id, currentBatch.id);
}

async function reloadMasterItems() {
  masterItems = await listMasterItems();
}

/**
 * 「同一項目」確定時、共通積算項目マスターにも反映する。
 * どちらも未解決なら新しいマスター項目を作成（積算側の項目名を
 * 標準項目名に採用）し、業者見積側の表記を別名として追加。
 * 片方だけ解決済みなら、もう片方の表記を別名として追加。
 * 両方とも別々のマスター項目に解決済み（矛盾）の場合は、自動統合
 * せず何もしない（ユーザーの判断に委ねる）。
 */
async function syncMasterOnConfirmSame(estItem, vqItem) {
  const estResolution = resolveToMaster(estItem, masterItems);
  const vqResolution = resolveToMaster(vqItem, masterItems);
  if (estResolution.masterItem && vqResolution.masterItem) return;
  if (estResolution.masterItem) {
    await addAliasToMasterItem(estResolution.masterItem.id, vqItem.itemName);
  } else if (vqResolution.masterItem) {
    await addAliasToMasterItem(vqResolution.masterItem.id, estItem.itemName);
  } else {
    const created = await createMasterItem({ category: estItem.category, standardName: estItem.itemName, unit: estItem.unit });
    await addAliasToMasterItem(created.id, vqItem.itemName);
  }
  await reloadMasterItems();
}

async function selectBatch(batchId) {
  currentBatch = allBatches.find((b) => b.id === batchId) || null;
  pendingPick = null;
  if (!currentBatch) {
    mainArea.hidden = true;
    noBatchMsg.hidden = false;
    return;
  }
  noBatchMsg.hidden = true;
  mainArea.hidden = false;
  headerInfoEl.innerHTML = `
    <div><dt>現場名</dt><dd>${escapeHtml(currentSite.name)}</dd></div>
    <div><dt>業者名</dt><dd>${escapeHtml(currentBatch.vendorName) || "-"}</dd></div>
    <div><dt>見積番号</dt><dd>${escapeHtml(currentBatch.quoteNumber) || "-"}</dd></div>
    <div><dt>見積日</dt><dd>${escapeHtml(currentBatch.quoteDate) || "-"}</dd></div>
  `;
  vendorItems = await listVendorQuoteItemsByBatch(currentBatch.id);
  await Promise.all([reloadOverrides(), reloadDispositions()]);
  recomputeAll();
}

vendorSelect.addEventListener("change", () => selectBatch(vendorSelect.value));
filterSelect.addEventListener("change", renderTable);
searchInput.addEventListener("input", renderTable);
toleranceApplyBtn.addEventListener("click", () => {
  tolerance = readToleranceFromForm();
  if (currentBatch) recomputeAll();
});
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes`));
goToMasterItemsBtn.addEventListener("click", () => navigate("/master-items"));

tableBody.addEventListener("click", async (e) => {
  const sameBtn = e.target.closest(".decisionSameBtn");
  const diffBtn = e.target.closest(".decisionDifferentBtn");
  const btn = sameBtn || diffBtn;
  if (!btn) return;
  const r = currentResults[Number(btn.dataset.idx)];
  if (!r || r.type !== "needs_review") return;
  await setItemMatchOverride({
    siteId: currentSite.id,
    estimateItemKey: r.estimateItemKey,
    vendorItemKey: r.vendorItemKey,
    decision: sameBtn ? "same" : "different"
  });
  if (sameBtn) await syncMasterOnConfirmSame(r.estimateItem, r.vendorItem);
  showMessage(
    sameBtn
      ? "「同一項目」として記録しました。以降の比較に自動適用されるほか、共通積算項目マスターにも反映されます。"
      : "「別項目」として記録しました。"
  );
  await reloadOverrides();
  recomputeAll();
});

omissionCandidatesTableBody.addEventListener("click", async (e) => {
  const linkConfirmBtn = e.target.closest(".omissionLinkConfirmBtn");
  const linkCancelBtn = e.target.closest(".omissionLinkCancelBtn");
  const actionBtn = e.target.closest(".omissionActionBtn");

  if (linkCancelBtn) {
    pendingPick = null;
    renderOmissionCandidates();
    return;
  }
  if (linkConfirmBtn) {
    const idx = Number(linkConfirmBtn.dataset.idx);
    const select = omissionCandidatesTableBody.querySelector(`.omissionLinkSelect[data-idx="${idx}"]`);
    const candidate = omissionResult.candidates[idx];
    if (!candidate || !select) return;
    await setOmissionDisposition({
      siteId: currentSite.id,
      vendorQuoteBatchId: currentBatch.id,
      side: "estimate",
      itemKey: candidate.itemKey,
      disposition: pendingPick.disposition,
      linkedItemKey: select.value
    });
    pendingPick = null;
    showMessage("確認結果を記録しました。");
    await reloadDispositions();
    recomputeAll();
    return;
  }
  if (actionBtn) {
    const idx = Number(actionBtn.dataset.idx);
    const action = actionBtn.dataset.action;
    const candidate = omissionResult.candidates[idx];
    if (!candidate) return;
    if (LINK_PICKER_ACTIONS.has(action)) {
      pendingPick = { idx, disposition: action };
      renderOmissionCandidates();
      return;
    }
    await setOmissionDisposition({
      siteId: currentSite.id,
      vendorQuoteBatchId: currentBatch.id,
      side: "estimate",
      itemKey: candidate.itemKey,
      disposition: action
    });
    showMessage("確認結果を記録しました。");
    await reloadDispositions();
    recomputeAll();
  }
});

reverseCandidatesTableBody.addEventListener("click", async (e) => {
  const actionBtn = e.target.closest(".reverseActionBtn");
  if (!actionBtn) return;
  const idx = Number(actionBtn.dataset.idx);
  const candidate = omissionResult.reverseCandidates[idx];
  if (!candidate) return;
  await setOmissionDisposition({
    siteId: currentSite.id,
    vendorQuoteBatchId: currentBatch.id,
    side: "vendor",
    itemKey: candidate.itemKey,
    disposition: actionBtn.dataset.action
  });
  showMessage("確認結果を記録しました。");
  await reloadDispositions();
  recomputeAll();
});

resolvedEstimateTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".resolvedEstimateResetBtn");
  if (!btn) return;
  const candidate = omissionResult.resolved[Number(btn.dataset.idx)];
  if (!candidate) return;
  await setOmissionDisposition({
    siteId: currentSite.id,
    vendorQuoteBatchId: currentBatch.id,
    side: "estimate",
    itemKey: candidate.itemKey,
    disposition: "needs_review"
  });
  showMessage("見積落とし候補に戻しました。");
  await reloadDispositions();
  recomputeAll();
});

resolvedVendorTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".resolvedVendorResetBtn");
  if (!btn) return;
  const candidate = omissionResult.resolvedReverse[Number(btn.dataset.idx)];
  if (!candidate) return;
  await setOmissionDisposition({
    siteId: currentSite.id,
    vendorQuoteBatchId: currentBatch.id,
    side: "vendor",
    itemKey: candidate.itemKey,
    disposition: "needs_review"
  });
  showMessage("逆方向チェック候補に戻しました。");
  await reloadDispositions();
  recomputeAll();
});

exportCsvBtn.addEventListener("click", () => {
  if (!currentBatch) return;
  const { blob, filename } = exportComparisonCsv({ site: currentSite, vendorBatch: currentBatch, results: currentResults, omission: omissionResult });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showMessage(`積算チェック結果をCSVで出力しました（${filename}）`);
});

exportPdfBtn.addEventListener("click", () => {
  if (!currentBatch) return;
  const { html } = buildComparisonPrintHtml({ site: currentSite, vendorBatch: currentBatch, summary: currentSummary, results: currentResults, omission: omissionResult });
  pdfPreviewFrame.srcdoc = html;
  pdfPreviewFrame.hidden = false;
  printBtn.hidden = false;
  showMessage("PDF出力用のプレビューを表示しました。印刷ボタンから印刷・PDF保存してください。");
});

printBtn.addEventListener("click", () => {
  if (!pdfPreviewFrame.contentWindow) {
    showMessage("印刷対象がありません。先にPDF出力ボタンを押してください。", true);
    return;
  }
  pdfPreviewFrame.contentWindow.focus();
  pdfPreviewFrame.contentWindow.print();
});

export async function initComparisonView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site)) {
    showMessage("この現場を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  currentSite = site;
  siteNameEl.textContent = `（${site.name}）`;
  tolerance = { ...DEFAULT_TOLERANCE };
  writeToleranceToForm();
  filterSelect.value = "";
  searchInput.value = "";
  pdfPreviewFrame.hidden = true;
  pdfPreviewFrame.removeAttribute("srcdoc");
  printBtn.hidden = true;

  [estimateItems, allBatches, masterItems] = await Promise.all([
    listEstimateItemsBySite(site.id),
    listVendorQuoteBatchesBySite(site.id),
    listMasterItems()
  ]);

  const typeIcon = { excel: "📄", pdf: "📕", csv: "📊" };
  vendorSelect.innerHTML = allBatches
    .map((b) => `<option value="${b.id}">${typeIcon[b.sourceFileType] || "📄"} ${escapeHtml(b.vendorName) || "業者名未入力"}（${(b.importedAt || "").slice(0, 10)}）</option>`)
    .join("");

  showView("view-comparison");

  if (allBatches.length === 0) {
    mainArea.hidden = true;
    noBatchMsg.hidden = false;
    return;
  }
  vendorSelect.value = allBatches[0].id;
  await selectBatch(allBatches[0].id);
}
