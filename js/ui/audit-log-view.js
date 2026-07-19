/* ==========================================================
   変更履歴画面（管理者のみ）
   誰が・いつ・何を・どう変更したかを一覧表示する。
   ========================================================== */

import { listAuditLog } from "../auditLog.js";
import { escapeHtml } from "../utils.js";
import { showView } from "./common.js";
import { navigate } from "../router.js";

const listEl = document.getElementById("historyList");
const emptyEl = document.getElementById("historyListEmpty");
const entityTypeSelect = document.getElementById("historyEntityTypeSelect");
const backBtn = document.getElementById("backToSiteListFromHistoryBtn");

const ACTION_LABELS = {
  create: "作成",
  update: "更新",
  delete: "削除",
  archive: "アーカイブ",
  unarchive: "アーカイブ解除"
};

function formatDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

async function renderList() {
  const entries = await listAuditLog({ entityType: entityTypeSelect.value || undefined, limit: 500 });
  listEl.innerHTML = "";
  emptyEl.style.display = entries.length === 0 ? "block" : "none";

  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <p class="history-item-summary">
        <span class="status-badge">${escapeHtml(ACTION_LABELS[entry.action] || entry.action)}</span>
        ${escapeHtml(entry.summary)}
      </p>
      <p class="history-item-meta">${escapeHtml(formatDateTime(entry.at))} ／ ${escapeHtml(entry.userName || "（不明なユーザー）")}</p>
    `;
    listEl.appendChild(li);
  });
}

entityTypeSelect.addEventListener("change", renderList);
backBtn.addEventListener("click", () => navigate("/sites"));

export async function initAuditLogView() {
  showView("view-history");
  await renderList();
}
