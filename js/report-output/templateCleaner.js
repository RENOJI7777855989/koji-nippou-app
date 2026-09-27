/* ==========================================================
   「クリーンな標準テンプレート」の作成（前の工事・個人・社内に由来する情報の除去）
   会社から受け取ったExcel様式（例: 03-2）には、前の工事の記入例・社内サーバーの
   パス・作成者名・プリンター名などが残っていることがある。アプリに同梱して公開する
   前に、それらだけを除き、書式・罫線・数式・画像・印刷設定（用紙・向き・余白・
   拡大率・印刷範囲・頁番号）は変えずに残す。

   除去するもの:
     1. 台帳シートの手入力値（工事名・日付・協力会社名・職種・人数・作業内容・指示・
        搬入・時刻・コメント等）。様式シートの同じ位置と同じ文言、または全頁の同じ
        位置に繰り返される定型文だけを残す（clearLedgerSampleInputs）
     2. 数式の表示値（キャッシュ）に残った前の工事名・日付は、数式はそのままに再計算
     3. 保存先パス（absPath）・外部ブックへのリンク・参照されなくなった共有文字列
     4. 作成者名・最終更新者名・最終印刷日時（docProps/core.xml）、コメントの作成者名
     5. プリンターのドライバ情報（printerSettings*.bin。機種名等を含む。用紙・向き等は
        シートのpageSetupに残る）
     6. 作業中の表示状態（スクロール位置・選択セル・開いているシート）
   7. 指定された文言（removeTexts。例: 様式の見出しに入った会社名）を、様式の固定文言から
      取り除く（文字列の該当部分だけを消し、セル・書式・ふりがなの位置は変えない）
   確認するもの: 1日分の様式シートの記入欄（マッピングで書き込む欄）が空であること。
   ========================================================== */

import { WorkbookPackage, parseRelationships, resolvePartPath } from "./ledger/workbookPackage.js";
import { analyzeLedgerTemplate, readFormLabels, clearLedgerSampleInputs, scrubWorkbookResidue } from "./ledger/ledgerTemplate.js";
import { parseSharedStringsXml, readSheetCells } from "./ledger/sheetCells.js";
import { WorkbookCalculator } from "./ledger/formulaCache.js";
import { listLayoutProfiles } from "./layoutProfiles.js";
import "./layouts/index.js";

const COMPANY_FIELD_LABELS = {
  name: "協力会社名",
  occupation: "職種",
  plannedWorkerCount: "人数（予定）",
  actualWorkerCount: "人数（実績）",
  machinery: "使用機械",
  workContent: "作業内容",
  safetyNotes: "作業及び安全に関する指示・注意事項",
  foremanName: "職長名"
};

/** 消したセルが何の欄だったか（マッピングの欄の位置から分類。データ駆動） */
function makeCategorizer(dailyMapping, ledgerMapping) {
  const table = dailyMapping?.companiesTable;
  const startRow = table ? Number(/\d+/.exec(table.startCell)[0]) : null;
  const endRow = table ? startRow + (table.maxRows || 0) - 1 : null;
  const byCol = new Map();
  if (table) {
    for (const [field, def] of Object.entries(table.columns || {})) byCol.set(typeof def === "string" ? def : def.column, COMPANY_FIELD_LABELS[field] || field);
    if (table.signatureColumn) byCol.set(table.signatureColumn, "職長印・サイン欄");
  }
  const single = new Map();
  for (const t of dailyMapping?.templates || []) single.set(t.cell, t.template.includes("site.name") ? "工事名" : t.template.includes("date") ? "日付（打合日・作業日）" : t.template.includes("temperature") ? "気温" : t.template.includes("weather") ? "天候" : "見出し欄");
  // 台帳シートの見出し欄の位置（工事名F2・作業日G4・打合日E4・気温J2・天候J4 など）
  const anchor = ledgerMapping?.anchor;
  if (anchor) {
    single.set(anchor.projectNameCell, "工事名");
    single.set(anchor.workDateCell, "日付（作業日）");
    single.set(anchor.meetingDateCell, "日付（打合日）");
  }
  for (const t of ledgerMapping?.page?.templates || []) single.set(t.cell, t.template.includes("temperature") ? "気温" : t.template.includes("weather") ? "天候" : "見出し欄");
  const patrol = dailyMapping?.patrolChecklist;
  const patrolCells = new Set(Object.values(patrol?.itemCells || {}));
  return (ref, relRow, col) => {
    const key = `${col}${relRow}`;
    if (single.has(key)) return single.get(key);
    if (patrolCells.has(key)) return "巡回点検の状況";
    if (patrol?.commentCell === key) return "巡回点検に対する是正指示（コメント）";
    if (dailyMapping?.staffAttendance && [dailyMapping.staffAttendance.headcountCell, dailyMapping.staffAttendance.cumulativeCell].includes(key)) return "稼働人数";
    if (table && relRow >= startRow && relRow <= endRow && byCol.has(col)) return byCol.get(col);
    return "その他（資材搬入・時刻・余白の書き込みなど）";
  };
}

function utf16Runs(bytes) {
  const text = new TextDecoder("utf-16le").decode(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return [...text.matchAll(/[ -~　-鿿＀-￯]{5,}/g)].map((m) => m[0]);
}

/**
 * @param {ArrayBuffer} buffer 受け取った会社様式（読み取りのみ。変更しない）
 * @param {{ removeTexts?: string[] }} [options] removeTexts: 様式の固定文言から取り除く文言（例: 会社名）
 * @returns {Promise<{ blob: Blob, report: object }>}
 */
export async function createCleanTemplate(buffer, { removeTexts = [] } = {}) {
  const pkg = await WorkbookPackage.open(buffer);
  const sheets = await pkg.listSheets();
  const profile = await analyzeLedgerTemplate(pkg);
  if (!profile) throw new Error("台帳シート（「1～20」のような名前のシート）が見つからないため、台帳テンプレートとして扱えません。");
  const layout = listLayoutProfiles().find((p) => p.detect({ sheetNames: sheets.map((s) => s.name) })) || null;
  const dailyMapping = layout?.dailyMapping || null;
  const categorize = makeCategorizer(dailyMapping, layout?.ledgerMapping || null);
  const report = {
    layoutId: layout?.id || null,
    structure: { sheetNames: sheets.map((s) => s.name), pageRows: profile.pageRows, pagesPerSheet: profile.pagesPerSheet, ledgerSheetCount: profile.ledgerSheets.length },
    clearedByCategory: {},
    clearedSamples: {},
    clearedTotal: 0,
    formulaCacheChanged: 0,
    formulaCells: 0,
    metadata: {},
    formSheetInputCells: [],
    signatureImages: 0
  };

  // 1. 台帳シートの手入力値を消す
  const sharedStrings = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
  const formLabels = await readFormLabels(pkg, profile.formSheet, profile.pageRows);
  for (const sheet of profile.ledgerSheets) {
    const r = clearLedgerSampleInputs(await pkg.getText(sheet.path), { sharedStrings, formLabels, pageRows: profile.pageRows, pagesPerSheet: profile.pagesPerSheet });
    pkg.setText(sheet.path, r.sheetXml);
    for (const c of r.cleared) {
      const m = /^([A-Z]+)(\d+)$/.exec(c.ref);
      const relRow = ((Number(m[2]) - 1) % profile.pageRows) + 1;
      const category = categorize(c.ref, relRow, m[1]);
      report.clearedByCategory[category] = (report.clearedByCategory[category] || 0) + 1;
      (report.clearedSamples[category] ||= new Set()).add(String(c.value).slice(0, 40));
      report.clearedTotal += 1;
    }
  }
  for (const [k, v] of Object.entries(report.clearedSamples)) report.clearedSamples[k] = [...v].slice(0, 12);

  // 1日分の様式シートの記入欄が空であること（記入欄＝マッピングで書き込む欄）
  if (dailyMapping) {
    const formCells = readSheetCells(await pkg.getText(profile.formSheet.path), sharedStrings);
    const inputRefs = new Set();
    const table = dailyMapping.companiesTable;
    if (table) {
      const startRow = Number(/\d+/.exec(table.startCell)[0]);
      const cols = Object.values(table.columns || {}).map((d) => (typeof d === "string" ? d : d.column));
      if (table.signatureColumn) cols.push(table.signatureColumn);
      for (let r = startRow; r < startRow + (table.maxRows || 0); r++) for (const c of cols) inputRefs.add(`${c}${r}`);
    }
    for (const ref of Object.values(dailyMapping.patrolChecklist?.itemCells || {})) inputRefs.add(ref);
    if (dailyMapping.patrolChecklist?.commentCell) inputRefs.add(dailyMapping.patrolChecklist.commentCell);
    if (dailyMapping.staffAttendance?.headcountCell) inputRefs.add(dailyMapping.staffAttendance.headcountCell);
    for (const ref of inputRefs) {
      const cell = formCells.get(ref);
      if (cell && !cell.formula && cell.value != null && cell.value !== "") report.formSheetInputCells.push({ ref, value: String(cell.value).slice(0, 40) });
    }
  }

  // 2. 数式の表示値（キャッシュ）を再計算（数式は変えない）
  const before = new Map();
  for (const sheet of profile.ledgerSheets) before.set(sheet.name, readSheetCells(await pkg.getText(sheet.path), sharedStrings));
  const calculator = new WorkbookCalculator(pkg);
  await calculator.init();
  for (const sheet of profile.ledgerSheets) await calculator.writeCaches(sheet.name);
  report.unsupportedFormulas = calculator.unsupported.length;
  for (const sheet of profile.ledgerSheets) {
    const after = readSheetCells(await pkg.getText(sheet.path), sharedStrings);
    for (const [ref, cell] of after) {
      if (!cell.formula) continue;
      report.formulaCells += 1;
      if ((before.get(sheet.name).get(ref)?.value ?? null) !== (cell.value ?? null)) report.formulaCacheChanged += 1;
    }
  }

  // 除去の前に、外部リンクの参照先・保存先パスを記録しておく（除去の報告と、漏れ検査の材料）
  report.metadata.externalLinkTargets = [];
  for (const part of pkg.listParts().filter((p) => /^xl\/externalLinks\/_rels\/.+\.rels$/.test(p))) {
    for (const m of (await pkg.getText(part)).matchAll(/Target="([^"]+)"/g)) report.metadata.externalLinkTargets.push(decodeURIComponent(m[1]));
  }
  report.metadata.absPath = /absPath url="([^"]*)"/.exec(await pkg.getText("xl/workbook.xml"))?.[1] || "";

  // 3. 保存先パス・外部リンク・参照されない共有文字列（calcChainも外し、開いたとき再計算させる）
  report.residue = await scrubWorkbookResidue(pkg);

  // 4. 作成者・最終更新者・最終印刷、コメントの作成者
  let core = await pkg.getText("docProps/core.xml");
  if (core) {
    report.metadata.creator = /<dc:creator>([^<]*)<\/dc:creator>/.exec(core)?.[1] || "";
    report.metadata.lastModifiedBy = /<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/.exec(core)?.[1] || "";
    report.metadata.lastPrinted = /<cp:lastPrinted>([^<]*)<\/cp:lastPrinted>/.exec(core)?.[1] || "";
    core = core
      .replace(/<dc:creator>[^<]*<\/dc:creator>/, "<dc:creator></dc:creator>")
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy></cp:lastModifiedBy>")
      .replace(/<cp:lastPrinted>[^<]*<\/cp:lastPrinted>/, "");
    pkg.setText("docProps/core.xml", core);
  }
  report.metadata.commentAuthors = [];
  for (const part of pkg.listParts().filter((p) => /^xl\/comments\d*\.xml$/.test(p))) {
    const xml = await pkg.getText(part);
    report.metadata.commentAuthors.push(...[...xml.matchAll(/<author>([^<]*)<\/author>/g)].map((m) => m[1]));
    pkg.setText(part, xml.replace(/<author>[^<]*<\/author>/g, "<author>テンプレート</author>"));
  }

  // 5. プリンターのドライバ情報（用紙サイズ・向き・拡大率はpageSetupの属性に残る）
  report.metadata.printerSettingsRemoved = 0;
  report.metadata.printerModels = new Set();
  for (const sheet of sheets) {
    const relsPath = sheet.path.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels";
    let relsXml = await pkg.getText(relsPath);
    let sheetXml = await pkg.getText(sheet.path);
    for (const rel of parseRelationships(relsXml).filter((r) => r.type.endsWith("/printerSettings"))) {
      const binPath = resolvePartPath(sheet.path, rel.target);
      const bytes = await pkg.getBytes(binPath);
      if (bytes) for (const run of utf16Runs(bytes).slice(0, 2)) report.metadata.printerModels.add(run);
      relsXml = relsXml.replace(rel.xml, "");
      sheetXml = sheetXml.replace(new RegExp(`(<pageSetup\\b[^>]*?)\\sr:id="${rel.id}"`), "$1");
      pkg.remove(binPath);
      report.metadata.printerSettingsRemoved += 1;
    }
    pkg.setText(relsPath, relsXml);
    pkg.setText(sheet.path, sheetXml);
  }
  report.metadata.printerModels = [...report.metadata.printerModels];

  // 6. 作業中の表示状態（スクロール位置・選択セル・開いているシート）
  for (const sheet of sheets) {
    const xml = await pkg.getText(sheet.path);
    const next = xml
      .replace(/(<sheetView\b[^>]*?)\stopLeftCell="[A-Z]+\d+"/, "$1")
      .replace(/<selection\b([^>]*)\/>/g, (w, attrs) => `<selection${attrs.replace(/\sactiveCell="[^"]*"/, ' activeCell="A1"').replace(/\ssqref="[^"]*"/, ' sqref="A1"')}/>`);
    if (next !== xml) pkg.setText(sheet.path, next);
  }
  await pkg.setActiveSheet(profile.formSheet.name);

  // 7. 指定された文言を固定文言から取り除く（共有文字列・インライン文字列・図形のテキスト）
  report.removedTexts = [];
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const encode = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const text of removeTexts.filter(Boolean)) {
    // 文言の直前の区切りの空白（全角・半角）も一緒に消す
    const re = new RegExp(`[ \u3000]*${escapeRe(encode(text))}`, "g");
    const hit = { text, sharedStrings: 0, referencingCells: 0, otherParts: [] };
    const sst = await pkg.getText("xl/sharedStrings.xml");
    const changedIdx = new Set();
    let idx = -1;
    const nextSst = sst.replace(/<si>[\s\S]*?<\/si>|<si\/>/g, (si) => {
      idx += 1;
      // ふりがな（<rPh>）の中は対象外。本文の<t>だけを書き換える
      const body = si.replace(/(<rPh\b[\s\S]*?<\/rPh>)|(<t(?:\s[^>]*)?>)([\s\S]*?)(<\/t>)/g, (w, rph, open, inner, close) => (rph ? rph : open + inner.replace(re, "") + close));
      if (body !== si) changedIdx.add(idx);
      return body;
    });
    if (changedIdx.size) pkg.setText("xl/sharedStrings.xml", nextSst);
    hit.sharedStrings = changedIdx.size;
    for (const s of await pkg.listSheets()) {
      const xml = await pkg.getText(s.path);
      for (const m of xml.matchAll(/<c r="[A-Z]+\d+"[^>]*\st="s"[^>]*><v>(\d+)<\/v><\/c>/g)) if (changedIdx.has(Number(m[1]))) hit.referencingCells += 1;
      const next = xml.replace(/(<is>[\s\S]*?<t(?:\s[^>]*)?>)([\s\S]*?)(<\/t>)/g, (w, a, inner, b) => a + inner.replace(re, "") + b);
      if (next !== xml) { pkg.setText(s.path, next); hit.otherParts.push(s.path); }
    }
    for (const part of pkg.listParts().filter((p) => /^xl\/(drawings\/drawing\d+|comments\d*)\.xml$/.test(p))) {
      const xml = await pkg.getText(part);
      const next = xml.replace(/(<a:t>|<t(?:\s[^>]*)?>)([^<]*)(<\/a:t>|<\/t>)/g, (w, a, inner, b) => a + inner.replace(re, "") + b);
      if (next !== xml) { pkg.setText(part, next); hit.otherParts.push(part); }
    }
    report.removedTexts.push(hit);
  }

  // 署名画像（職長サイン等）が図形に残っていないこと
  for (const part of pkg.listParts().filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p))) {
    report.signatureImages += (((await pkg.getText(part)).match(/foreman-signature|signature/gi)) || []).length;
  }
  return { blob: await pkg.toCompressedBlob(), report };
}
