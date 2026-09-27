/* ==========================================================
   提出内訳の区分割当（積算項目1件につき最大1件）のデータ層
   「この積算項目は、どの区分グループ・工種・種別に出力するか」を、積算項目
   のIDで参照して保存する。名称・数量・単価・金額は持たない（積算側の値を
   出力時に参照するだけで、二重管理しない）。note（備考）だけは出力専用の
   情報として、割当側に持つ。
   ========================================================== */

import { dbGetAll, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";

export async function listSubmissionAssignments(siteId) {
  const all = await dbGetAll("submissionAssignments", "by_siteId", siteId);
  return all.filter((a) => !a.isDeleted);
}

async function findByItemId(estimateItemId) {
  const all = await dbGetAll("submissionAssignments", "by_estimateItemId", estimateItemId);
  return all[0] || null; // 削除済みも含めて再利用する（1項目1レコード）
}

/**
 * 複数の積算項目を、同じ区分グループ・工種・種別へまとめて割り当てる。
 * 既に割当がある項目は上書き（備考は維持）。表示順（order）は積算項目の元の行番号。
 * @param {object[]} items 割り当てる積算項目（estimateItems、sourceRow付き）
 */
export async function assignItems(siteId, items, { groupId, workType = "", subType = "" }) {
  if (!groupId) throw new Error("区分グループを選択してください");
  if (subType.trim() && !workType.trim()) throw new Error("種別を指定する場合は工種も指定してください");
  for (const item of items) {
    const existing = await findByItemId(item.id);
    // 画面からの割当は「手動」。Excel取込で作った割当（origin: "import"）を手動で直した場合も、以後は手動として扱い、再取込で上書きしない
    const fields = { siteId, estimateItemId: item.id, groupId, workType: workType.trim(), subType: subType.trim(), order: item.sourceRow ?? 0, origin: "manual", importLineKey: null };
    if (existing) await dbPut("submissionAssignments", stampUpdate(existing, { ...fields, isDeleted: false }));
    else await dbPut("submissionAssignments", stampNew({ ...fields, note: "" }));
  }
  await recordChange({ entityType: "submissionAssignment", entityId: siteId, action: "update", summary: `提出内訳の区分を${items.length}件割当` });
}

export async function setAssignmentNote(estimateItemId, note) {
  const existing = await findByItemId(estimateItemId);
  if (!existing || existing.isDeleted) throw new Error("割当がありません");
  // 備考を手で直した割当も「手動」扱いにする（再取込で備考・区分を上書きしない）
  await dbPut("submissionAssignments", stampUpdate(existing, { note: String(note ?? ""), origin: "manual", importLineKey: null }));
}

/** 積算項目に対する現在の割当（削除済みは除く）。無ければnull */
export async function getAssignmentByItem(estimateItemId) {
  const existing = await findByItemId(estimateItemId);
  return existing && !existing.isDeleted ? existing : null;
}

/**
 * Excel取込用の割当の作成・更新（1項目1レコード）。origin="import"を付ける。
 * 手動割当を上書きするかどうかの判断は呼び出し側（submissionImports.applyImport）が行う。
 */
export async function upsertImportAssignment(siteId, estimateItemId, { groupId, workType, subType, order, note, importLineKey }) {
  const existing = await findByItemId(estimateItemId);
  const fields = { siteId, estimateItemId, groupId, workType, subType, order, note: note ?? "", origin: "import", importLineKey };
  if (existing) return dbPut("submissionAssignments", stampUpdate(existing, { ...fields, isDeleted: false }));
  return dbPut("submissionAssignments", stampNew(fields));
}

export async function unassignItems(siteId, itemIds) {
  for (const id of itemIds) {
    const existing = await findByItemId(id);
    if (existing && !existing.isDeleted) await dbPut("submissionAssignments", stampUpdate(existing, { isDeleted: true }));
  }
  await recordChange({ entityType: "submissionAssignment", entityId: siteId, action: "update", summary: `提出内訳の区分割当を${itemIds.length}件解除` });
}
