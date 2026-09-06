/* ==========================================================
   業者見積・積算比較モジュールの公開API
   UI層（js/ui/vendor-quote-*-view.js・comparison-view.js）は
   このファイル経由でjs/vendorQuote/配下の機能を利用する。
   ========================================================== */

import { readCsv } from "./csvReader.js";
import { readWorkbook } from "../estimate/excelWorkbookReader.js";
import { readPdf } from "../estimate/pdfWorkbookReader.js";

// 列マッピングUI・行変換ロジックは積算取込(js/estimate/)のものをそのまま流用する
// （業者見積も同じ列マッピング形式のためロジックの重複実装を避ける）。
export { MAPPING_FIELDS, buildPreviewRows, extractEstimateRows } from "../estimate/excelEstimateParser.js";
export {
  listVendorQuoteBatchesBySite,
  getVendorQuoteBatch,
  createVendorQuoteBatch,
  deleteVendorQuoteBatch
} from "./vendorQuoteBatches.js";
export {
  listVendorQuoteItemsBySite,
  listVendorQuoteItemsByBatch,
  getVendorQuoteItem,
  createVendorQuoteItems
} from "./vendorQuoteItems.js";
export { listItemMatchOverridesBySite, setItemMatchOverride } from "./itemMatchOverrides.js";
export { buildItemKey } from "./itemNormalize.js";
export { compareEstimateToQuote, summarizeComparison, DEFAULT_TOLERANCE } from "./compareEstimateToQuote.js";
export { checkOmissions } from "./omissionCheck.js";
export { listOmissionDispositionsBySite, listOmissionDispositionsByBatch, setOmissionDisposition } from "./omissionDispositions.js";
export { exportComparisonCsv, buildComparisonPrintHtml } from "./comparisonExport.js";
export {
  listMasterItems,
  getMasterItem,
  createMasterItem,
  addAliasToMasterItem,
  renameMasterItem,
  deleteMasterItem,
  mergeMasterItems
} from "./masterItems.js";
export { resolveToMaster } from "./itemMasterMatch.js";

/**
 * アップロードされたファイル(.xlsx/.pdf/.csv)の拡張子を見て、
 * Excel/PDF/CSVいずれかのリーダーに振り分ける。既存の積算取込
 * (js/estimate/index.jsのreadEstimateFile)と同じ{sheetNames, readSheet}
 * 形状を返すため、呼び出し側はファイル形式を意識せず扱える。
 * @returns {Promise<{ sourceFileType: "excel"|"pdf"|"csv", sheetNames: string[], readSheet: (name: string) => Promise<object> }>}
 */
export async function readVendorQuoteFile(file) {
  const name = file.name || "";
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

  if (ext === ".pdf") {
    const buffer = await file.arrayBuffer();
    const workbook = await readPdf(buffer);
    return { sourceFileType: "pdf", ...workbook };
  }
  if (ext === ".xlsx") {
    const buffer = await file.arrayBuffer();
    const workbook = await readWorkbook(buffer);
    return { sourceFileType: "excel", ...workbook };
  }
  if (ext === ".csv") {
    const text = await file.text();
    const workbook = await readCsv(text);
    return { sourceFileType: "csv", ...workbook };
  }
  throw new Error("対応していないファイル形式です（.xlsx、.pdf、.csvのいずれかを選択してください）");
}
