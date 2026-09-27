/* ==========================================================
   日報の出力・印刷・再印刷（紙の紛失に備えた再出力の共通処理）
   日報データ（IndexedDB）を元データとし、会社指定Excel様式の複製への
   書き込み（既存の帳票出力エンジン generateReportOutput）から、Excel・
   印刷用PDF（HTML→ブラウザの印刷/PDF保存）をいつでも作り直す。
   会社指定Excel様式そのもの・出力エンジンは変更しない。

   使う様式: 現場の元請名と同じ名前の会社プロファイルの既定Excel様式
   （帳票出力画面と同じ考え方）。無ければ汎用フォーマット（出力時に明示）。
   印刷用PDFは、会社様式があれば会社様式のレイアウト（A3横等、原本の
   印刷設定をそのまま使う）、無ければアプリ独自のレイアウト。
   ========================================================== */

import { getSite } from "./sites.js";
import { getReport, recordReportOutput } from "./reports.js";
import { generateReportOutput } from "./report-output/generateReportOutput.js";
import { resolveReportTemplateForSite, ensureSitePinned } from "./report-output/templateResolver.js";
import { buildZip } from "./zipUtil.js";
import { generateLedgerWorkbook, generateLedgerPrintHtml } from "./report-output/ledger/generateLedgerOutput.js";

/**
 * 現場に使う会社指定様式（無ければnull）。現場の指定 → 標準テンプレート → 元請名一致の順
 * （templateResolver.js）。戻り値は従来の形（companyProfileId・templateId・templateName・companyName）に
 * 選ばれた理由（source・sourceLabel）と版（revision）を足したもの。
 */
export async function resolveCompanyTemplateForSite(site) {
  return resolveReportTemplateForSite(site);
}

/**
 * 出力に使う様式。固定していない現場はここで今の版に固定してから使う（以後はその版）。
 * 固定した版が見つからない場合は、勝手に別の版で出力せずエラーにする。
 */
async function templateForOutput(site) {
  const pinnedSite = await ensureSitePinned(site);
  const resolved = await resolveReportTemplateForSite(pinnedSite);
  if (resolved?.missing) throw new Error(`${resolved.notice}現場の「日報のExcel様式」から、使う版を選び直してください。`);
  return resolved;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function contextOf(reportId) {
  const report = await getReport(reportId);
  if (!report) throw new Error("日報が見つかりません");
  const site = await getSite(report.siteId);
  const company = await templateForOutput(site);
  return { report, site, company };
}

/** Excel出力（会社指定様式の複製に書き込み）。出力日時を記録する */
export async function exportReportExcel(reportId) {
  const { company } = await contextOf(reportId);
  const result = await generateReportOutput({ reportId, format: "excel", templateId: company?.templateId || null });
  downloadBlob(result.blob, result.filename);
  await recordReportOutput(reportId, "excel");
  return { ...result, usedCompanyTemplate: !!company, company };
}

/** 印刷用HTML（ブラウザの印刷・PDF保存で使う）。記録はしない（印刷・保存したかは利用者の操作で決まるため） */
export async function buildReportPrintHtml(reportId) {
  const { company } = await contextOf(reportId);
  const result = await generateReportOutput(
    company
      ? { reportId, format: "pdf", pdfVariant: "company", templateId: company.templateId }
      : { reportId, format: "pdf", pdfVariant: "original" }
  );
  return { html: result.html, warnings: result.warnings || [], usedCompanyTemplate: !!company, company };
}

/** 複数の印刷用HTML（同じレンダラーで作ったもの）を、1日報1ページで1つの文書にまとめる */
export function combinePrintHtml(htmls, title = "工事日報（まとめて出力）") {
  if (htmls.length === 0) return "";
  const styles = [...htmls[0].matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const bodies = htmls.map((h) => /<body[^>]*>([\s\S]*)<\/body>/.exec(h)?.[1] ?? "");
  const pages = bodies
    .map((b, i) => `<section class="bulk-report-page"${i < bodies.length - 1 ? ' style="break-after: page; page-break-after: always;"' : ""}>${b}</section>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${title.replace(/[<>&]/g, "")}</title><style>${styles}</style></head><body>${pages}</body></html>`;
}

/**
 * 複数日報のExcelを1つのZIPにまとめて出力する（ZIP内のファイル名は日付の英数字のみ。
 * Windowsの標準ZIP展開で日本語ファイル名が文字化けするのを避けるため）。
 */
export async function exportReportsExcelZip(reportIds, zipName) {
  const files = new Map();
  const used = new Set();
  let usedCompanyTemplate = true;
  for (const id of reportIds) {
    const { report, company } = await contextOf(id);
    if (!company) usedCompanyTemplate = false;
    const result = await generateReportOutput({ reportId: id, format: "excel", templateId: company?.templateId || null });
    const ext = /\.(\w+)$/.exec(result.filename)?.[1] || "xlsx";
    let base = `${report.date || "no-date"}`;
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}.${ext}`;
    used.add(name);
    files.set(name, new Uint8Array(await result.blob.arrayBuffer()));
  }
  const zip = buildZip({ buffer: new Uint8Array(0), entries: new Map() }, files, "application/zip");
  downloadBlob(zip, zipName);
  for (const id of reportIds) await recordReportOutput(id, "excel");
  return { count: files.size, usedCompanyTemplate };
}

/** 複数日報の印刷用HTMLをまとめて作る（会社様式の有無は現場で共通） */
export async function buildReportsPrintHtml(reportIds, title) {
  const htmls = [];
  let usedCompanyTemplate = true;
  for (const id of reportIds) {
    const r = await buildReportPrintHtml(id);
    if (!r.usedCompanyTemplate) usedCompanyTemplate = false;
    htmls.push(r.html);
  }
  return { html: combinePrintHtml(htmls, title), usedCompanyTemplate };
}

/* ---------- 工事期間の台帳（1冊）---------- */

async function ledgerContextOf(siteId) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  const company = await templateForOutput(site);
  if (!company) {
    throw new Error("この現場で使う会社指定Excel様式が登録されていないため、台帳を作れません（テンプレート管理で標準テンプレートを登録してください。台帳は様式の台帳シートに書き込みます）。");
  }
  return { site, company };
}

/** 台帳Excel（工事開始日〜終了日の全頁を1冊に）を出力する。日報ごとの出力履歴には記録しない */
export async function exportSiteLedgerExcel(siteId) {
  const { company } = await ledgerContextOf(siteId);
  const result = await generateLedgerWorkbook({ siteId, templateId: company.templateId });
  downloadBlob(result.blob, result.filename);
  return { ...result, company };
}

/** 台帳の印刷用HTML（ブラウザの印刷・PDF保存で使う） */
export async function buildSiteLedgerPrintHtml(siteId) {
  const { company } = await ledgerContextOf(siteId);
  const result = await generateLedgerPrintHtml({ siteId, templateId: company.templateId });
  return { ...result, company };
}
