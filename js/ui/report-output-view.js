/* ==========================================================
   帳票出力画面
   現場一覧（ホーム画面）と日報編集画面の両方から遷移できる、
   Excel（会社指定様式）・PDF（印刷）出力の操作画面。
   実際の生成処理はjs/report-output/generateReportOutput.jsを
   そのまま呼び出すだけで、レイアウト解釈やレンダラーはここには
   一切持たない（画面はオーケストレーターを呼ぶだけの薄い層）。
   ========================================================== */

import { listSites, getSite } from "../sites.js";
import { listReportsBySite, getReport, recordReportOutput, getPrintStatus, PRINT_STATUS_LABELS } from "../reports.js";
import { listReportTemplates, listCompanyProfiles, generateReportOutput, resolveReportTemplateForSite } from "../report-output/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { waitFrameLoaded, printFrame, canSharePrintFile, sharePrintHtml, downloadPrintHtml, PRINT_NOT_OPENED_MESSAGE, PRINT_NOT_OPENED_MESSAGE_NO_SHARE } from "../printSupport.js";
import { navigate } from "../router.js";

const siteSelect = document.getElementById("outputSiteSelect");
const reportSelect = document.getElementById("outputReportSelect");
const noReportMsg = document.getElementById("outputNoReportMessage");
const confirmBox = document.getElementById("outputSiteConfirm");
const formatSelect = document.getElementById("outputFormatSelect");
const templateWrap = document.getElementById("outputTemplateWrap");
const templateSelect = document.getElementById("outputTemplateSelect");
const pdfVariantWrap = document.getElementById("outputPdfVariantWrap");
const pdfVariantRadios = document.querySelectorAll('input[name="pdfVariant"]');
const previewBtn = document.getElementById("outputPreviewBtn");
const generateBtn = document.getElementById("outputGenerateBtn");
const printBtn = document.getElementById("outputPrintBtn");
const printShareBtn = document.getElementById("outputPrintShareBtn");
let previewHtml = ""; // 共有メニューから印刷するときに渡す印刷用HTML
const previewArea = document.getElementById("outputPreviewArea");
const previewText = document.getElementById("outputPreviewText");
const previewFrame = document.getElementById("outputPreviewFrame");
const backBtn = document.getElementById("backFromReportOutputBtn");
const printedRecordBtn = document.getElementById("outputPrintedRecordBtn");

// 現場の元請名(自由記述)と一致する会社プロファイルのid。オリジナルPDFの
// ロゴ・印影表示に使う（会社指定様式Excel/PDFは.xlsxテンプレート自体に
// レイアウトが含まれるため対象外）。populateTemplates()で更新する。
let matchedCompanyProfileId = null;

async function populateSites(selectedSiteId) {
  const sites = await listSites({ includeArchived: true });
  siteSelect.innerHTML = sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
  if (selectedSiteId && sites.some((s) => s.id === selectedSiteId)) {
    siteSelect.value = selectedSiteId;
  }
}

async function populateReports(siteId, selectedReportId) {
  if (!siteId) {
    reportSelect.innerHTML = "";
    reportSelect.disabled = true;
    noReportMsg.hidden = true;
    return [];
  }
  const reports = await listReportsBySite(siteId);
  reportSelect.innerHTML = reports
    .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.date || "日付未設定")}（${escapeHtml(r.weather || "")}）</option>`)
    .join("");
  noReportMsg.hidden = reports.length > 0;
  reportSelect.disabled = reports.length === 0;
  if (selectedReportId && reports.some((r) => r.id === selectedReportId)) {
    reportSelect.value = selectedReportId;
  }
  return reports;
}

/** 現場に使う様式（現場の指定 → 標準テンプレート → 元請名と同じ会社の既定）を初期選択する */
async function populateTemplates(site) {
  const [templates, companies] = await Promise.all([listReportTemplates({ format: "excel", templateKind: "report" }), listCompanyProfiles()]);
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

  const options = [`<option value="">汎用フォーマット（会社様式が無い場合の簡易出力）</option>`].concat(
    templates.map((t) => {
      const companyName = companyNameById.get(t.companyProfileId) || "会社未設定";
      return `<option value="${escapeHtml(t.id)}">${escapeHtml(companyName)} - ${escapeHtml(t.name)}${t.isAppDefault ? "（標準）" : t.isDefault ? "（使用中）" : ""}</option>`;
    })
  );
  templateSelect.innerHTML = options.join("");

  const resolved = site ? await resolveReportTemplateForSite(site) : null;
  matchedCompanyProfileId = resolved?.companyProfileId || null;
  if (resolved?.templateId && !templates.some((t) => t.id === resolved.templateId)) {
    // この現場が固定している過去の版（一覧には現在の版だけが出るため追加する）
    templateSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(resolved.templateId)}">${escapeHtml(resolved.templateName)} 第${resolved.revision}版（この現場に固定した版）</option>`);
  }
  if (resolved?.templateId) templateSelect.value = resolved.templateId;
}

async function renderConfirm() {
  const siteId = siteSelect.value;
  const reportId = reportSelect.value;
  if (!siteId || !reportId) {
    confirmBox.hidden = true;
    return null;
  }
  const [site, report] = await Promise.all([getSite(siteId), getReport(reportId)]);
  if (!site || !report) {
    confirmBox.hidden = true;
    return null;
  }
  confirmBox.hidden = false;
  confirmBox.innerHTML = `
    <p><strong>出力対象現場:</strong> ${escapeHtml(site.name)}（元請: ${escapeHtml(site.clientName) || "-"}）</p>
    <p><strong>出力対象日:</strong> ${escapeHtml(report.date || "日付未設定")}</p>
  `;
  return { site, report };
}

function resetPreview() {
  previewArea.hidden = true;
  previewText.hidden = true;
  previewFrame.hidden = true;
  previewFrame.removeAttribute("srcdoc");
  printBtn.hidden = true;
  printShareBtn.hidden = true;
  previewHtml = "";
  printedRecordBtn.hidden = true;
}

function getSelectedPdfVariant() {
  return Array.from(pdfVariantRadios).find((r) => r.checked)?.value || "original";
}

function updateFormatUi() {
  const isPdf = formatSelect.value === "pdf";
  pdfVariantWrap.hidden = !isPdf;
  const isCompanyPdf = isPdf && getSelectedPdfVariant() === "company";
  templateWrap.hidden = !(formatSelect.value === "excel" || isCompanyPdf);
  resetPreview();
}

siteSelect.addEventListener("change", async () => {
  await populateReports(siteSelect.value);
  const confirmed = await renderConfirm();
  await populateTemplates(confirmed?.site);
  resetPreview();
});
reportSelect.addEventListener("change", async () => {
  await renderConfirm();
  resetPreview();
});
formatSelect.addEventListener("change", updateFormatUi);
pdfVariantRadios.forEach((radio) => radio.addEventListener("change", updateFormatUi));
backBtn.addEventListener("click", () => navigate("/sites"));

function buildExcelTextPreview(site, report) {
  const lines = [
    `工事名: ${site.name || ""}`,
    `元請名: ${site.clientName || ""}`,
    `日付: ${report.date || ""}`,
    `天気: ${report.weather || ""} ${report.temperature ? `${report.temperature}℃` : ""}`,
    `作業人数（合計）: ${report.workerCountTotal || ""}`,
    "",
    "【協力会社】"
  ];
  const companies = report.companies || [];
  if (companies.length === 0) lines.push("（記載なし）");
  companies.forEach((c, i) => {
    lines.push(
      `${i + 1}. ${c.companyName || "(未入力)"} / 職種:${c.occupation || "-"} / 予定:${c.plannedWorkerCount || "-"} 実績:${c.actualWorkerCount || "-"} / 職長:${c.foremanName || "-"}`
    );
  });
  lines.push("", `明日の予定: ${report.tomorrowPlan || ""}`, `備考: ${report.remarks || ""}`);
  return lines.join("\n");
}

async function showPdfPreview(reportId) {
  const pdfVariant = getSelectedPdfVariant();
  const templateId = pdfVariant === "company" ? templateSelect.value || null : null;
  // オリジナルPDFのみ、現場の元請名から一致した会社プロファイルのロゴ・印影を反映する
  // （会社指定様式は.xlsxテンプレート自体にレイアウトが含まれるため対象外）
  const companyProfileId = pdfVariant === "company" ? null : matchedCompanyProfileId;
  const { html, warnings } = await generateReportOutput({ reportId, format: "pdf", pdfVariant, templateId, companyProfileId });
  previewText.hidden = true;
  previewFrame.hidden = false;
  previewFrame.srcdoc = html;
  previewArea.hidden = false;
  printBtn.hidden = false;
  previewHtml = html;
  printShareBtn.hidden = false;
  printShareBtn.textContent = canSharePrintFile() ? "共有メニューから印刷" : "印刷用ファイルを保存";
  return { html, warnings: warnings || [] };
}

previewBtn.addEventListener("click", async () => {
  const siteId = siteSelect.value;
  const reportId = reportSelect.value;
  if (!siteId || !reportId) {
    showMessage("出力対象の現場と日報を選択してください。", true);
    return;
  }
  try {
    if (formatSelect.value === "pdf") {
      const { warnings } = await showPdfPreview(reportId);
      if (warnings.length) showMessage(warnings.join(" "), true);
    } else {
      const [site, report] = await Promise.all([getSite(siteId), getReport(reportId)]);
      previewText.hidden = false;
      previewFrame.hidden = true;
      previewText.textContent = buildExcelTextPreview(site, report);
      previewArea.hidden = false;
      printBtn.hidden = true;
      printShareBtn.hidden = true;
    }
  } catch (err) {
    showMessage(`プレビューの生成に失敗しました: ${err.message}`, true);
  }
});

generateBtn.addEventListener("click", async () => {
  const siteId = siteSelect.value;
  const reportId = reportSelect.value;
  if (!siteId || !reportId) {
    showMessage("出力対象の現場と日報を選択してください。", true);
    return;
  }
  const format = formatSelect.value;
  generateBtn.disabled = true;
  try {
    if (format === "excel") {
      const templateId = templateSelect.value || null;
      const { blob, filename, warnings } = await generateReportOutput({ reportId, format: "excel", templateId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await recordReportOutput(reportId, "excel");
      const warningSuffix = warnings?.length ? ` ／ 注意: ${warnings.join(" ")}` : "";
      showMessage(`Excelを出力しました（${filename}）${warningSuffix}`, !!warningSuffix);
    } else {
      const { warnings } = await showPdfPreview(reportId);
      const warningSuffix = warnings.length ? ` ／ 注意: ${warnings.join(" ")}` : "";
      showMessage(`PDF出力用のデータを生成しました。プレビューを確認のうえ、印刷ボタンから印刷・PDF保存してください。${warningSuffix}`, !!warningSuffix);
    }
  } catch (err) {
    showMessage(`出力に失敗しました: ${err.message}`, true);
  } finally {
    generateBtn.disabled = false;
  }
});

printBtn.addEventListener("click", async () => {
  if (!previewFrame.contentWindow || !previewHtml) {
    showMessage("印刷対象がありません。先にプレビューまたは出力を行ってください。", true);
    return;
  }
  await waitFrameLoaded(previewFrame);
  const result = await printFrame(previewFrame);
  // 印刷画面が開いた形跡が無ければ、何も起きないままにせず案内する（js/printSupport.js）
  if (!result.opened) showMessage(canSharePrintFile() ? PRINT_NOT_OPENED_MESSAGE : PRINT_NOT_OPENED_MESSAGE_NO_SHARE, true);
  // ブラウザは紙に印刷できたかを知らせないため、利用者の確認で印刷状態を記録する
  printedRecordBtn.hidden = false;
});

// iPadのホーム画面アプリ等で印刷画面が開かない場合: 共有メニュー（→プリント）へ渡す。使えない環境ではファイルとして保存
printShareBtn.addEventListener("click", async () => {
  if (!previewHtml) return;
  const title = `日報_${reportSelect.selectedOptions[0]?.textContent || ""}`;
  const r = await sharePrintHtml(previewHtml, title);
  if (r === "shared") {
    showMessage("共有メニューを閉じました。「プリント」から印刷した場合は「紙に印刷できた」で記録してください。");
    printedRecordBtn.hidden = false;
  } else if (r === "cancelled") {
    showMessage("共有メニューが閉じられました。");
  } else if (r === "unsupported") {
    downloadPrintHtml(previewHtml, title);
    showMessage("印刷用ファイルを保存しました。保存したファイルを開き、そこから印刷してください。");
  } else {
    downloadPrintHtml(previewHtml, title);
    showMessage("共有メニューを開けなかったため、印刷用ファイルを保存しました。保存したファイルから印刷してください。", true);
  }
});

printedRecordBtn.addEventListener("click", async () => {
  const reportId = reportSelect.value;
  if (!reportId) return;
  const updated = await recordReportOutput(reportId, "print");
  printedRecordBtn.hidden = true;
  showMessage(`${PRINT_STATUS_LABELS[getPrintStatus(updated)]}として記録しました（${updated.date || "日付未設定"}）。`);
});

export async function initReportOutputView(query = {}) {
  showView("view-report-output");
  resetPreview();
  formatSelect.value = "excel";

  await populateSites(query.siteId);
  if (!siteSelect.value && siteSelect.options.length) siteSelect.selectedIndex = 0;
  await populateReports(siteSelect.value, query.reportId);
  const confirmed = await renderConfirm();
  await populateTemplates(confirmed?.site);
  updateFormatUi();
}
