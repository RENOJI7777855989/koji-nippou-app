/* ==========================================================
   積算取込バッチのデータ層
   1回のExcel取込＝1バッチ。再取込しても過去バッチは残るため、
   現場に対して複数回の取込履歴を見比べられる。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";
import { listEstimateItemsByBatch } from "./estimateItems.js";

export async function listEstimateBatchesBySite(siteId) {
  const all = await dbGetAll("estimateBatches", "by_siteId", siteId);
  return all.filter((b) => !b.isDeleted).sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));
}

export async function getEstimateBatch(id) {
  return dbGet("estimateBatches", id);
}

export async function createEstimateBatch({
  siteId,
  sourceFileName,
  sourceFileType = "excel",
  sourceFileBlob = null,
  sourceFileMimeType = "",
  sheetName,
  columnMapping,
  headerRow,
  itemCount,
  memo = ""
}) {
  const batch = stampNew({
    siteId,
    sourceFileName,
    sourceFileType, // "excel" | "pdf"
    // 出典ページ表示（Phase5）のため、アップロードされた元ファイルをそのまま保持する。
    // 本機能追加前に取り込んだ既存バッチにはこのフィールドが無く、閲覧時はその旨を案内する。
    sourceFileBlob,
    sourceFileMimeType,
    sheetName,
    columnMapping,
    headerRow,
    importedAt: new Date().toISOString(),
    itemCount,
    status: "active",
    memo
  });
  await dbPut("estimateBatches", batch);
  await recordChange({
    entityType: "estimateBatch",
    entityId: batch.id,
    action: "create",
    summary: `積算取込「${sourceFileName}」（${sheetName}／${itemCount}件）を登録`
  });
  return batch;
}

export async function deleteEstimateBatch(id) {
  const existing = await dbGet("estimateBatches", id);
  if (!existing) throw new Error("取込データが見つかりません");

  const items = await listEstimateItemsByBatch(id);
  for (const item of items) {
    await dbPut("estimateItems", stampUpdate(item, { isDeleted: true }));
  }

  const updated = stampUpdate(existing, { isDeleted: true });
  await dbPut("estimateBatches", updated);
  await recordChange({
    entityType: "estimateBatch",
    entityId: id,
    action: "delete",
    summary: `積算取込「${existing.sourceFileName}」（${items.length}件）を削除`
  });
  return updated;
}
