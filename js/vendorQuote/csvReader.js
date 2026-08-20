/* ==========================================================
   CSV用リーダー（業者見積の取込専用）
   excelWorkbookReader.js/pdfWorkbookReader.jsと同じ
   {sheetNames, readSheet} → {maxRow, maxCol, cells: Map} という
   形状を返すことで、既存の列マッピングUI・extractEstimateRows()に
   そのまま接続できるようにする。CSVは単一表のため、sheetNamesは
   固定で1件（"CSV"）だけを返す。
   厳密なRFC4180全対応は行わず、Excelから書き出す一般的なUTF-8 CSV
   （ダブルクォート囲み・""エスケープ・引用符内の改行）を想定した
   基本的なパースのみ行う。
   ========================================================== */

import { colIndexToLetters } from "../estimate/excelWorkbookReader.js";

const SHEET_NAME = "CSV";

/** ダブルクォート・カンマ・改行を考慮した最小限のCSVパーサー */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // BOM除去

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function buildLayout(rows) {
  const maxRow = rows.length;
  const maxCol = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const cells = new Map();
  rows.forEach((cols, rIdx) => {
    cols.forEach((text, cIdx) => {
      if (text === "") return;
      const ref = `${colIndexToLetters(cIdx + 1)}${rIdx + 1}`;
      cells.set(ref, { text });
    });
  });
  return { maxRow, maxCol, cells };
}

/**
 * アップロードされたCSVファイルのテキストを解析し、readWorkbook()/readPdf()と
 * 同じ{sheetNames, readSheet}形状のハンドルを返す。
 * @returns {Promise<{ sheetNames: string[], readSheet: (name: string) => Promise<object> }>}
 */
export async function readCsv(text) {
  const rows = parseCsvText(text);
  if (rows.length === 0) throw new Error("このCSVには読み取れる行がありません");
  const layout = buildLayout(rows);

  return {
    sheetNames: [SHEET_NAME],
    async readSheet() {
      return layout;
    }
  };
}
