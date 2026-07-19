/* ==========================================================
   日報データ層（現場配下のCRUD）
   削除はisDeletedフラグによる論理削除とする。将来の同期での
   削除伝播に備えるだけでなく、署名済みの日報を誤って完全に
   消さないという運用上の利点もある。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "./db.js";
import { stampNew, stampUpdate } from "./utils.js";
import { recordChange } from "./auditLog.js";

export async function listReportsBySite(siteId) {
  const all = await dbGetAll("reports", "by_siteId", siteId);
  return all
    .filter((r) => !r.isDeleted)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.updatedAt.localeCompare(a.updatedAt));
}

export async function getReport(id) {
  return dbGet("reports", id);
}

export async function createReport(fields) {
  const base = {
    siteId: fields.siteId,
    date: fields.date || "",
    weather: fields.weather || "晴れ",
    temperature: fields.temperature || "",
    workerCountTotal: fields.workerCountTotal || "",
    companies: fields.companies || [],
    remarks: fields.remarks || "",
    tomorrowPlan: fields.tomorrowPlan || "",
    patrolInspectorName: fields.patrolInspectorName || "",
    patrolChecklist: fields.patrolChecklist || {},
    patrolComment: fields.patrolComment || "",
    photoIds: fields.photoIds || [],
    signatureIds: fields.signatureIds || []
  };
  if (fields.id) base.id = fields.id; // 新規作成前に写真/署名を紐付けるため、事前発行IDを許容する
  const report = stampNew(base);
  await dbPut("reports", report);
  await recordChange({ entityType: "report", entityId: report.id, action: "create", summary: `日報（${report.date || "日付未設定"}）を作成` });
  return report;
}

async function applyPatch(id, patch) {
  const existing = await dbGet("reports", id);
  if (!existing) throw new Error("日報が見つかりません");
  const updated = stampUpdate(existing, patch);
  await dbPut("reports", updated);
  return updated;
}

export async function updateReport(id, patch) {
  const updated = await applyPatch(id, patch);
  await recordChange({ entityType: "report", entityId: id, action: "update", summary: `日報（${updated.date || "日付未設定"}）を更新` });
  return updated;
}

export async function deleteReport(id) {
  const updated = await applyPatch(id, { isDeleted: true });
  await recordChange({ entityType: "report", entityId: id, action: "delete", summary: `日報（${updated.date || "日付未設定"}）を削除` });
  return updated;
}
