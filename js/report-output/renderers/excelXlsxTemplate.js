/* ==========================================================
   実xlsxテンプレートへ差し込むExcelレンダラー（rendererId: "xlsx-template-patch"）
   会社ごとにアップロードされた.xlsxファイル（reportTemplates.sourceFileBlob）を
   そのままベースとして読み込み、マッピングで指定されたセルだけを書き換えた
   「新しいExcelファイル」を生成する。元ファイルを消去・上書きすることはなく、
   ロゴ・罫線・書式・他シートなど、マッピング対象外の部分は一切変更しない。

   マッピング（フィールド→セル）はreportTemplatesレコードのmappingフィールド
   （データ）に持たせる。別会社の様式へ差し替える場合は、新しい.xlsxファイルと
   新しいmappingを登録するだけでよく、このファイルのコード変更は不要。

   「どのセルに何を書き込むか」の計算自体はxlsxCellPlan.jsに集約している
   （companyPdfFromXlsx.jsのPDF-HTML化と共有し、Excel出力とPDF出力で
   セル割り当てがずれないようにするため）。このファイルは、そのプランを
   実際の.xlsxのZIP/XMLへ書き込む処理だけを担う。
   ========================================================== */

import { registerExcelRenderer } from "../rendererRegistry.js";
import { loadZip, readZipEntryText, buildZip } from "../../zipUtil.js";
import {
  setCellInSheetXml,
  appendImageAnchorToDrawingXml,
  appendRelationship,
  ensureDefaultContentType,
  resolveSheetPartPath,
  estimateCellExtentEmu,
  setSheetFitToPage
} from "../xlsxTemplateEngine.js";
import { cellRefToRowCol, rowColToCellRef } from "../cellGrid.js";
import { buildXlsxCellPlan } from "../xlsxCellPlan.js";
import { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING } from "./mappings/anzenEiseiUchiawaseNisshi.js";

function letterToColIndex(letter) {
  return cellRefToRowCol(`${letter}1`).col;
}

async function loadSheetDrawingParts(zip, sheetPath) {
  const sheetRelsPath = sheetPath.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels";
  const sheetRelsXml = await readZipEntryText(zip, sheetRelsPath);
  if (!sheetRelsXml) {
    throw new Error("このシートには図形パート(drawing)が無いため、画像（職長サイン）を貼り付けられません。");
  }
  const m = sheetRelsXml.match(/Target="([^"]*drawings\/(drawing\d+\.xml))"/);
  if (!m) {
    throw new Error("このシートには図形パート(drawing)が無いため、画像（職長サイン）を貼り付けられません。");
  }
  const drawingPath = `xl/drawings/${m[2]}`;
  const drawingRelsPath = `xl/drawings/_rels/${m[2]}.rels`;
  const drawingXml = await readZipEntryText(zip, drawingPath);
  const drawingRelsXml = (await readZipEntryText(zip, drawingRelsPath)) ||
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  return { drawingPath, drawingRelsPath, drawingXml, drawingRelsXml };
}

async function render(model, mapping, companyProfile, template) {
  const cfg = mapping || ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING;
  if (!template?.sourceFileBlob) {
    throw new Error("このテンプレートには元になる.xlsxファイルが登録されていません。テンプレート管理画面からファイルを登録してください。");
  }

  const zip = loadZip(await template.sourceFileBlob.arrayBuffer());

  const workbookXml = await readZipEntryText(zip, "xl/workbook.xml");
  const workbookRelsXml = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
  const sheetPath = resolveSheetPartPath(workbookXml, workbookRelsXml, cfg.sheetName);

  let sheetXml = await readZipEntryText(zip, sheetPath);

  const plan = buildXlsxCellPlan(model, cfg);

  plan.cellWrites.forEach(({ cell, value, numeric }) => {
    sheetXml = setCellInSheetXml(sheetXml, cell, value, { numeric });
  });

  const modifications = new Map();

  if (plan.images.length) {
    let drawingParts = null; // 画像を貼る必要が生じた時点で遅延読み込みする
    let nextImageIndex = 1;

    for (const { cell, blob, company } of plan.images) {
      if (!drawingParts) drawingParts = await loadSheetDrawingParts(zip, sheetPath);

      const imageBytes = new Uint8Array(await blob.arrayBuffer());
      const mediaName = `xl/media/reportSignature${nextImageIndex}.png`;
      const relId = `rIdReportSignature${nextImageIndex}`;
      nextImageIndex += 1;

      modifications.set(mediaName, imageBytes);
      drawingParts.drawingRelsXml = appendRelationship(drawingParts.drawingRelsXml, {
        id: relId,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
        target: `../media/${mediaName.split("/").pop()}`
      });

      // アンカーはセル参照文字列で指定する。1行1列分（対象セルちょうど）の
      // 矩形にするため、from/toとも0始まり行列インデックスで明示的に計算する。
      const { row: fromRowIndex, col: fromColIndex } = cellRefToRowCol(cell);
      const fromRef = rowColToCellRef(fromRowIndex, fromColIndex);
      const toRef = rowColToCellRef(fromRowIndex + 1, fromColIndex + 1);
      const colLetter = cell.match(/^[A-Z]+/)[0];
      const rowNum = fromRowIndex + 1;
      const extentEmu = estimateCellExtentEmu(sheetXml, colLetter, rowNum);
      drawingParts.drawingXml = appendImageAnchorToDrawingXml(drawingParts.drawingXml, {
        fromCellRef: fromRef,
        toCellRef: toRef,
        relationshipId: relId,
        shapeId: 9000 + nextImageIndex,
        shapeName: `foreman-signature-${company.id || nextImageIndex}`,
        extentEmu
      });
    }

    if (drawingParts) {
      let contentTypesXml = await readZipEntryText(zip, "[Content_Types].xml");
      contentTypesXml = ensureDefaultContentType(contentTypesXml, "png", "image/png");
      modifications.set("[Content_Types].xml", new TextEncoder().encode(contentTypesXml));
      modifications.set(drawingParts.drawingPath, new TextEncoder().encode(drawingParts.drawingXml));
      modifications.set(drawingParts.drawingRelsPath, new TextEncoder().encode(drawingParts.drawingRelsXml));
    }
  }

  // 「1ページに収める」拡大縮小印刷。ユーザーの明示的な許可により追加した唯一の
  // 印刷設定変更で、mappingでfitToPageを指定したテンプレートにのみ適用される
  // （セル・行高さ・列幅・結合・余白等は一切変更しない）。
  if (plan.fitToPage) {
    sheetXml = setSheetFitToPage(sheetXml, plan.fitToPage === true ? {} : plan.fitToPage);
  }

  modifications.set(sheetPath, new TextEncoder().encode(sheetXml));

  const blob = buildZip(zip, modifications, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const filename = `${model.site.name || "現場"}_${model.report.date || "日付未定"}_日報.xlsx`;
  return { blob, filename, warnings: plan.warnings };
}

registerExcelRenderer("xlsx-template-patch", render);
