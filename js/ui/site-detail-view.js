/* ==========================================================
   現場詳細画面
   基本情報表示、編集・コピー・アーカイブ操作、配下の日報一覧を扱う
   ========================================================== */

import { getSite, copySite, archiveSite, unarchiveSite } from "../sites.js";
import { listReportsBySite } from "../reports.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const nameEl = document.getElementById("siteDetailName");
const statusBadgeEl = document.getElementById("siteDetailStatusBadge");
const clientNameEl = document.getElementById("siteDetailClientName");
const addressEl = document.getElementById("siteDetailAddress");
const periodEl = document.getElementById("siteDetailPeriod");
const memoEl = document.getElementById("siteDetailMemo");
const editBtn = document.getElementById("editSiteBtn");
const copyBtn = document.getElementById("copySiteBtn");
const toggleArchiveBtn = document.getElementById("toggleArchiveBtn");
const backBtn = document.getElementById("backToSiteListBtn");
const newReportBtn = document.getElementById("newReportBtn");
const reportListEl = document.getElementById("reportList");
const reportListEmptyEl = document.getElementById("reportListEmpty");

const copyDialog = document.getElementById("copySiteDialog");
const copyForm = document.getElementById("copySiteForm");
const copyNewNameInput = document.getElementById("copySiteNewName");
const copyReportsCheckbox = document.getElementById("copySiteReportsCheckbox");
const copyCancelBtn = document.getElementById("copySiteCancelBtn");

let currentSite = null;

function fmtPeriod(site) {
  if (!site.startDate && !site.endDate) return "-";
  return `${site.startDate || "未定"} 〜 ${site.endDate || "未定"}`;
}

async function renderReportList() {
  const reports = await listReportsBySite(currentSite.id);
  reportListEl.innerHTML = "";
  reportListEmptyEl.style.display = reports.length === 0 ? "block" : "none";

  reports.forEach((report) => {
    const li = document.createElement("li");
    li.className = "report-card";
    li.dataset.reportId = report.id;
    li.innerHTML = `
      <p class="report-card-date">${escapeHtml(report.date) || "日付未設定"}</p>
      <p class="report-card-meta">${escapeHtml(report.weather)}／作業人数 ${escapeHtml(report.workerCountTotal) || "-"}人</p>
    `;
    reportListEl.appendChild(li);
  });
}

reportListEl.addEventListener("click", (e) => {
  const card = e.target.closest(".report-card");
  if (!card) return;
  navigate(`/sites/${currentSite.id}/report/${card.dataset.reportId}`);
});

editBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/edit`));
backBtn.addEventListener("click", () => navigate("/sites"));
newReportBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/report/new`));

copyBtn.addEventListener("click", () => {
  copyNewNameInput.value = `${currentSite.name}のコピー`;
  copyReportsCheckbox.checked = false;
  copyDialog.showModal();
});
copyCancelBtn.addEventListener("click", () => copyDialog.close());
copyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newSite = await copySite(currentSite.id, {
    newName: copyNewNameInput.value.trim(),
    copyReports: copyReportsCheckbox.checked
  });
  copyDialog.close();
  showMessage(`現場「${newSite.name}」を作成しました。`);
  navigate(`/sites/${newSite.id}`);
});

toggleArchiveBtn.addEventListener("click", async () => {
  if (currentSite.status === "archived") {
    currentSite = await unarchiveSite(currentSite.id);
    showMessage("現場を進行中に戻しました。");
  } else {
    if (!confirm(`「${currentSite.name}」をアーカイブしますか？一覧から非表示になります（後で戻せます）。`)) return;
    currentSite = await archiveSite(currentSite.id);
    showMessage("現場をアーカイブしました。");
  }
  renderSiteInfo();
});

function renderSiteInfo() {
  nameEl.textContent = currentSite.name;
  statusBadgeEl.textContent = currentSite.status === "archived" ? "アーカイブ済み" : "進行中";
  statusBadgeEl.className = `status-badge status-${currentSite.status}`;
  clientNameEl.textContent = currentSite.clientName || "-";
  addressEl.textContent = currentSite.address || "-";
  periodEl.textContent = fmtPeriod(currentSite);
  memoEl.textContent = currentSite.memo || "-";
  toggleArchiveBtn.textContent = currentSite.status === "archived" ? "アーカイブを解除" : "この現場をアーカイブ";
}

export async function initSiteDetailView(params) {
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
  showView("view-site-detail");

  // 現場管理（編集・コピー・アーカイブ）は管理者のみ。日報作成は
  // 管理者・監督（担当現場のみ、ここまで到達している時点で担当確認済み）。
  // 閲覧のみは日報作成も不可。
  editBtn.hidden = !hasPermission("manageSites");
  copyBtn.hidden = !hasPermission("manageSites");
  toggleArchiveBtn.hidden = !hasPermission("manageSites");
  newReportBtn.hidden = !hasPermission("editReports");

  renderSiteInfo();
  await renderReportList();
}
