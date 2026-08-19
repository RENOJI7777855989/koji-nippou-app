/* ==========================================================
   積算項目の「出典（元データ）」を確認する機能（Phase5）
   取込バッチに保存された元のExcel/PDFファイル(sourceFileBlob)から、
   該当項目が実際にどう書かれていたかを表示用データとして組み立てる。
   PDFはpdf.jsで該当ページを画像として描画し、Excelは該当行の
   前後だけを切り出したプレビュー表を作る。
   本機能追加前に取り込まれたバッチにはsourceFileBlobが無いため、
   その場合はエラーにせず「元ファイルが保存されていません」を返す。
   ========================================================== */

import { readWorkbook } from "./excelWorkbookReader.js";
import { renderPdfPageImage } from "./pdfWorkbookReader.js";
import { buildPreviewRows } from "./excelEstimateParser.js";

const ROWS_BEFORE_TARGET = 2;
const PREVIEW_ROW_COUNT = 8;

/**
 * @param {{ item: object, batch: object }} params item=estimateItems.js のレコード, batch=estimateBatches.js のレコード
 * @returns {Promise<
 *   { type: "unavailable", reason: string } |
 *   { type: "pdf", imageDataUrl: string, pageLabel: string } |
 *   { type: "excel", sheetName: string, colLetters: string[], rows: object[], highlightRow: number }
 * >}
 */
export async function getItemSourcePreview({ item, batch }) {
  if (!batch || !batch.sourceFileBlob) {
    return { type: "unavailable", reason: "元ファイルが保存されていません（この機能追加前に取り込んだデータの可能性があります）" };
  }

  if (batch.sourceFileType === "pdf") {
    const imageDataUrl = await renderPdfPageImage(batch.sourceFileBlob, item.sourceSheet);
    return { type: "pdf", imageDataUrl, pageLabel: item.sourceSheet };
  }

  const workbook = await readWorkbook(await batch.sourceFileBlob.arrayBuffer());
  const layout = await workbook.readSheet(item.sourceSheet);
  const startRow = Math.max(1, (item.sourceRow || 1) - ROWS_BEFORE_TARGET);
  const { rows, colLetters } = buildPreviewRows(layout, PREVIEW_ROW_COUNT, 20, startRow);
  return { type: "excel", sheetName: item.sourceSheet, colLetters, rows, highlightRow: item.sourceRow };
}
