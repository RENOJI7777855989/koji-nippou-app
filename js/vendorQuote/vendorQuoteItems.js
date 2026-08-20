/* ==========================================================
   業者見積の内訳行データ層
   estimateItems.jsと同じ項目名（category/itemName/spec/quantity/
   unit/unitPrice/amount）で揃え、比較ロジック(compareEstimateToQuote.js)
   を単純にする。項目は取込バッチ(vendorQuoteBatchId)に紐づき、
   現場(siteId)へは直接紐付けて取得を速くする。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew } from "../utils.js";

export async function listVendorQuoteItemsBySite(siteId) {
  const all = await dbGetAll("vendorQuoteItems", "by_siteId", siteId);
  return all.filter((i) => !i.isDeleted).sort((a, b) => (a.sourceRow || 0) - (b.sourceRow || 0));
}

export async function listVendorQuoteItemsByBatch(vendorQuoteBatchId) {
  const all = await dbGetAll("vendorQuoteItems", "by_vendorQuoteBatchId", vendorQuoteBatchId);
  return all.filter((i) => !i.isDeleted).sort((a, b) => (a.sourceRow || 0) - (b.sourceRow || 0));
}

export async function getVendorQuoteItem(id) {
  return dbGet("vendorQuoteItems", id);
}

/**
 * excelEstimateParser.jsのextractEstimateRows()が返した行候補を、
 * まとめてvendorQuoteItemsとして保存する（積算側と同じ変換ロジックを流用）。
 */
export async function createVendorQuoteItems({ siteId, vendorQuoteBatchId, sourceFileName, sourceSheet, rows }) {
  const created = [];
  for (const row of rows) {
    const item = stampNew({
      siteId,
      vendorQuoteBatchId,
      category: row.category || "",
      itemName: row.itemName || "",
      spec: row.spec || "",
      quantity: row.quantity ?? null,
      unit: row.unit || "",
      unitPrice: row.unitPrice ?? null,
      amount: row.amount ?? null,
      sourceFileName,
      sourceSheet,
      sourceRow: row.sourceRow,
      rawRowCells: row.rawRowCells || [],
      needsReview: !!row.needsReview,
      reviewReasons: row.reviewReasons || [],
      memo: ""
    });
    await dbPut("vendorQuoteItems", item);
    created.push(item);
  }
  return created;
}
