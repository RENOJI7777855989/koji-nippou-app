/* ==========================================================
   業者見積の内訳行データ層
   estimateItems.jsと同じ項目名（category/itemName/spec/quantity/
   unit/unitPrice/amount）で揃え、比較ロジック(compareEstimateToQuote.js)
   を単純にする。項目は取込バッチ(vendorQuoteBatchId)に紐づき、
   現場(siteId)へは直接紐付けて取得を速くする。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew } from "../utils.js";
import { buildOriginalText, buildVendorLineKeys, detectLumpSum, parsePageNumber } from "./vendorQuoteTrace.js";

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
 *
 * 段階1の追加情報（すべて任意。渡されなくても従来どおり保存でき、追加項目は
 * 既存レコードにも無くてよい＝IndexedDBのスキーマ変更・DBバージョンアップは不要）:
 *   columnMapping … 原文（originalText）を取り出すための列対応
 *   sourceFileSha256 / sourceFileType … 元ファイルの追跡（PDFのみ頁番号を持つ）
 * 数量・単価・金額は行変換で得た値のまま保存し、ここで再計算しない（一式でも同様）。
 */
export async function createVendorQuoteItems({ siteId, vendorQuoteBatchId, sourceFileName, sourceSheet, rows, columnMapping = null, sourceFileSha256 = null, sourceFileType = null }) {
  const created = [];
  const lineKeys = buildVendorLineKeys(rows);
  for (const [index, row] of rows.entries()) {
    const originalText = buildOriginalText(row.rawRowCells, columnMapping);
    const lump = detectLumpSum({ itemName: row.itemName, spec: row.spec, unit: row.unit, quantityText: originalText?.quantity ?? "" });
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
      // --- 段階1: 元ファイルの追跡・原文・再取込用キー・一式の目印 ---
      sourceFileSha256,
      sourcePage: sourceFileType === "pdf" ? parsePageNumber(sourceSheet) : null, // Excel/CSVは印刷頁を持たない
      // PDFには行番号が無いため、推測した番号を「行」として持たない（確実なのは頁だけ）。
      // Excel/CSVは実際のセル行。PDFのページ内の文字行の検出順は sourceLineOrderOnPage に別扱いで残す。
      sourceRowFirst: sourceFileType === "pdf" ? null : row.sourceRow, // 現状の取込は1行=1明細
      sourceRowLast: sourceFileType === "pdf" ? null : row.sourceRow,
      sourceRowBasis: sourceFileType === "pdf" ? "page-only" : "cell",
      sourceLineOrderOnPage: sourceFileType === "pdf" ? row.sourceRow : null, // 検出順（推定）。PDF上の行番号ではない
      lineKey: lineKeys[index],
      originalText,
      isLumpSum: lump.isLumpSum, // 一式の可能性の目印（確定ではない）
      lumpSumReasons: lump.reasons,
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
