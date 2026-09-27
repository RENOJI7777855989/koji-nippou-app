/* ==========================================================
   1日1ファイル出力（手書印刷用シートへの差し込み）の他工事データ除去
   アプリが書き込むのは様式シート1枚だけなので、出力用の複製からは
   それ以外のシート（前の工事の記入例が残る台帳シート等）を外す。
   ただし、書き込むシートの数式が参照しているシートは残す（#REF!防止）。
   そのうえでブック全体の残留情報（保存先パス・外部リンク・参照されない
   共有文字列）を除く。原本テンプレートは変更しない（複製のみ対象）。
   ========================================================== */

import { scrubWorkbookResidue } from "./ledgerTemplate.js";

function referencedSheetNames(sheetXml, candidates) {
  const formulas = [...sheetXml.matchAll(/<f\b[^>]*>([^<]*)<\/f>/g)].map((m) => m[1]).join("\n");
  return new Set(candidates.filter((name) => formulas.includes(`${name}!`) || formulas.includes(`'${name.replace(/'/g, "''")}'!`)));
}

/**
 * @param {import("./workbookPackage.js").WorkbookPackage} pkg
 * @param {string} keepSheetName 差し込み対象のシート名
 * @returns {Promise<{removedSheets: string[], residue: object}>}
 */
export async function sanitizeSingleSheetOutput(pkg, keepSheetName) {
  const sheets = await pkg.listSheets();
  const keep = sheets.find((s) => s.name === keepSheetName);
  if (!keep) throw new Error(`シートが見つかりません: ${keepSheetName}`);

  const others = sheets.filter((s) => s.name !== keepSheetName).map((s) => s.name);
  const needed = new Set([keepSheetName]);
  // 参照の連鎖をたどる（残すシートが参照するシートも残す）
  const queue = [keepSheetName];
  while (queue.length) {
    const name = queue.shift();
    const xml = await pkg.getText(sheets.find((s) => s.name === name).path);
    for (const ref of referencedSheetNames(xml, others)) {
      if (!needed.has(ref)) {
        needed.add(ref);
        queue.push(ref);
      }
    }
  }

  const removedSheets = [];
  for (const sheet of [...sheets].reverse()) {
    if (needed.has(sheet.name)) continue;
    await pkg.removeSheet(sheet.name);
    removedSheets.push(sheet.name);
  }
  await pkg.setActiveSheet(keepSheetName);
  const residue = await scrubWorkbookResidue(pkg);
  return { removedSheets: removedSheets.reverse(), residue };
}
