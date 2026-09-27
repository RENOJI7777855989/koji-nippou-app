/* ==========================================================
   提出内訳の出力設定（現場ごとに1件）のデータ層
   工事名・会社名・使用テンプレート・印刷モードと、出力専用の「区分グループ」
   （号棟／共通仮設費（積上・一般）／現場管理費）の一覧を保持する。積算項目
   （estimateItems）とは独立で、積算側のデータには一切手を加えない。
   ========================================================== */

import { dbGetAll, dbPut } from "../db.js";
import { stampNew, stampUpdate, createId } from "../utils.js";
import { recordChange } from "../auditLog.js";

export const SUBMISSION_GROUP_KIND_LABELS = {
  building: "号棟（直接工事費）",
  common_temp_itemized: "共通仮設費（積上）",
  common_temp_general: "共通仮設費（一般）",
  site_management: "現場管理費"
};

export function newSubmissionGroup({ name, kind }) {
  if (!SUBMISSION_GROUP_KIND_LABELS[kind]) throw new Error(`不正な区分の種類です: ${kind}`);
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("区分グループ名を入力してください");
  // 現場管理費は原本（七里）でも内訳頁を持たない（表紙の1行のみ）ため、既定では内訳頁を作らない
  return { id: createId(), name: trimmed, kind, expand: kind !== "site_management" };
}

export async function getSubmissionPlan(siteId) {
  const all = await dbGetAll("submissionPlans", "by_siteId", siteId);
  return all.find((p) => !p.isDeleted) || null;
}

/** 現場の出力設定を保存する（無ければ作成）。patchに含めたフィールドだけ更新する。 */
export async function saveSubmissionPlan(siteId, patch) {
  const existing = await getSubmissionPlan(siteId);
  if (existing) {
    const updated = stampUpdate(existing, patch);
    await dbPut("submissionPlans", updated);
    await recordChange({ entityType: "submissionPlan", entityId: updated.id, action: "update", summary: "提出内訳の出力設定を更新" });
    return updated;
  }
  const created = stampNew({
    siteId,
    projectTitle: "",
    companyNameOverride: "",
    templateId: null,
    printMode: "original",
    allowUnassigned: false,
    groups: [],
    ...patch
  });
  await dbPut("submissionPlans", created);
  await recordChange({ entityType: "submissionPlan", entityId: created.id, action: "create", summary: "提出内訳の出力設定を作成" });
  return created;
}
