/* ==========================================================
   積算項目（内訳行）のデータ層
   工種・項目・仕様・数量・単位・単価・金額・出典・元データを
   保持する。項目は取込バッチ(estimateBatchId)に紐づき、現場
   (siteId)へはバッチ経由ではなく直接紐付けて一覧・検索を速くする。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew } from "../utils.js";

export async function listEstimateItemsBySite(siteId) {
  const all = await dbGetAll("estimateItems", "by_siteId", siteId);
  return all.filter((i) => !i.isDeleted).sort((a, b) => (a.sourceRow || 0) - (b.sourceRow || 0));
}

export async function listEstimateItemsByBatch(estimateBatchId) {
  const all = await dbGetAll("estimateItems", "by_estimateBatchId", estimateBatchId);
  return all.filter((i) => !i.isDeleted).sort((a, b) => (a.sourceRow || 0) - (b.sourceRow || 0));
}

export async function getEstimateItem(id) {
  return dbGet("estimateItems", id);
}

/**
 * excelEstimateParser.jsのextractEstimateRows()が返した行候補を、
 * まとめてestimateItemsとして保存する。
 */
export async function createEstimateItems({ siteId, estimateBatchId, sourceFileName, sourceSheet, rows }) {
  const created = [];
  for (const row of rows) {
    const item = stampNew({
      siteId,
      estimateBatchId,
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
    await dbPut("estimateItems", item);
    created.push(item);
  }
  return created;
}
