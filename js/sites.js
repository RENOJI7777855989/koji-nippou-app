/* ==========================================================
   現場データ層
   CRUD・コピー・検索/並び替え・アーカイブを担う
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "./db.js";
import { stampNew, stampUpdate } from "./utils.js";
import { listReportsBySite, createReport, setSiteReportsFinalized } from "./reports.js";
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

/**
 * reportTemplateId: この現場だけで使う日報Excel様式のid。null（既定）は「標準テンプレートに従う」
 * （新規現場は原則こちら。標準を差し替えると自動的に追従する）。
 */
export async function createSite({ name, address = "", clientName = "", startDate = "", endDate = "", memo = "", assignedUserIds = [], reportTemplateId = null, constructionNumber = "", progressPercent = null }) {
  // constructionNumber: 工事番号（任意）。progressPercent: 進捗率（0〜100の手入力。未入力はnull＝ダッシュボードでは工期経過率を別表示）
  const site = stampNew({ name, address, clientName, startDate, endDate, memo, status: "active", assignedUserIds, reportTemplateId: reportTemplateId || null, constructionNumber, progressPercent: normalizeProgress(progressPercent) });
  await dbPut("sites", site);
  // 作成した時点の様式（現場の指定→標準→元請名一致）の版に固定する。以後テンプレートを新しい版へ
  // 差し替えても、この現場は自動では切り替わらない。様式が無い・失敗した場合も現場の作成は続ける
  try {
    const { ensureSitePinned } = await import("./report-output/templateResolver.js");
    const pinned = await ensureSitePinned(site);
    if (pinned?.templatePin) site.templatePin = pinned.templatePin;
  } catch (err) {
    console.warn("様式の版を固定できませんでした（最初の出力時にもう一度固定します）", err);
  }
  await recordChange({ entityType: "site", entityId: site.id, action: "create", summary: `現場「${site.name}」を作成` });
  return site;
}

/** 進捗率を0〜100の整数にする（空・不正はnull） */
export function normalizeProgress(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
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
    memo: source.memo,
    reportTemplateId: source.reportTemplateId || null
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

/**
 * 工事完了: 工事期間中の日報をすべて確定（以後は修正不可・閲覧と再出力は可能）し、完了日時を記録する。
 * アーカイブは別操作（archiveSite）。データは削除しない。
 */
export async function completeSite(id) {
  const count = await setSiteReportsFinalized(id, true);
  const updated = await applyPatch(id, { completedAt: new Date().toISOString() });
  await recordChange({ entityType: "site", entityId: id, action: "update", summary: `現場「${updated.name}」を工事完了にし、日報${count}件を確定` });
  return updated;
}

/** 工事完了の取り消し（修正が必要になった場合）。日報の確定も解除する */
export async function reopenSite(id) {
  const count = await setSiteReportsFinalized(id, false);
  const updated = await applyPatch(id, { completedAt: null });
  await recordChange({ entityType: "site", entityId: id, action: "update", summary: `現場「${updated.name}」の工事完了を取り消し、日報${count}件の確定を解除` });
  return updated;
}
