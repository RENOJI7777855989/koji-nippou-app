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
  const site = fields.siteId ? await dbGet("sites", fields.siteId) : null;
  if (site?.completedAt) throw new Error("工事完了済みの現場には日報を追加できません（現場の「工事完了を取り消す」で解除できます）");
  const base = {
    siteId: fields.siteId,
    date: fields.date || "",
    weather: fields.weather || "晴れ",
    temperature: fields.temperature || "",
    workerCountTotal: fields.workerCountTotal || "",
    companies: fields.companies || [],
    remarks: fields.remarks || "",
    tomorrowPlan: fields.tomorrowPlan || "",
    siteSupervisorNames: fields.siteSupervisorNames || [],
    patrolInspectorName: fields.patrolInspectorName || "",
    patrolChecklist: fields.patrolChecklist || {},
    patrolComment: fields.patrolComment || "",
    photoIds: fields.photoIds || [],
    signatureIds: fields.signatureIds || [],
    // 現場ダッシュボード・A3「今日の現場シート」用（日誌に入力し、ダッシュボードは表示するだけ）
    //   timeline   … 本日の現場の流れ [{ id, time:"HH:MM", title, kind, status:"plan"|"done", note }]
    //   deliveries … 搬入・搬出 [{ id, direction("in"=搬入/"out"=搬出。無い行は搬入), time, item, quantity, vendor, origin, destination, vehicle, status, note }]
    timeline: fields.timeline || [],
    deliveries: fields.deliveries || [],
    // 進捗率（％、0〜100の整数。未入力は null）。その日の日誌に記録した値で、現場の現在値を上書きする項目ではない
    progressPercent: fields.progressPercent ?? null,
    // 本日の重点指示・作業間の連絡・調整（03-2の同名の欄へ出力。連絡事項 remarks とは別の項目）
    // 日の状態: "work"（通常作業）/"nowork"（作業なし）/"holiday"（休工日）。無い日報は通常作業として扱う
    dayStatus: fields.dayStatus || "work",
    focusInstructions: fields.focusInstructions || "",
    workCoordination: fields.workCoordination || ""
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
  const existing = await dbGet("reports", id);
  if (existing?.finalizedAt) throw new Error("この日報は工事完了により確定済みのため修正できません（現場の「工事完了を取り消す」で確定を解除してください）");
  // 内容を修正した日時（印刷状態の管理用: 印刷後に修正された日報を見分ける）
  const updated = await applyPatch(id, { ...patch, lastEditedAt: new Date().toISOString() });
  await recordChange({ entityType: "report", entityId: id, action: "update", summary: `日報（${updated.date || "日付未設定"}）を更新` });
  return updated;
}

/**
 * 日報の削除は通常操作では行わない（紙を紛失しても再出力できるよう、日報データを元データとして
 * 残し、誤りは「修正」で直す運用）。工事期間中・工事完了後とも、画面からは呼ばれない。
 * データ整理などで本当に必要な場合だけ { force: true } を明示して呼ぶ（論理削除）。
 */
export async function deleteReport(id, { force = false } = {}) {
  if (!force) throw new Error("日報は削除できません。内容に誤りがある場合は修正してください。");
  const updated = await applyPatch(id, { isDeleted: true });
  await recordChange({ entityType: "report", entityId: id, action: "delete", summary: `日報（${updated.date || "日付未設定"}）を削除` });
  return updated;
}

// ================= 印刷状態・出力履歴・確認・確定 =================

export const PRINT_STATUS_LABELS = { unprinted: "未印刷", printed: "印刷済み", reprinted: "再印刷" };

/** 印刷状態（印刷回数から導く。printStatusを持たない従来の日報は未印刷） */
export function getPrintStatus(report) {
  const n = report?.printCount || 0;
  return n === 0 ? "unprinted" : n === 1 ? "printed" : "reprinted";
}

/** 最後に印刷した後に内容が修正されているか（紙が古い内容のままの可能性） */
export function isEditedAfterPrint(report) {
  return !!report?.lastPrintedAt && !!report?.lastEditedAt && report.lastEditedAt > report.lastPrintedAt;
}

/**
 * 出力・印刷の記録。内容（lastEditedAt）は変えない。
 *   kind "excel" | "pdf" … ファイルを出力した（lastOutputAt）
 *   kind "print"         … 紙に印刷した（利用者が印刷できたと確認した場合のみ呼ぶ）
 */
export async function recordReportOutput(id, kind) {
  const existing = await dbGet("reports", id);
  if (!existing) throw new Error("日報が見つかりません");
  const now = new Date().toISOString();
  const history = [...(existing.outputHistory || []), { kind, at: now }].slice(-50);
  const patch = { outputHistory: history };
  if (kind === "print") {
    const printCount = (existing.printCount || 0) + 1;
    patch.printCount = printCount;
    patch.printStatus = printCount === 1 ? "printed" : "reprinted";
    patch.lastPrintedAt = now;
    if (!existing.firstPrintedAt) patch.firstPrintedAt = now;
  } else {
    patch.lastOutputAt = now;
    patch.lastOutputFormat = kind;
  }
  const updated = await applyPatch(id, patch);
  const label = { print: printCountLabel(patch.printCount), excel: "Excel出力", pdf: "PDF出力" }[kind] || kind;
  await recordChange({ entityType: "report", entityId: id, action: "output", summary: `日報（${updated.date || "日付未設定"}）を${label}` });
  return updated;
}

function printCountLabel(count) {
  return count > 1 ? `再印刷（${count}回目）` : "印刷";
}

/** 確認済みにする／解除する（内容を確認したことの記録。内容は変えない） */
export async function setReportConfirmed(id, confirmed) {
  const updated = await applyPatch(id, { confirmedAt: confirmed ? new Date().toISOString() : null });
  await recordChange({ entityType: "report", entityId: id, action: "update", summary: `日報（${updated.date || "日付未設定"}）を${confirmed ? "確認済みに" : "未確認に戻"}しました` });
  return updated;
}

/** 現場の全日報を確定（工事完了時）または確定解除する */
export async function setSiteReportsFinalized(siteId, finalized) {
  const reports = await listReportsBySite(siteId);
  const now = new Date().toISOString();
  for (const r of reports) {
    if (!!r.finalizedAt === finalized) continue;
    await applyPatch(r.id, { finalizedAt: finalized ? now : null });
  }
  return reports.length;
}
