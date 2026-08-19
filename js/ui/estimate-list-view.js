/* ==========================================================
   積算内訳一覧画面
   現場に紐づく積算項目（estimateItems）をテーブル表示し、
   工種・取込バッチでの絞り込みとテキスト検索を行う。
   一覧のテキスト検索は単純な部分一致。AIによる自然文質問は
   別画面（js/ui/estimate-ask-view.js）に切り出してある。
   ========================================================== */

import { getSite } from "../sites.js";
import {
  listEstimateItemsBySite,
  listEstimateBatchesBySite,
  deleteEstimateBatch,
  getEstimateBatch,
  getItemSourcePreview
} from "../estimate/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const siteNameEl = document.getElementById("estimateListSiteName");
const searchInput = document.getElementById("estimateSearchInput");
const categoryFilter = document.getElementById("estimateCategoryFilter");
const batchFilter = document.getElementById("estimateBatchFilter");
const goToImportBtn = document.getElementById("goToEstimateImportBtn");
const goToAskBtn = document.getElementById("goToEstimateAskBtn");
const deleteBatchBtn = document.getElementById("deleteEstimateBatchBtn");
const summaryLine = document.getElementById("estimateSummaryLine");
const emptyEl = document.getElementById("estimateListEmpty");
const tableWrap = document.getElementById("estimateTableWrap");
const tableBody = document.getElementById("estimateTableBody");
const backBtn = document.getElementById("backToSiteFromEstimateListBtn");
const sourceDialog = document.getElementById("estimateSourceDialog");
const sourceMetaEl = document.getElementById("estimateSourceMeta");
const sourceBodyEl = document.getElementById("estimateSourceBody");
const sourceCloseBtn = document.getElementById("estimateSourceCloseBtn");

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
    if (batchId && item.estimateBatchId !== batchId) return false;
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
      <td>
        ${item.needsReview ? '<span class="status-badge status-warning">要確認</span>' : ""}
        <button type="button" class="secondary-btn viewSourceBtn" data-item-id="${item.id}">原文</button>
      </td>
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

  batchFilter.innerHTML =
    `<option value="">すべての取込</option>` +
    allBatches
      .map((b) => {
        const icon = b.sourceFileType === "pdf" ? "📕" : "📄";
        return `<option value="${b.id}">${icon} ${escapeHtml(b.sourceFileName)}（${(b.importedAt || "").slice(0, 10)}／${b.itemCount}件）</option>`;
      })
      .join("");
  batchFilter.value = allBatches.some((b) => b.id === currentBatch) ? currentBatch : "";
}

async function reload() {
  [allItems, allBatches] = await Promise.all([listEstimateItemsBySite(currentSite.id), listEstimateBatchesBySite(currentSite.id)]);
  renderFilterOptions();
  renderTable();
  deleteBatchBtn.hidden = !hasPermission("editReports") || !batchFilter.value;
}

function renderSourceBody(preview) {
  if (preview.type === "unavailable") {
    sourceMetaEl.textContent = "";
    sourceBodyEl.innerHTML = `<p class="empty-message">${escapeHtml(preview.reason)}</p>`;
    return;
  }

  if (preview.type === "pdf") {
    sourceMetaEl.textContent = `出典: PDF ${preview.pageLabel}`;
    sourceBodyEl.innerHTML = `<img class="estimate-source-pdf-image" src="${preview.imageDataUrl}" alt="出典PDFページ">`;
    return;
  }

  sourceMetaEl.textContent = `出典: シート「${preview.sheetName}」`;
  const headHtml = `<tr><th></th>${preview.colLetters.map((l) => `<th>${l}</th>`).join("")}</tr>`;
  const bodyHtml = preview.rows
    .map((row) => {
      const rowClass = row.rowNumber === preview.highlightRow ? "estimate-row-highlight" : "";
      return `<tr class="${rowClass}"><th>${row.rowNumber}</th>${preview.colLetters.map((l) => `<td>${escapeHtml(row.cells[l])}</td>`).join("")}</tr>`;
    })
    .join("");
  sourceBodyEl.innerHTML = `<div class="table-scroll"><table class="estimate-table"><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
}

async function openSourceDialog(itemId) {
  const item = allItems.find((i) => i.id === itemId);
  if (!item) return;
  sourceMetaEl.textContent = "";
  sourceBodyEl.innerHTML = `<p class="app-subtitle">読み込み中…</p>`;
  sourceDialog.showModal();
  try {
    const batch = await getEstimateBatch(item.estimateBatchId);
    const preview = await getItemSourcePreview({ item, batch });
    renderSourceBody(preview);
  } catch (err) {
    sourceBodyEl.innerHTML = `<p class="empty-message">${escapeHtml(err.message || "元データの読み込みに失敗しました。")}</p>`;
  }
}

searchInput.addEventListener("input", renderTable);
categoryFilter.addEventListener("change", renderTable);
batchFilter.addEventListener("change", () => {
  deleteBatchBtn.hidden = !hasPermission("editReports") || !batchFilter.value;
  renderTable();
});

goToImportBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates/import`));
goToAskBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates/ask`));
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}`));

tableBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".viewSourceBtn");
  if (!btn) return;
  openSourceDialog(btn.dataset.itemId);
});
sourceCloseBtn.addEventListener("click", () => sourceDialog.close());

deleteBatchBtn.addEventListener("click", async () => {
  const batch = allBatches.find((b) => b.id === batchFilter.value);
  if (!batch) return;
  if (!confirm(`取込「${batch.sourceFileName}」（${batch.itemCount}件）を削除しますか？`)) return;
  await deleteEstimateBatch(batch.id);
  showMessage("取込データを削除しました。");
  await reload();
});

export async function initEstimateListView(params) {
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
  showView("view-estimate-list");
  await reload();
}
