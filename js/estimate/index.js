/* ==========================================================
   積算モジュールの公開API
   UI層（js/ui/estimate-*-view.js）はこのファイル経由で
   js/estimate/配下の機能を利用する。
   ========================================================== */

import { readWorkbook } from "./excelWorkbookReader.js";
import { readPdf } from "./pdfWorkbookReader.js";

export { MAPPING_FIELDS, buildPreviewRows, extractEstimateRows } from "./excelEstimateParser.js";
export { listEstimateBatchesBySite, getEstimateBatch, createEstimateBatch, deleteEstimateBatch } from "./estimateBatches.js";
export { listEstimateItemsBySite, listEstimateItemsByBatch, getEstimateItem, createEstimateItems } from "./estimateItems.js";

/**
 * アップロードされたファイル(.xlsx/.pdf)の拡張子を見て、Excel/PDFいずれかの
 * リーダーに振り分ける。どちらも同じ{sheetNames, readSheet}形状を返すため、
 * 呼び出し側(js/ui/estimate-import-view.js)はファイル形式を意識せず扱える。
 * @returns {Promise<{ sourceFileType: "excel"|"pdf", sheetNames: string[], readSheet: (name: string) => Promise<object> }>}
 */
export async function readEstimateFile(file) {
  const name = file.name || "";
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const buffer = await file.arrayBuffer();

  if (ext === ".pdf") {
    const workbook = await readPdf(buffer);
    return { sourceFileType: "pdf", ...workbook };
  }
  if (ext === ".xlsx") {
    const workbook = await readWorkbook(buffer);
    return { sourceFileType: "excel", ...workbook };
  }
  throw new Error("対応していないファイル形式です（.xlsxまたは.pdfを選択してください）");
}
