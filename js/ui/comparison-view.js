/* ==========================================================
   見積・積算比較画面
   積算資料（現場の全estimateItemsをそのまま再利用）と、選択した
   業者見積バッチ（vendorQuoteItems）を、js/vendorQuote/
   compareEstimateToQuote.js（純粋関数・文字列類似度のみ・
   ネットワーク不要）で比較し、一致/数量差/単価差/金額差/
   見積漏れの可能性/積算漏れの可能性/重複の可能性/要確認 に
   分類して一覧表示する。「要確認」項目はその場で「同一項目」
   「別項目」を選択でき、選択内容はitemMatchOverridesに保存され
   次回以降の比較に自動適用される。比較結果自体は保存しない
   （開くたびに再計算する）。
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
  exportComparisonCsv,
  buildComparisonPrintHtml
} from "../vendorQuote/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite } from "../auth.js";

const siteNameEl = document.getElementById("comparisonSiteName");
const backBtn = document.getElementById("backToVendorQuoteListFromComparisonBtn");
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
let currentResults = [];
let currentSummary = null;
let tolerance = { ...DEFAULT_TOLERANCE };

const TYPE_LABEL = {
  match: "一致",
  diff: "差あり",
  needs_review: "要確認",
  estimate_only: "見積漏れの可能性",
  vendor_only: "積算漏れの可能性",
  duplicate_possible: "重複の可能性"
};

function fmt(n) {
  return n == null ? "" : n.toLocaleString("ja-JP");
}
function fmtPct(n) {
  return n == null ? "-" : `${n.toFixed(1)}%`;
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

function runComparison() {
  currentResults = compareEstimateToQuote({ estimateItems, vendorItems, overrides, tolerance });
  currentSummary = summarizeComparison({ estimateItems, vendorItems, results: currentResults });
  renderSummary();
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
      <p class="comparison-item-name">積算: ${escapeHtml(est?.itemName) || "-"}</p>
      <p class="comparison-item-name">見積: ${escapeHtml(vq?.itemName) || "-"}</p>
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

async function selectBatch(batchId) {
  currentBatch = allBatches.find((b) => b.id === batchId) || null;
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
  await reloadOverrides();
  runComparison();
}

vendorSelect.addEventListener("change", () => selectBatch(vendorSelect.value));
filterSelect.addEventListener("change", renderTable);
searchInput.addEventListener("input", renderTable);
toleranceApplyBtn.addEventListener("click", () => {
  tolerance = readToleranceFromForm();
  if (currentBatch) runComparison();
});
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes`));

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
  showMessage(sameBtn ? "「同一項目」として記録しました。以降の比較に自動適用されます。" : "「別項目」として記録しました。");
  await reloadOverrides();
  runComparison();
});

exportCsvBtn.addEventListener("click", () => {
  if (!currentBatch) return;
  const { blob, filename } = exportComparisonCsv({ site: currentSite, vendorBatch: currentBatch, results: currentResults });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showMessage(`比較結果をCSVで出力しました（${filename}）`);
});

exportPdfBtn.addEventListener("click", () => {
  if (!currentBatch) return;
  const { html } = buildComparisonPrintHtml({ site: currentSite, vendorBatch: currentBatch, summary: currentSummary, results: currentResults });
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

  [estimateItems, allBatches] = await Promise.all([
    listEstimateItemsBySite(site.id),
    listVendorQuoteBatchesBySite(site.id)
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
