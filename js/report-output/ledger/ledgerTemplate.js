/* ==========================================================
   台帳テンプレートの構造解析と「他工事データ除去」
   （出力用の複製だけを対象にする。原本テンプレートは読み取り専用）

   構造は原本から導出する（52行・20頁等をコードに直書きしない）:
     ・様式シート … 台帳名でないシート（例「手書印刷用」）。印刷範囲の行数＝1頁の行数
     ・台帳シート … 名前が「開始日～終了日」（例「1～20」「21～40」）のシート。
       印刷範囲の行数÷1頁の行数＝1シートの頁数。開始日の小さい順に並べる。

   他工事データ除去（sanitize）の規則:
     台帳シートの「数式でない値」は、次のどちらかに当てはまるものだけを
     様式の文言として残し、それ以外（前の工事の業者名・作業内容・工事名・
     日付など手入力されたもの）はすべて値を消す（書式は残す）。
       (a) 様式シートの同じ位置（頁内の行・列）と同じ文言
       (b) そのシートの全頁で、同じ位置に同じ文言が入っている（頁見出しの定型文）
     数式はそのまま残し、表示値（キャッシュ）は呼び出し側で計算し直す。
   ========================================================== */

import { parseDefinedNames, decodeXmlText } from "./workbookPackage.js";
import { parseSharedStringsXml, readSheetCells, mapSheetCells, emptyCellXml, collectSharedStringRefs } from "./sheetCells.js";

const LEDGER_NAME_RE = /^(\d+)([～~〜\-－])(\d+)$/;

function parseAreaRows(formula) {
  // 'シート'!$A$1:$P$1040 → { firstRow:1, lastRow:1040, firstCol:"A", lastCol:"P" }
  const m = /!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(formula || "");
  if (!m) return null;
  return { firstCol: m[1], firstRow: Number(m[2]), lastCol: m[3], lastRow: Number(m[4]) };
}

/**
 * @param {import("./workbookPackage.js").WorkbookPackage} pkg
 * @returns {Promise<null|{
 *   formSheet: {name, path, index},
 *   ledgerSheets: Array<{name, path, index, firstDay, lastDay}>,
 *   separator: string, pageRows: number, pagesPerSheet: number,
 *   firstCol: string, lastCol: string
 * }>} 台帳シートが無い様式ならnull
 */
export async function analyzeLedgerTemplate(pkg) {
  const sheets = await pkg.listSheets();
  const names = parseDefinedNames(await pkg.getText("xl/workbook.xml"));
  const areaOf = (sheet) => parseAreaRows(names.find((d) => d.name === "_xlnm.Print_Area" && d.localSheetId === sheet.index)?.formula);

  const ledger = [];
  for (const sheet of sheets) {
    const m = LEDGER_NAME_RE.exec(sheet.name);
    if (m) ledger.push({ ...sheet, firstDay: Number(m[1]), lastDay: Number(m[3]), separator: m[2] });
  }
  if (ledger.length === 0) return null;
  ledger.sort((a, b) => a.firstDay - b.firstDay);

  const formSheet = sheets.find((s) => !LEDGER_NAME_RE.test(s.name));
  if (!formSheet) throw new Error("台帳テンプレートに様式シート（1日分の用紙）が見つかりません。");
  const formArea = areaOf(formSheet);
  if (!formArea) throw new Error(`様式シート「${formSheet.name}」の印刷範囲が設定されていないため、1頁の行数を判別できません。`);
  const pageRows = formArea.lastRow - formArea.firstRow + 1;

  const first = ledger[0];
  const firstArea = areaOf(first);
  if (!firstArea) throw new Error(`台帳シート「${first.name}」の印刷範囲が設定されていません。`);
  const sheetRows = firstArea.lastRow - firstArea.firstRow + 1;
  if (sheetRows % pageRows !== 0) {
    throw new Error(`台帳シート「${first.name}」の印刷範囲（${sheetRows}行）が1頁の行数（${pageRows}行）の倍数ではありません。`);
  }
  const pagesPerSheet = sheetRows / pageRows;

  ledger.forEach((sheet, i) => {
    if (sheet.lastDay - sheet.firstDay + 1 !== pagesPerSheet) {
      throw new Error(`台帳シート「${sheet.name}」の日数（${sheet.lastDay - sheet.firstDay + 1}日）が1シートの頁数（${pagesPerSheet}頁）と一致しません。`);
    }
    if (sheet.firstDay !== 1 + i * pagesPerSheet) {
      throw new Error(`台帳シート「${sheet.name}」の開始日が連続していません（期待値 ${1 + i * pagesPerSheet}）。`);
    }
  });

  return {
    formSheet,
    ledgerSheets: ledger.map(({ name, path, index, firstDay, lastDay }) => ({ name, path, index, firstDay, lastDay })),
    separator: first.separator,
    pageRows,
    pagesPerSheet,
    firstCol: firstArea.firstCol,
    lastCol: firstArea.lastCol
  };
}

/** 様式シートの「頁内位置→文言」表（値のあるセルだけ） */
export async function readFormLabels(pkg, formSheet, pageRows) {
  const sharedStrings = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
  const cells = readSheetCells(await pkg.getText(formSheet.path), sharedStrings);
  const labels = new Map();
  for (const cell of cells.values()) {
    if (cell.row > pageRows || cell.value == null || cell.value === "") continue;
    labels.set(`${cell.col}${cell.row}`, cell.value);
  }
  return labels;
}

/**
 * 台帳シート1枚から、前の工事で手入力された値を消す（数式・書式・様式の文言は残す）。
 * @returns {{ sheetXml: string, clearedCount: number, cleared: Array<{ref, value}> }}
 */
export function clearLedgerSampleInputs(sheetXml, { sharedStrings, formLabels, pageRows, pagesPerSheet }) {
  const cells = readSheetCells(sheetXml, sharedStrings);

  // (b) 全頁で同じ位置に同じ文言がある＝頁見出しの定型文
  const byPosition = new Map();
  for (const cell of cells.values()) {
    if (cell.formula || cell.value == null || cell.value === "") continue;
    const rel = ((cell.row - 1) % pageRows) + 1;
    const key = `${cell.col}${rel}`;
    if (!byPosition.has(key)) byPosition.set(key, new Map());
    const counts = byPosition.get(key);
    counts.set(cell.value, (counts.get(cell.value) || 0) + 1);
  }
  const repeatedLabel = (key, value) => (byPosition.get(key)?.get(value) || 0) >= pagesPerSheet;

  const cleared = [];
  const next = mapSheetCells(sheetXml, sharedStrings, (cell) => {
    if (cell.formula || cell.value == null || cell.value === "") return undefined;
    const rel = ((cell.row - 1) % pageRows) + 1;
    const key = `${cell.col}${rel}`;
    if (formLabels.get(key) === cell.value) return undefined; // (a)
    if (repeatedLabel(key, cell.value)) return undefined; // (b)
    cleared.push({ ref: `${cell.col}${cell.row}`, value: cell.value });
    return emptyCellXml(cell);
  });
  return { sheetXml: next, clearedCount: cleared.length, cleared };
}

/**
 * ブック全体に残る「このファイルの持ち主・他工事に由来する情報」を出力用の複製から除く。
 *   ・workbook.xmlの保存先パス（absPath）
 *   ・外部ブックへのリンク（社内サーバーのパス）。どのセル・入力規則からも
 *     使われていない場合のみ、リンクとそれを参照する名前定義を外す
 *   ・どのセルからも参照されなくなった共有文字列（前の工事の業者名等）を空にする
 *     （インデックスは詰めないので、残るセルの参照はずれない）
 *   ・calcChain（計算順序キャッシュ）を外し、開いたときに全数式を再計算させる
 *   ・文書のプロパティの作成者・最終更新者・最終印刷日時と、コメントの作成者名（個人名）を空にする
 */
export async function scrubWorkbookResidue(pkg) {
  const report = { removedAbsPath: false, removedExternalLinks: 0, blankedSharedStrings: 0 };

  let workbookXml = await pkg.getText("xl/workbook.xml");
  const withoutAbsPath = workbookXml.replace(/<mc:AlternateContent\b[^>]*>(?:(?!<\/mc:AlternateContent>)[\s\S])*?absPath[\s\S]*?<\/mc:AlternateContent>/, "");
  if (withoutAbsPath !== workbookXml) {
    report.removedAbsPath = true;
    workbookXml = withoutAbsPath;
    pkg.setText("xl/workbook.xml", workbookXml);
  }

  const sheets = await pkg.listSheets();
  const sheetXmls = [];
  for (const sheet of sheets) sheetXmls.push(await pkg.getText(sheet.path));

  // 外部リンク
  const externalRefs = [...workbookXml.matchAll(/<externalReference\b[^>]*r:id="([^"]+)"[^>]*\/>/g)].map((m) => m[1]);
  if (externalRefs.length > 0) {
    const definedNames = parseDefinedNames(workbookXml);
    const externalNames = definedNames.filter((d) => /\[\d+\]/.test(d.formula)).map((d) => d.name);
    const usedInSheets = sheetXmls.some(
      (xml) => /<f\b[^>]*>[^<]*\[\d+\]/.test(xml) || externalNames.some((name) => xml.includes(name))
    );
    const usedInNames = definedNames.some((d) => !/\[\d+\]/.test(d.formula) && externalNames.some((name) => d.formula.includes(name)));
    if (!usedInSheets && !usedInNames) {
      const wbRelsXml = await pkg.getText("xl/_rels/workbook.xml.rels");
      for (const rId of externalRefs) {
        const rel = new RegExp(`<Relationship\\b[^>]*\\sId="${rId}"[^>]*Target="([^"]+)"[^>]*/>`).exec(wbRelsXml);
        if (rel) await pkg.removePartTree(`xl/${rel[1]}`);
      }
      let wbRels = await pkg.getText("xl/_rels/workbook.xml.rels");
      for (const rId of externalRefs) wbRels = wbRels.replace(new RegExp(`<Relationship\\b[^>]*\\sId="${rId}"[^>]*/>`), "");
      pkg.setText("xl/_rels/workbook.xml.rels", wbRels);
      workbookXml = (await pkg.getText("xl/workbook.xml"))
        .replace(/<externalReferences>[\s\S]*?<\/externalReferences>/, "")
        .replace(/<definedName\b[^>]*>([^<]*)<\/definedName>/g, (whole, body) => (/\[\d+\]/.test(decodeXmlText(body)) ? "" : whole));
      pkg.setText("xl/workbook.xml", workbookXml);
      report.removedExternalLinks = externalRefs.length;
    }
  }

  // 参照されなくなった共有文字列を空にする
  const sstXml = await pkg.getText("xl/sharedStrings.xml");
  if (sstXml) {
    const used = new Set();
    let totalRefs = 0;
    for (const sheet of sheets) {
      const xml = await pkg.getText(sheet.path);
      collectSharedStringRefs(xml, used);
      totalRefs += (xml.match(/\st="s"/g) || []).length;
    }
    let index = -1;
    const scrubbed = sstXml.replace(/<si>[\s\S]*?<\/si>|<si\/>/g, (si) => {
      index += 1;
      if (used.has(index) || si === "<si/>" || si === "<si><t></t></si>") return si;
      report.blankedSharedStrings += 1;
      return "<si><t></t></si>";
    });
    const withCount = scrubbed.replace(/(<sst\b[^>]*\scount=")\d+(")/, `$1${totalRefs}$2`);
    if (withCount !== sstXml) pkg.setText("xl/sharedStrings.xml", withCount);
  }

  // 作成者・最終更新者・最終印刷日時（個人名など）とコメントの作成者名を出力に持ち越さない
  const core = await pkg.getText("docProps/core.xml");
  if (core) {
    const cleared = core
      .replace(/<dc:creator>[^<]*<\/dc:creator>/, "<dc:creator></dc:creator>")
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy></cp:lastModifiedBy>")
      .replace(/<cp:lastPrinted>[^<]*<\/cp:lastPrinted>/, "");
    if (cleared !== core) {
      pkg.setText("docProps/core.xml", cleared);
      report.clearedDocumentAuthors = true;
    }
  }
  for (const part of pkg.listParts().filter((p) => /^xl\/comments\d*\.xml$/.test(p))) {
    const xml = await pkg.getText(part);
    const next = xml.replace(/<author>[^<]*<\/author>/g, "<author>テンプレート</author>");
    if (next !== xml) pkg.setText(part, next);
  }

  await pkg.requestFullRecalc();
  return report;
}
