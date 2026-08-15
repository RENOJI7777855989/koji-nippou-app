/* ==========================================================
   .xlsxのシート一覧列挙・セル読み取り（積算Excel取込専用）
   ZIP解析はzipUtil.js、シート名→パート解決はreport-output/
   xlsxTemplateEngine.jsのresolveSheetPartPathを再利用し、セル値の
   読み取りはreport-output/xlsxSheetReader.jsをそのまま使う。
   （帳票出力機能が会社PDFの見た目複製のために使っているのと同じ
   自作ZIP/XLSXパーサーを、数値データの読み取りに転用している）
   ========================================================== */

import { loadZip, readZipEntryText } from "../zipUtil.js";
import { parseSharedStrings, readSheetLayout } from "../report-output/xlsxSheetReader.js";
import { resolveSheetPartPath } from "../report-output/xlsxTemplateEngine.js";

function listSheetNames(workbookXml) {
  const names = [];
  const re = /<sheet[^>]*\bname="([^"]+)"/g;
  let m;
  while ((m = re.exec(workbookXml))) names.push(m[1]);
  return names;
}

export function colIndexToLetters(n) {
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * アップロードされた.xlsxのArrayBufferを解析し、シート名一覧と、
 * 任意のシートのセルレイアウトを読み取れるハンドルを返す。
 * @returns {{ sheetNames: string[], readSheet: (sheetName: string) => Promise<object> }}
 */
export async function readWorkbook(arrayBuffer) {
  const zip = loadZip(arrayBuffer);
  const workbookXml = await readZipEntryText(zip, "xl/workbook.xml");
  const workbookRelsXml = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml || !workbookRelsXml) {
    throw new Error("有効な.xlsxファイルとして読み込めませんでした（旧形式の.xlsは非対応です）");
  }

  const sharedStringsXml = await readZipEntryText(zip, "xl/sharedStrings.xml");
  const sharedStrings = parseSharedStrings(sharedStringsXml);

  const sheetNames = listSheetNames(workbookXml);
  if (sheetNames.length === 0) throw new Error("シートが見つかりませんでした");

  return {
    sheetNames,
    async readSheet(sheetName) {
      const sheetPath = resolveSheetPartPath(workbookXml, workbookRelsXml, sheetName);
      const sheetXml = await readZipEntryText(zip, sheetPath);
      if (!sheetXml) throw new Error(`シートの読み込みに失敗しました: ${sheetName}`);
      return readSheetLayout(sheetXml, sharedStrings);
    }
  };
}
