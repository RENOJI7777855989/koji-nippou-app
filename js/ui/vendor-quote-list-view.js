/* ==========================================================
   業者見積一覧画面
   現場に紐づく業者見積項目（vendorQuoteItems）をテーブル表示し、
   工種・取込バッチでの絞り込みとテキスト検索を行う。
   js/ui/estimate-list-view.jsと同型（見た目・操作感の一貫性のため）。
   ========================================================== */

import { getSite } from "../sites.js";
import { listVendorQuoteItemsBySite, listVendorQuoteBatchesBySite, deleteVendorQuoteBatch } from "../vendorQuote/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const siteNameEl = document.getElementById("vendorQuoteListSiteName");
const searchInput = document.getElementById("vendorQuoteSearchInput");
const categoryFilter = document.getElementById("vendorQuoteCategoryFilter");
const batchFilter = document.getElementById("vendorQuoteBatchFilter");
const goToImportBtn = document.getElementById("goToVendorQuoteImportBtn");
const goToComparisonBtn = document.getElementById("goToComparisonFromListBtn");
const deleteBatchBtn = document.getElementById("deleteVendorQuoteBatchBtn");
const summaryLine = document.getElementById("vendorQuoteSummaryLine");
const emptyEl = document.getElementById("vendorQuoteListEmpty");
const tableWrap = document.getElementById("vendorQuoteTableWrap");
const tableBody = document.getElementById("vendorQuoteTableBody");
const backBtn = document.getElementById("backToSiteFromVendorQuoteListBtn");

let currentSite = null;
let allItems = [];
let allBatches = [];

function formatNumber(n) {
  return n == null ? "" : n.toLocaleString("ja-JP");
}

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;
  const batchId = batchFilter.value;

  return allItems.filter((item) => {
    if (category && item.category !== category) return false;
    if (batchId && item.vendorQuoteBatchId !== batchId) return false;
    if (q && ![item.category, item.itemName, item.spec].some((v) => (v || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderTable() {
  const filtered = applyFilters();
  emptyEl.style.display = allItems.length === 0 ? "block" : "none";
  tableWrap.hidden = allItems.length === 0;

  tableBody.innerHTML = filtered
    .map(
      (item) => `
    <tr class="${item.needsReview ? "estimate-row-warning" : ""}" data-item-id="${item.id}">
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.itemName)}</td>
      <td>${escapeHtml(item.spec)}</td>
      <td class="num">${formatNumber(item.quantity)}</td>
      <td>${escapeHtml(item.unit)}</td>
      <td class="num">${formatNumber(item.unitPrice)}</td>
      <td class="num">${formatNumber(item.amount)}</td>
      <td>${item.needsReview ? '<span class="status-badge status-warning">要確認</span>' : ""}</td>
    </tr>`
    )
    .join("");

  const amountSum = filtered.reduce((sum, i) => sum + (i.amount || 0), 0);
  const reviewCount = filtered.filter((i) => i.needsReview).length;
  summaryLine.textContent =
    allItems.length === 0
      ? ""
      : `${filtered.length}件（合計金額 ${formatNumber(amountSum)}円）${reviewCount > 0 ? ` ／ 要確認 ${reviewCount}件` : ""}`;
}

function renderFilterOptions() {
  const currentCategory = categoryFilter.value;
  const currentBatch = batchFilter.value;

  const categories = [...new Set(allItems.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  categoryFilter.innerHTML =
    `<option value="">工種すべて</option>` + categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  categoryFilter.value = categories.includes(currentCategory) ? currentCategory : "";

  const typeIcon = { excel: "📄", pdf: "📕", csv: "📊" };
  batchFilter.innerHTML =
    `<option value="">すべての取込</option>` +
    allBatches
      .map((b) => {
        const icon = typeIcon[b.sourceFileType] || "📄";
        return `<option value="${b.id}">${icon} ${escapeHtml(b.vendorName) || "業者名未入力"}（${(b.importedAt || "").slice(0, 10)}／${b.itemCount}件）</option>`;
      })
      .join("");
  batchFilter.value = allBatches.some((b) => b.id === currentBatch) ? currentBatch : "";
}

async function reload() {
  [allItems, allBatches] = await Promise.all([
    listVendorQuoteItemsBySite(currentSite.id),
    listVendorQuoteBatchesBySite(currentSite.id)
  ]);
  renderFilterOptions();
  renderTable();
  deleteBatchBtn.hidden = !hasPermission("editReports") || !batchFilter.value;
  goToComparisonBtn.hidden = allBatches.length === 0;
}

searchInput.addEventListener("input", renderTable);
categoryFilter.addEventListener("change", renderTable);
batchFilter.addEventListener("change", () => {
  deleteBatchBtn.hidden = !hasPermission("editReports") || !batchFilter.value;
  renderTable();
});

goToImportBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes/import`));
goToComparisonBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes/compare`));
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}`));

deleteBatchBtn.addEventListener("click", async () => {
  const batch = allBatches.find((b) => b.id === batchFilter.value);
  if (!batch) return;
  if (!confirm(`取込「${batch.vendorName || "業者名未入力"}／${batch.sourceFileName}」（${batch.itemCount}件）を削除しますか？`)) return;
  await deleteVendorQuoteBatch(batch.id);
  showMessage("取込データを削除しました。");
  await reload();
});

export async function initVendorQuoteListView(params) {
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
  searchInput.value = "";
  goToImportBtn.hidden = !hasPermission("editReports");
  showView("view-vendor-quote-list");
  await reload();
}
