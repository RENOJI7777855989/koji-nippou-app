/* ==========================================================
   Excel向けセルマッピングの純粋ロジック
   "B2"のようなセル参照文字列と帳票用データモデルの値から
   2次元グリッドを組み立て、CSVへ直列化する。
   DOM/IndexedDBに依存しないため、Node単体でテスト可能。

   セル参照⇔行列インデックスの相互変換（cellRefToRowCol /
   rowColToCellRef）は、xlsxTemplateEngine.js（実際の.xlsxバイナリ
   への書き込み）からも共用する、本基盤の共通座標変換ロジック。
   ========================================================== */

import { getFieldValue } from "./fieldPath.js";

export function cellRefToRowCol(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`不正なセル参照です: ${ref}`);
  const [, colLetters, rowDigits] = m;
  let col = 0;
  for (const ch of colLetters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: Number(rowDigits) - 1, col: col - 1 };
}

export function rowColToCellRef(row, col) {
  let n = col + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

function ensureRow(grid, rowIndex) {
  while (grid.length <= rowIndex) grid.push([]);
  return grid[rowIndex];
}

function setCell(grid, ref, value) {
  const { row, col } = cellRefToRowCol(ref);
  const rowArr = ensureRow(grid, row);
  rowArr[col] = value ?? "";
}

/**
 * mapping = {
 *   fields: { "site.name": "B2", "report.date": "B3", ... },
 *   companiesTable: { startCell: "A8", columns: ["name","occupation","plannedWorkerCount","actualWorkerCount","machinery","workContent","safetyNotes"] }
 * }
 */
export function buildCellGrid(model, mapping) {
  const grid = [];

  Object.entries(mapping.fields || {}).forEach(([fieldPath, cellRef]) => {
    setCell(grid, cellRef, getFieldValue(model, fieldPath));
  });

  if (mapping.companiesTable) {
    const { startCell, columns } = mapping.companiesTable;
    const { row: startRow, col: startCol } = cellRefToRowCol(startCell);
    (model.companies || []).forEach((company, i) => {
      const rowArr = ensureRow(grid, startRow + i);
      columns.forEach((colKey, j) => {
        rowArr[startCol + j] = company[colKey] ?? "";
      });
    });
  }

  return grid;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function gridToCsv(grid) {
  return grid.map((row) => (row || []).map(csvEscape).join(",")).join("\r\n");
}
