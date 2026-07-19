/* ==========================================================
   現場データ層
   CRUD・コピー・検索/並び替え・アーカイブを担う
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "./db.js";
import { stampNew, stampUpdate } from "./utils.js";
import { listReportsBySite, createReport } from "./reports.js";
import { recordChange } from "./auditLog.js";

const SORTERS = {
  updatedAt: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  name: (a, b) => a.name.localeCompare(b.name, "ja"),
  startDate: (a, b) => (a.startDate || "").localeCompare(b.startDate || "")
};

export async function listSites({ includeArchived = false, search = "", sortBy = "updatedAt" } = {}) {
  const all = await dbGetAll("sites");
  let filtered = all.filter((s) => !s.isDeleted && (includeArchived || s.status !== "archived"));

  const q = search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((s) =>
      [s.name, s.address, s.clientName].some((v) => (v || "").toLowerCase().includes(q))
    );
  }

  filtered.sort(SORTERS[sortBy] || SORTERS.updatedAt);
  return filtered;
}

export async function getSite(id) {
  return dbGet("sites", id);
}

export async function createSite({ name, address = "", clientName = "", startDate = "", endDate = "", memo = "", assignedUserIds = [] }) {
  const site = stampNew({ name, address, clientName, startDate, endDate, memo, status: "active", assignedUserIds });
  await dbPut("sites", site);
  await recordChange({ entityType: "site", entityId: site.id, action: "create", summary: `現場「${site.name}」を作成` });
  return site;
}

async function applyPatch(id, patch) {
  const existing = await dbGet("sites", id);
  if (!existing) throw new Error("現場が見つかりません");
  const updated = stampUpdate(existing, patch);
  await dbPut("sites", updated);
  return updated;
}

export async function updateSite(id, patch) {
  const updated = await applyPatch(id, patch);
  await recordChange({ entityType: "site", entityId: id, action: "update", summary: `現場「${updated.name}」を更新` });
  return updated;
}

export async function archiveSite(id) {
  const updated = await applyPatch(id, { status: "archived" });
  await recordChange({ entityType: "site", entityId: id, action: "archive", summary: `現場「${updated.name}」をアーカイブ` });
  return updated;
}

export async function unarchiveSite(id) {
  const updated = await applyPatch(id, { status: "active" });
  await recordChange({ entityType: "site", entityId: id, action: "unarchive", summary: `現場「${updated.name}」のアーカイブを解除` });
  return updated;
}

export async function copySite(sourceSiteId, { newName, copyReports = false } = {}) {
  const source = await getSite(sourceSiteId);
  if (!source) throw new Error("コピー元の現場が見つかりません");

  const newSite = await createSite({
    name: newName || `${source.name}のコピー`,
    address: source.address,
    clientName: source.clientName,
    startDate: "",
    endDate: "",
    memo: source.memo
  });

  if (copyReports) {
    const reports = await listReportsBySite(sourceSiteId);
    for (const r of reports) {
      // 文字情報のみ複製し、写真・署名はコピーしない（新現場で撮り直す運用）
      await createReport({
        siteId: newSite.id,
        date: r.date,
        weather: r.weather,
        temperature: r.temperature,
        workerCountTotal: r.workerCountTotal,
        companies: r.companies,
        remarks: r.remarks,
        tomorrowPlan: r.tomorrowPlan
      });
    }
  }

  return newSite;
}
