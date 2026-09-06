/* ==========================================================
   見積書マッピング（templates/itemsTable）から
   「どのセルに何を書き込むか」を計算する。
   js/report-output/xlsxCellPlan.jsの明細テーブル(companiesTable)と
   同じ考え方の、見積の明細行（items）向けバージョン。
   セル単位の実書き込み(setCellInSheetXml)・テンプレート文字列展開
   (renderTemplateString)はjs/report-output/xlsxTemplateEngine.js
   （既存・汎用・無変更）をそのまま再利用する。
   ========================================================== */

import { renderTemplateString } from "../report-output/xlsxTemplateEngine.js";

function parseCellRefRow(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`不正なセル参照です: ${ref}`);
  return { row: Number(m[2]) - 1 };
}

/**
 * @returns {{ cellWrites: Array<{cell:string, value:string, numeric:boolean}>, fitToPage: object|null, sheetName: string, warnings: string[] }}
 */
export function buildQuoteCellPlan(model, cfg) {
  const cellWrites = [];
  const warnings = [];

  (cfg.templates || []).forEach(({ cell, template }) => {
    cellWrites.push({ cell, value: renderTemplateString(template, model), numeric: false });
  });

  const table = cfg.itemsTable;
  if (table) {
    const items = model.items || [];
    const maxRows = table.maxRows || items.length;
    if (items.length > maxRows) {
      warnings.push(`見積書テンプレート「${cfg.sheetName}」は${maxRows}行までのため、明細${items.length}件のうち${items.length - maxRows}件が出力されません。`);
    }

    const { row: startRow0 } = parseCellRefRow(table.startCell);
    for (let i = 0; i < Math.min(items.length, maxRows); i++) {
      const item = items[i];
      const rowNum = startRow0 + i + 1;
      for (const [fieldKey, colDef] of Object.entries(table.columns || {})) {
        const colLetter = typeof colDef === "string" ? colDef : colDef.column;
        const numeric = typeof colDef === "object" && !!colDef.numeric;
        const value = item[fieldKey];
        if (value === "" || value == null) continue;
        cellWrites.push({ cell: `${colLetter}${rowNum}`, value, numeric });
      }
    }
  }

  return { cellWrites, fitToPage: cfg.fitToPage || null, sheetName: cfg.sheetName, warnings };
}
