/* ==========================================================
   見積書出力の既定レンダラー（rendererId: "quote-default-csv"）
   会社指定の見積書Excel様式が届くまでの暫定実装。実ファイル受領後は
   js/report-output/renderers/excelXlsxTemplate.jsと同じ技法（実.xlsx
   への直接セルパッチ）で本実装に差し替える想定で、マッピング形式
   （itemsTable等）自体はそのときもそのまま使えるように設計してある。
   js/report-output/cellGrid.jsのgridToCsv（既存・汎用・無変更）を
   使い、明細行を単純なCSVとして書き出すだけの薄い実装。
   ========================================================== */

import { registerExcelRenderer } from "../../report-output/rendererRegistry.js";
import { gridToCsv } from "../../report-output/cellGrid.js";

export const DEFAULT_QUOTE_MAPPING = {
  sheetName: "見積書",
  header: ["共通項目コード", "工種", "項目", "仕様", "単位", "積算数量", "積算単価", "積算金額", "見積数量", "見積単価", "見積金額", "判定"]
};

function render(model) {
  const grid = [
    [`見積書（${model.site.name || "現場名未設定"}）`],
    [`業者名: ${model.vendorBatch.vendorName || ""}`, `見積番号: ${model.vendorBatch.quoteNumber || ""}`, `見積日: ${model.vendorBatch.quoteDate || ""}`],
    [],
    DEFAULT_QUOTE_MAPPING.header,
    ...model.items.map((item) => [
      item.masterItemCode, item.category, item.itemName, item.spec, item.unit,
      item.estimateQuantity, item.estimateUnitPrice, item.estimateAmount,
      item.vendorQuantity, item.vendorUnitPrice, item.vendorAmount,
      item.judgement
    ]),
    [],
    ["積算総額", model.summary.estimateTotalAmount, "見積総額", model.summary.vendorTotalAmount, "差額", model.summary.diffAmount]
  ];

  const csv = gridToCsv(grid);
  const bom = "﻿"; // Excelで文字化けしないようUTF-8 BOMを付与
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
  const filename = `${model.site.name || "現場"}_${model.vendorBatch.vendorName || "業者"}_見積書.csv`;
  return { blob, filename, warnings: [] };
}

registerExcelRenderer("quote-default-csv", render);
