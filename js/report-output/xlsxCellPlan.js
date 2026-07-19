/* ==========================================================
   マッピング（templates/companiesTable/patrolChecklist）から
   「どのセルに何を書き込むか」を計算する共通ロジック。
   Excelバイナリへの書き込み(excelXlsxTemplate.js)とPDF-HTML化
   (companyPdfFromXlsx.js)の両方がこの計画（プラン）を消費する。
   セル位置の解釈をここ1箇所に集約することで、Excel出力とPDF出力の
   セル割り当てがずれることを防ぐ。
   ========================================================== */

import { renderTemplateString } from "./xlsxTemplateEngine.js";

/**
 * @returns {{
 *   cellWrites: Array<{cell: string, value: string, numeric: boolean}>,
 *   images: Array<{cell: string, blob: Blob, company: object}>,
 *   fitToPage: object|null,
 *   sheetName: string,
 *   warnings: string[]
 * }}
 */
export function buildXlsxCellPlan(model, cfg) {
  const cellWrites = [];
  const images = [];
  const warnings = [];

  (cfg.templates || []).forEach(({ cell, template }) => {
    cellWrites.push({ cell, value: renderTemplateString(template, model), numeric: false });
  });

  const table = cfg.companiesTable;
  if (table) {
    const companies = model.companies || [];
    const maxRows = table.maxRows || companies.length;
    const rowStep = table.rowStep || 1;
    const maxCompanies = Math.floor((maxRows - 1) / rowStep) + 1;
    if (companies.length > maxCompanies) {
      const overflowMsg = `帳票テンプレート「${cfg.sheetName}」は${maxCompanies}社までのため、業者${companies.length}件のうち${companies.length - maxCompanies}件が出力されません。`;
      console.warn(overflowMsg);
      warnings.push(overflowMsg);
    }

    const { row: startRow0 } = parseCellRefRow(table.startCell);

    for (let i = 0; i < Math.min(companies.length, maxCompanies); i++) {
      const company = companies[i];
      const rowNum = startRow0 + i * rowStep + 1;

      for (const [fieldKey, colDef] of Object.entries(table.columns || {})) {
        const colLetter = typeof colDef === "string" ? colDef : colDef.column;
        const numeric = typeof colDef === "object" && !!colDef.numeric;
        const value = company[fieldKey];
        if (value === "" || value == null) continue;
        cellWrites.push({ cell: `${colLetter}${rowNum}`, value, numeric });
      }

      if (table.signatureColumn && company.signature?.blob) {
        images.push({ cell: `${table.signatureColumn}${rowNum}`, blob: company.signature.blob, company });
      }
    }
  }

  const patrolChecklist = cfg.patrolChecklist;
  if (patrolChecklist) {
    const marks = {
      good: patrolChecklist.goodMark ?? "○",
      bad: patrolChecklist.badMark ?? "×",
      na: patrolChecklist.naMark ?? "－"
    };
    const answers = model.report.patrolChecklist || {};
    for (const [itemKey, cellRef] of Object.entries(patrolChecklist.itemCells || {})) {
      const mark = marks[answers[itemKey]];
      if (!mark) continue;
      cellWrites.push({ cell: cellRef, value: mark, numeric: false });
    }
    if (patrolChecklist.commentCell && model.report.patrolComment) {
      cellWrites.push({ cell: patrolChecklist.commentCell, value: model.report.patrolComment, numeric: false });
    }
  }

  return { cellWrites, images, fitToPage: cfg.fitToPage || null, sheetName: cfg.sheetName, warnings };
}

function parseCellRefRow(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`不正なセル参照です: ${ref}`);
  return { row: Number(m[2]) - 1 };
}
