/* ==========================================================
   日報データ層（現場配下のCRUD）
   削除はisDeletedフラグによる論理削除とする。将来の同期での
   削除伝播に備えるだけでなく、署名済みの日報を誤って完全に
   消さないという運用上の利点もある。
   ========================================================== */

import { dbGetAll, dbGet, dbPut, dbPutMany } from "./db.js";
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
    // 天気: 渡されなかったときだけ従来どおり「晴れ」。空（未選択）を渡したら空のまま保存する（推測しない）
    weather: fields.weather ?? "晴れ",
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
    // 日の状態: "work"（通常作業）/"nowork"（現場作業なし）/"holiday"（休工日）/"rain"（雨天作業不可日）/"office"（事務作業日）。無い日報は通常作業として扱う
    dayStatus: fields.dayStatus || "work",
    focusInstructions: fields.focusInstructions || "",
    workCoordination: fields.workCoordination || "",
    // 監督・職員の稼働人数（現場作業員とは別系統。未入力は null、0人は 0）と作業内容。03-2には書かない。請求人工ではない
    staffCount: fields.staffCount ?? null,
    staffWork: fields.staffWork || "",
    // 雨天作業不可日（dayStatus "rain"）の記録: 中止となった予定作業・雨天による中止理由・状況
    rainCancelledWork: fields.rainCancelledWork || "",
    rainReason: fields.rainReason || ""
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
 * 日報の削除（データ整理用。{ force: true } を明示したときだけ。写真・署名は触らない）。
 * 画面からの削除は deleteReportWithAttachments を使う。
 */
export async function deleteReport(id, { force = false } = {}) {
  if (!force) throw new Error("日報は削除できません。内容に誤りがある場合は修正してください。");
  const updated = await applyPatch(id, { isDeleted: true });
  await recordChange({ entityType: "report", entityId: id, action: "delete", summary: `日報（${updated.date || "日付未設定"}）を削除` });
  return updated;
}

/**
 * 日報1件を削除する（日報の画面の「この日報を削除」。誤登録・同じ日の重複登録の整理用。2026-10-03）。
 * ・その日報だけを削除する（日付単位・自動の重複削除・統合はしない）。流れ・搬入搬出・業者・人数・作業時間・進捗率・天気・
 *   巡回点検・監督/職員・雨天作業不可日・連絡事項などは日報レコードの中にあるので、日報と一緒に削除される。
 * ・写真・署名は別の保存場所で、1件ずつ reportId でこの日報1件だけに属する（現場のコピーでも複製しない・他の日報と共有しない）。
 *   この日報の写真・署名だけを一緒に削除済みにする（孤立させない）。他の日報の写真・署名は触らない。
 * ・削除はこれまでどおり削除済みの印（isDeleted・deletedAt）を付ける方式（論理削除）。日報・写真・署名を1つの
 *   トランザクションで書き、途中で失敗したらどれも変わらない。画面・出力・集計は削除済みを読まない。
 * ・工事完了で確定した日報・工事完了の現場の日報は削除できない（確定を解除してから）。
 * @returns {Promise<{report: object, photos: number, signatures: number}>}
 */
export async function deleteReportWithAttachments(id) {
  const existing = await dbGet("reports", id);
  if (!existing || existing.isDeleted) throw new Error("日報が見つかりません（すでに削除されている可能性があります）。");
  if (existing.finalizedAt) throw new Error("この日報は工事完了により確定済みのため削除できません（現場の「工事完了を取り消す」で確定を解除してください）。");
  const site = existing.siteId ? await dbGet("sites", existing.siteId) : null;
  if (site?.completedAt) throw new Error("工事完了済みの現場の日報は削除できません（現場の「工事完了を取り消す」で解除できます）。");
  const deletedAt = new Date().toISOString();
  const photos = (await dbGetAll("photos", "by_reportId", id)).filter((p) => p.reportId === id && !p.isDeleted);
  const signatures = (await dbGetAll("signatures", "by_reportId", id)).filter((s) => s.reportId === id && !s.isDeleted);
  const report = stampUpdate(existing, { isDeleted: true, deletedAt });
  await dbPutMany([
    { store: "reports", value: report },
    ...photos.map((p) => ({ store: "photos", value: stampUpdate(p, { isDeleted: true, deletedAt }) })),
    ...signatures.map((s) => ({ store: "signatures", value: stampUpdate(s, { isDeleted: true, deletedAt }) }))
  ]);
  await recordChange({ entityType: "report", entityId: id, action: "delete", summary: `日報（${existing.date || "日付未設定"}）を削除（写真${photos.length}枚・署名${signatures.length}件も削除）` });
  return { report, photos: photos.length, signatures: signatures.length };
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
