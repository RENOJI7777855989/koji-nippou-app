/* ==========================================================
   提出金額内訳書のExcel（.xlsx）生成（DB非依存）
   テンプレート（会社指定の原本.xlsxのバイト列）を複製し、シートXMLの
   データ部分だけを再構築して新しい.xlsxを作る。原本のバイト列そのもの
   は読み取り専用で、書き換えるのは新しいZIPに詰め直した複製の
   1パート（対象シート）だけ。それ以外のパート（styles.xml・テーマ・
   sharedStrings・印刷設定・docProps等）は原本の圧縮バイト列のまま
   コピーされる（zipUtil.buildZipの仕様）。
   ========================================================== */

import { loadZip, readZipEntryText, buildZip } from "../zipUtil.js";
import { resolveSheetPartPath } from "../report-output/xlsxTemplateEngine.js";
import { analyzeSubmissionTemplate } from "./templateProfile.js";
import { buildSubmissionPages } from "./pageBuilder.js";
import { buildSubmissionSheetXml } from "./sheetXmlWriter.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function readSheetParts(templateBuffer, sheetName) {
  const zip = loadZip(templateBuffer);
  const workbookXml = await readZipEntryText(zip, "xl/workbook.xml");
  const relsXml = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new Error("Excelファイルとして読み込めませんでした（workbook.xmlがありません）");
  const name = sheetName ?? /<sheet name="([^"]+)"/.exec(workbookXml)?.[1];
  if (!name) throw new Error("シートが見つかりません");
  const decodedName = name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const sheetPath = resolveSheetPartPath(workbookXml, relsXml, name);
  const sheetXml = await readZipEntryText(zip, sheetPath);
  const sharedStringsXml = await readZipEntryText(zip, "xl/sharedStrings.xml");
  return { zip, sheetPath, sheetXml, sharedStringsXml, sheetName: decodedName };
}

/** 会社様式.xlsxを解析してプロファイルを返す（テンプレート登録時に1度だけ呼ぶ） */
export async function analyzeSubmissionTemplateFile(templateBuffer) {
  const { sheetXml, sharedStringsXml, sheetName } = await readSheetParts(templateBuffer);
  return analyzeSubmissionTemplate({ sheetXml, sharedStringsXml, sheetName });
}

/**
 * @param {object} params
 * @param {ArrayBuffer} params.templateBuffer 原本.xlsxのバイト列（複製元。変更されない）
 * @param {object} params.profile analyzeSubmissionTemplateFile()のprofile
 * @param {object} params.model buildSubmissionModel()の戻り値
 * @param {string} params.projectTitle 各頁に印字する工事名
 * @param {string} [params.companyName] 各頁に印字する会社名（省略時は原本のまま）
 * @param {"original"|"fit"} [params.printMode]
 * @returns {Promise<{ blob: Blob, pageCount: number, scheduleCount: number, continuationPageCount: number, printScale: number|null, pages: object[] }>}
 */
export async function renderSubmissionWorkbook({ templateBuffer, profile, model, projectTitle, companyName, printMode = "original" }) {
  const { zip, sheetPath, sheetXml } = await readSheetParts(templateBuffer, profile.sheetName);
  const built = buildSubmissionPages(model, profile);
  const result = buildSubmissionSheetXml({
    templateSheetXml: sheetXml,
    profile,
    pages: built.pages,
    projectTitle,
    companyName,
    printMode
  });
  const blob = buildZip(zip, new Map([[sheetPath, new TextEncoder().encode(result.sheetXml)]]), XLSX_MIME);
  return {
    blob,
    pageCount: result.pageCount,
    scheduleCount: built.scheduleCount,
    continuationPageCount: built.continuationPageCount,
    printScale: result.printScale,
    pages: built.pages
  };
}
