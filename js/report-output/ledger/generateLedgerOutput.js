/* ==========================================================
   台帳出力のオーケストレーター（DBから現場・日報・テンプレートを集めて
   renderLedgerWorkbook へ渡す）
   日報データがいつでも元データ。台帳は出力のたびに原本テンプレートの
   複製から作り直すため、前回出力したファイルに依存しない。
   ========================================================== */

import { getSite } from "../../sites.js";
import { listReportsBySite } from "../../reports.js";
import { listSignaturesByReport } from "../../signatures.js";
import { getReportTemplate } from "../reportTemplates.js";
import { buildReportOutputModel } from "../reportDataAdapter.js";
import { renderLedgerWorkbook } from "./renderLedgerWorkbook.js";
import { buildLedgerPrintHtml } from "./ledgerPrintHtml.js";
import { WorkbookPackage } from "./workbookPackage.js";
import { analyzeLedgerTemplate } from "./ledgerTemplate.js";
import { getLayoutProfile } from "../layoutProfiles.js";
import "../layouts/index.js";
import { ANZEN_EISEI_LEDGER_MAPPING } from "../renderers/mappings/anzenEiseiLedger.js";

async function loadInputs(siteId, templateId) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  const template = templateId ? await getReportTemplate(templateId) : null;
  if (!template?.sourceFileBlob) {
    throw new Error("台帳の元になる会社指定Excel様式が見つかりません。テンプレート管理で、台帳シートのある様式（.xlsx）を標準テンプレートとして登録してください。");
  }
  const reports = (await listReportsBySite(siteId)).filter((r) => !r.isDeleted);
  const entries = [];
  for (const report of reports) {
    const signatures = await listSignaturesByReport(report.id);
    const model = buildReportOutputModel({ site, report, signatures });
    entries.push({ date: report.date, model });
  }
  const templateBuffer = await template.sourceFileBlob.arrayBuffer();
  return { site, template, entries, templateBuffer, siteModel: buildReportOutputModel({ site, report: {} }).site };
}

/** 様式に台帳シートがあるか（ボタンの表示判定用。解析できない様式はfalse） */
export async function templateHasLedger(templateId) {
  const template = templateId ? await getReportTemplate(templateId) : null;
  if (!template?.sourceFileBlob) return false;
  try {
    const pkg = await WorkbookPackage.open(await template.sourceFileBlob.arrayBuffer());
    return !!(await analyzeLedgerTemplate(pkg));
  } catch {
    return false;
  }
}

/**
 * @param {{siteId: string, templateId: string}} params
 * @returns {Promise<object>} renderLedgerWorkbook() の結果
 */
export async function generateLedgerWorkbook({ siteId, templateId }) {
  const { template, entries, templateBuffer, siteModel } = await loadInputs(siteId, templateId);
  return renderLedgerWorkbook({
    templateBuffer,
    mapping: template.ledgerMapping || getLayoutProfile(template.layoutId)?.ledgerMapping || ANZEN_EISEI_LEDGER_MAPPING,
    site: siteModel,
    entries
  });
}

/** 台帳の印刷用HTML（台帳Excelを作ってから、そのExcelを頁ごとにHTML化する） */
export async function generateLedgerPrintHtml({ siteId, templateId }) {
  const { template, entries, templateBuffer, siteModel } = await loadInputs(siteId, templateId);
  const ledger = await renderLedgerWorkbook({
    templateBuffer,
    mapping: template.ledgerMapping || getLayoutProfile(template.layoutId)?.ledgerMapping || ANZEN_EISEI_LEDGER_MAPPING,
    site: siteModel,
    entries
  });
  const profile = await analyzeLedgerTemplate(await WorkbookPackage.open(templateBuffer));
  const { html, pageCount } = await buildLedgerPrintHtml({
    ledgerBlob: ledger.blob,
    templateBuffer,
    formSheetName: profile.formSheet.name,
    pageRows: profile.pageRows,
    title: `${siteModel.name} 安全衛生作業打合日誌（台帳 ${ledger.firstDate}〜${ledger.lastDate}）`
  });
  return { ...ledger, html, printPageCount: pageCount };
}
