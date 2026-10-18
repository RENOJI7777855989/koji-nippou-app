/* ==========================================================
   変更履歴（監査ログ）データ層
   現場・工事日報・帳票テンプレート・ユーザーへの主要な変更を、
   「誰が・いつ・何を・どうしたか」の形で記録する。
   ========================================================== */

import { dbGetAll, dbPut } from "./db.js";
import { stampNew } from "./utils.js";
import { getCurrentUser } from "./currentUser.js";

/** 変更履歴の1件を作る（保存はしない。ほかの書き込みと同じトランザクションで保存するときに使う） */
export function buildChangeEntry({ entityType, entityId, action, summary }) {
  const user = getCurrentUser();
  return stampNew({
    entityType,
    entityId,
    action, // "create" | "update" | "delete" | "archive" | "unarchive" 等
    summary,
    at: new Date().toISOString(),
    userId: user?.id || "",
    userName: user?.displayName || user?.username || "（不明なユーザー）"
  });
}

export async function recordChange({ entityType, entityId, action, summary }) {
  const entry = buildChangeEntry({ entityType, entityId, action, summary });
  await dbPut("auditLog", entry);
  return entry;
}

export async function listAuditLog({ entityType, limit } = {}) {
  const all = entityType
    ? await dbGetAll("auditLog", "by_entityType", entityType)
    : await dbGetAll("auditLog");
  const sorted = all.sort((a, b) => b.at.localeCompare(a.at));
  return limit ? sorted.slice(0, limit) : sorted;
}
