/* ==========================================================
   現場一覧画面
   検索・並び替え・アーカイブ表示切替、新規作成の導線を持つ
   ========================================================== */

import { listSites } from "../sites.js";
import { escapeHtml } from "../utils.js";
import { showView } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const listEl = document.getElementById("siteList");
const emptyEl = document.getElementById("siteListEmpty");
const searchInput = document.getElementById("siteSearchInput");
const sortSelect = document.getElementById("siteSortSelect");
const showArchivedCheckbox = document.getElementById("showArchivedCheckbox");
const newSiteBtn = document.getElementById("newSiteBtn");
const goToReportOutputBtn = document.getElementById("goToReportOutputBtn");
const goToReportTemplatesBtn = document.getElementById("goToReportTemplatesBtn");
const goToHistoryBtn = document.getElementById("goToHistoryBtn");
const goToBackupBtn = document.getElementById("goToBackupBtn");

function statusLabel(status) {
  return status === "archived" ? "アーカイブ済み" : "進行中";
}

async function renderList() {
  let sites = await listSites({
    includeArchived: showArchivedCheckbox.checked,
    search: searchInput.value,
    sortBy: sortSelect.value
  });

  // 監督は担当現場のみ表示（管理者・閲覧のみは全件表示）
  sites = sites.filter((site) => canAccessSite(site));

  listEl.innerHTML = "";
  emptyEl.style.display = sites.length === 0 ? "block" : "none";

  sites.forEach((site) => {
    const li = document.createElement("li");
    li.className = "site-card";
    li.dataset.siteId = site.id;
    li.innerHTML = `
      <p class="site-card-name">${escapeHtml(site.name)}</p>
      <p class="site-card-meta">${escapeHtml(site.clientName) || "-"}</p>
      <p class="site-card-meta">${escapeHtml(site.address) || "-"}</p>
      <span class="status-badge status-${site.status}">${statusLabel(site.status)}${site.completedAt ? "・工事完了" : ""}</span>
    `;
    listEl.appendChild(li);
  });
}

listEl.addEventListener("click", (e) => {
  const card = e.target.closest(".site-card");
  if (!card) return;
  navigate(`/sites/${card.dataset.siteId}`);
});

searchInput.addEventListener("input", renderList);
sortSelect.addEventListener("change", renderList);
showArchivedCheckbox.addEventListener("change", renderList);

newSiteBtn.addEventListener("click", () => navigate("/sites/new"));
goToReportOutputBtn.addEventListener("click", () => navigate("/report-output"));
goToReportTemplatesBtn.addEventListener("click", () => navigate("/report-templates"));
goToHistoryBtn.addEventListener("click", () => navigate("/history"));
goToBackupBtn.addEventListener("click", () => navigate("/backup"));

export async function initSiteListView() {
  showView("view-site-list");
  newSiteBtn.hidden = !hasPermission("manageSites");
  goToReportTemplatesBtn.hidden = !hasPermission("manageTemplates");
  await renderList();
}
