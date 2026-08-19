/* ==========================================================
   積算Excelの行データ→estimateItems候補への変換ロジック
   列マッピング（項目名→列文字）とデータ開始行をもとに、
   readWorkbook().readSheet()が返すセルレイアウトから行を切り出す。
   会社ごとに積算書のレイアウトが違うため、列マッピングは固定せず
   取込のたびにプレビューを見ながらユーザーが指定する前提。
   数値化できない値は取込を止めず「要確認」フラグを立てて先へ進める
   （取り漏れを防ぐことを優先する）。
   ========================================================== */

import { colIndexToLetters } from "./excelWorkbookReader.js";

export const MAPPING_FIELDS = [
  { key: "category", label: "工種" },
  { key: "itemName", label: "項目" },
  { key: "spec", label: "仕様" },
  { key: "quantity", label: "数量" },
  { key: "unit", label: "単位" },
  { key: "unitPrice", label: "単価" },
  { key: "amount", label: "金額" }
];

const NUMERIC_FIELDS = ["quantity", "unitPrice", "amount"];

function cellText(layout, colLetter, row) {
  if (!colLetter) return "";
  return layout.cells.get(`${colLetter}${row}`)?.text ?? "";
}

/** 全角数字・カンマ・円記号・空白を許容して数値化する。空欄はnull、数値化できない値は失敗として返す */
function parseNumericText(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { value: null, failed: false };
  const halfWidth = raw.replace(/[０-９．－]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const cleaned = halfWidth.replace(/[,，\s円¥]/g, "");
  if (cleaned === "" || cleaned === "-") return { value: null, failed: false };
  const n = Number(cleaned);
  if (Number.isNaN(n)) return { value: null, failed: true };
  return { value: n, failed: false };
}

/**
 * プレビュー表示用: 指定行から最大maxRows行分を「列文字→テキスト」のマップとして返す。
 * startRowを省略すると先頭行からになる（取込時の列マッピングUI向け既定動作）。
 * 出典データの該当行を前後数行だけ見せたい場合はstartRowを指定する。
 */
export function buildPreviewRows(layout, maxRows = 15, maxCols = 20, startRow = 1) {
  const lastCol = Math.min(layout.maxCol, maxCols);
  const firstRow = Math.max(1, startRow);
  const lastRow = Math.min(layout.maxRow, firstRow + maxRows - 1);
  const colLetters = Array.from({ length: lastCol }, (_, i) => colIndexToLetters(i + 1));
  const rows = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const cells = {};
    colLetters.forEach((letter) => {
      cells[letter] = cellText(layout, letter, r);
    });
    rows.push({ rowNumber: r, cells });
  }
  return { rows, colLetters };
}

/**
 * 列マッピング・データ開始行に従い、シート全体をestimateItems候補配列へ変換する。
 * @param {object} layout readWorkbook().readSheet()の戻り値
 * @param {Object<string,string>} columnMapping 例: { category: "B", itemName: "C", quantity: "E", ... }
 * @param {number} dataStartRow データが始まる行番号
 * @returns {{ items: object[], skippedEmptyRows: number }}
 */
export function extractEstimateRows(layout, columnMapping, dataStartRow) {
  const items = [];
  let skippedEmptyRows = 0;

  for (let r = dataStartRow; r <= layout.maxRow; r++) {
    const fields = {};
    let hasAnyValue = false;
    for (const { key } of MAPPING_FIELDS) {
      const text = cellText(layout, columnMapping[key], r);
      if (text !== "") hasAnyValue = true;
      fields[key] = text;
    }

    if (!hasAnyValue) {
      skippedEmptyRows++;
      continue;
    }

    const rawRowCells = [];
    for (let c = 1; c <= layout.maxCol; c++) {
      rawRowCells.push(cellText(layout, colIndexToLetters(c), r));
    }

    const numericValues = {};
    const reviewReasons = [];
    for (const key of NUMERIC_FIELDS) {
      const { value, failed } = parseNumericText(fields[key]);
      numericValues[key] = value;
      if (failed) {
        reviewReasons.push(`${MAPPING_FIELDS.find((f) => f.key === key).label}を数値として読み取れませんでした（"${fields[key]}"）`);
      }
    }
    if (!fields.itemName.trim()) reviewReasons.push("項目名が空です");

    items.push({
      category: fields.category.trim(),
      itemName: fields.itemName.trim(),
      spec: fields.spec.trim(),
      quantity: numericValues.quantity,
      unit: fields.unit.trim(),
      unitPrice: numericValues.unitPrice,
      amount: numericValues.amount,
      sourceRow: r,
      rawRowCells,
      needsReview: reviewReasons.length > 0,
      reviewReasons
    });
  }

  return { items, skippedEmptyRows };
}
