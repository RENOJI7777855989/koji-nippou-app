/* ==========================================================
   帳票テンプレート（.xlsx）の検査・版の比較（DB・DOM非依存）
   テンプレートを登録・差し替えるときに呼び、
     ・どの様式か（layoutProfilesで判別）
     ・出力に必要なシート・台帳シートがあるか
     ・前の版と比べて、様式の固定文言（ラベル）が変わっていないか
   を調べる。マッピング（セル位置）は前の版のままなので、ラベルが動いていれば
   出力位置がずれる可能性があるため、差し替え前に利用者へ知らせる。
   ========================================================== */

import { WorkbookPackage } from "./ledger/workbookPackage.js";
import { analyzeLedgerTemplate } from "./ledger/ledgerTemplate.js";
import { parseSharedStringsXml, readSheetCells } from "./ledger/sheetCells.js";
import { detectLayoutProfile, getLayoutProfile } from "./layoutProfiles.js";
import "./layouts/index.js";

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{ readable: boolean, layoutId: string|null, layoutLabel: string, sheetNames: string[],
 *   hasLedger: boolean, ledger: object|null, errors: string[], warnings: string[] }>}
 */
export async function inspectTemplate(buffer) {
  const result = { readable: false, layoutId: null, layoutLabel: "", sheetNames: [], hasLedger: false, ledger: null, errors: [], warnings: [] };
  let pkg;
  try {
    pkg = await WorkbookPackage.open(buffer);
    result.sheetNames = (await pkg.listSheets()).map((s) => s.name);
    result.readable = true;
  } catch (e) {
    result.errors.push(`Excelファイル（.xlsx）として読み込めませんでした: ${e.message}`);
    return result;
  }
  const profile = detectLayoutProfile({ sheetNames: result.sheetNames });
  if (!profile) {
    result.warnings.push("登録されている様式（03-2 安全衛生作業打合日誌など）として判別できませんでした。出力は標準の設定（03-2のセル位置）で行うため、様式が違うとセルの位置がずれます。");
    return result;
  }
  result.layoutId = profile.id;
  result.layoutLabel = profile.label;
  if (profile.ledgerMapping) {
    try {
      const ledger = await analyzeLedgerTemplate(pkg);
      if (ledger) {
        result.hasLedger = true;
        result.ledger = { pageRows: ledger.pageRows, pagesPerSheet: ledger.pagesPerSheet, sheetCount: ledger.ledgerSheets.length, days: ledger.ledgerSheets.length * ledger.pagesPerSheet };
      } else {
        result.warnings.push("台帳シート（「1～20」のような名前のシート）が見つかりません。1日ごとの出力は使えますが、工事期間の台帳出力は使えません。");
      }
    } catch (e) {
      result.warnings.push(`台帳シートの構造を判別できません（${e.message}）。台帳出力は使えない可能性があります。`);
    }
  }
  return result;
}

/** 1日分の様式シートの固定文言（記入欄を除く）を「セル→文字列」で返す */
async function readFormLabelMap(buffer, layoutId) {
  const profile = getLayoutProfile(layoutId);
  if (!profile) return null;
  const pkg = await WorkbookPackage.open(buffer);
  const form = (await pkg.listSheets()).find((s) => s.name === profile.dailyMapping.sheetName);
  if (!form) return null;
  const sharedStrings = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
  const cells = readSheetCells(await pkg.getText(form.path), sharedStrings);
  // 業者の記入欄（companiesTableの範囲）は日報の内容が入る欄なので、固定文言の比較から除く
  const table = profile.dailyMapping.companiesTable;
  const startRow = table ? Number(/\d+/.exec(table.startCell)[0]) : Infinity;
  const endRow = table ? startRow + (table.maxRows || 0) - 1 : -1;
  const labels = new Map();
  for (const [ref, cell] of cells) {
    if (cell.formula || cell.value == null || String(cell.value).trim() === "") continue;
    const row = cell.row;
    const inTable = row >= startRow && row <= endRow && /^[A-H]$/.test(cell.col);
    if (inTable) continue;
    labels.set(ref, String(cell.value));
  }
  return labels;
}

/**
 * 差し替え前後の版を比べる。ラベルの追加・削除・変更があれば、出力位置が
 * ずれる可能性があるので警告として返す（自動では判断しない）。
 * @returns {Promise<{ errors: string[], warnings: string[], diffs: Array<{cell, before, after}> }>}
 */
export async function compareTemplateVersions(oldBuffer, newBuffer, layoutId) {
  const out = { errors: [], warnings: [], diffs: [] };
  const [a, b] = await Promise.all([readFormLabelMap(oldBuffer, layoutId), readFormLabelMap(newBuffer, layoutId)]);
  if (!b) {
    out.errors.push("新しいファイルに、出力先の様式シートが見つかりません。");
    return out;
  }
  if (!a) return out;
  for (const [cell, before] of a) {
    const after = b.get(cell);
    if (after !== before) out.diffs.push({ cell, before, after: after ?? "" });
  }
  for (const [cell, after] of b) if (!a.has(cell)) out.diffs.push({ cell, before: "", after });
  if (out.diffs.length > 0) {
    out.warnings.push(`様式の固定文言が前の版から${out.diffs.length}か所変わっています。セルの位置が動いている場合は、出力される位置がずれる可能性があります（差し替え後に出力結果を確認してください）。`);
  }
  return out;
}
