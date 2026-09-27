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

/**
 * 同じ現場に、同一ファイル（SHA-256）・同一シート／頁の取込がすでにあれば返す（重複取込の防止用）。
 * 同じファイルでもシートが違えば別の取込として許す（複数シートの見積を1枚ずつ取り込む使い方を妨げない）。
 * SHA-256を持たない従来の取込は判定対象外。新しい索引は使わず、現場の取込一覧から探す。
 */
export async function findDuplicateVendorQuoteBatch({ siteId, sourceFileSha256, sheetName }) {
  if (!sourceFileSha256) return null;
  const batches = await listVendorQuoteBatchesBySite(siteId);
  return batches.find((b) => b.sourceFileSha256 === sourceFileSha256 && b.sheetName === sheetName) || null;
}

/**
 * 別版の候補: 同じ現場・同じ業者名（空でない）・別のSHA-256の取込のうち最新のもの。無ければnull。
 * 前の版として扱うかどうかは、取込時にユーザーが確認する（自動では決めない）。
 */
export async function findPreviousVersionCandidate({ siteId, vendorName, sourceFileSha256 }) {
  const name = (vendorName || "").trim();
  if (!name) return null;
  const batches = await listVendorQuoteBatchesBySite(siteId);
  return batches.find((b) => (b.vendorName || "").trim() === name && b.sourceFileSha256 !== sourceFileSha256) || null;
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
  sourceFileSha256 = null, // 元ファイルのSHA-256（同一ファイル・同一シートの重複取込の判定に使う）
  revisionOf = null, // 前の版の取込ID（内容が変わった見積を別版として取り込んだ場合）
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
    sourceFileSha256,
    revisionOf,
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
