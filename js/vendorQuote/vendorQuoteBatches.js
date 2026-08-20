/* ==========================================================
   業者見積取込バッチのデータ層
   1回の業者見積アップロード＝1バッチ。estimateBatches.jsと同じ
   考え方（現場に対して複数の業者・複数回の見積を履歴として残す）。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";
import { listVendorQuoteItemsByBatch } from "./vendorQuoteItems.js";

export async function listVendorQuoteBatchesBySite(siteId) {
  const all = await dbGetAll("vendorQuoteBatches", "by_siteId", siteId);
  return all.filter((b) => !b.isDeleted).sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));
}

export async function getVendorQuoteBatch(id) {
  return dbGet("vendorQuoteBatches", id);
}

export async function createVendorQuoteBatch({
  siteId,
  vendorName,
  quoteNumber = "",
  quoteDate = "",
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
    vendorName,
    quoteNumber,
    quoteDate,
    sourceFileName,
    sourceFileType, // "excel" | "pdf" | "csv"
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
  await dbPut("vendorQuoteBatches", batch);
  await recordChange({
    entityType: "vendorQuoteBatch",
    entityId: batch.id,
    action: "create",
    summary: `業者見積取込「${vendorName || "業者名未入力"}／${sourceFileName}」（${itemCount}件）を登録`
  });
  return batch;
}

export async function deleteVendorQuoteBatch(id) {
  const existing = await dbGet("vendorQuoteBatches", id);
  if (!existing) throw new Error("取込データが見つかりません");

  const items = await listVendorQuoteItemsByBatch(id);
  for (const item of items) {
    await dbPut("vendorQuoteItems", stampUpdate(item, { isDeleted: true }));
  }

  const updated = stampUpdate(existing, { isDeleted: true });
  await dbPut("vendorQuoteBatches", updated);
  await recordChange({
    entityType: "vendorQuoteBatch",
    entityId: id,
    action: "delete",
    summary: `業者見積取込「${existing.vendorName || "業者名未入力"}／${existing.sourceFileName}」（${items.length}件）を削除`
  });
  return updated;
}
