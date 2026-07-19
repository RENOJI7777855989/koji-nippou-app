/* ==========================================================
   既定Excelレンダラー（rendererId: "default-csv"）
   会社指定のExcel様式が届くまでの暫定実装。マッピング形式
   （フィールドパス→セル参照）はそのままに、出力形式だけを
   将来.xlsxバイナリ生成へ差し替えられるよう設計してある。
   ========================================================== */

import { registerExcelRenderer } from "../rendererRegistry.js";
import { buildCellGrid, gridToCsv } from "../cellGrid.js";

export const DEFAULT_EXCEL_MAPPING = {
  fields: {
    "site.name": "B2",
    "site.clientName": "B3",
    "report.date": "B4",
    "report.weather": "B5",
    "report.temperature": "B6",
    "report.workerCountTotal": "B7"
  },
  companiesTable: {
    startCell: "A9",
    columns: ["name", "occupation", "plannedWorkerCount", "actualWorkerCount", "machinery", "workContent", "safetyNotes"]
  }
};

function render(model, mapping) {
  const grid = buildCellGrid(model, mapping || DEFAULT_EXCEL_MAPPING);
  const csv = gridToCsv(grid);
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const filename = `${model.site.name || "現場"}_${model.report.date || "日付未定"}_日報.csv`;
  return { blob, filename };
}

registerExcelRenderer("default-csv", render);
