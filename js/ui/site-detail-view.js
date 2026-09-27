/* ==========================================================
   現場詳細画面
   基本情報表示、編集・コピー・アーカイブ操作、配下の日報一覧を扱う
   ========================================================== */

import { getSite, copySite, archiveSite, unarchiveSite, completeSite, reopenSite } from "../sites.js";
import { listReportsBySite, getPrintStatus, isEditedAfterPrint, PRINT_STATUS_LABELS, recordReportOutput } from "../reports.js";
import { exportReportsExcelZip, buildReportsPrintHtml, exportSiteLedgerExcel, buildSiteLedgerPrintHtml, resolveCompanyTemplateForSite } from "../reportPrint.js";
import { previewSiteTemplateUpgrade, upgradeSiteTemplate, revertSiteTemplate } from "../report-output/templateResolver.js";
import { openReportPrintDialog } from "./report-print-dialog.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const nameEl = document.getElementById("siteDetailName");
const statusBadgeEl = document.getElementById("siteDetailStatusBadge");
const clientNameEl = document.getElementById("siteDetailClientName");
const addressEl = document.getElementById("siteDetailAddress");
const periodEl = document.getElementById("siteDetailPeriod");
const reportTemplateEl = document.getElementById("siteDetailReportTemplate");
const memoEl = document.getElementById("siteDetailMemo");
const editBtn = document.getElementById("editSiteBtn");
const copyBtn = document.getElementById("copySiteBtn");
const toggleArchiveBtn = document.getElementById("toggleArchiveBtn");
const backBtn = document.getElementById("backToSiteListBtn");
const newReportBtn = document.getElementById("newReportBtn");
const reportListEl = document.getElementById("reportList");
const reportListEmptyEl = document.getElementById("reportListEmpty");
const goToEstimateListBtn = document.getElementById("goToEstimateListBtn");
const goToVendorQuoteImportFromSiteBtn = document.getElementById("goToVendorQuoteImportFromSiteBtn");
const goToComparisonFromSiteBtn = document.getElementById("goToComparisonFromSiteBtn");
const goToSubmissionFromSiteBtn = document.getElementById("goToSubmissionFromSiteBtn");
const reportListFilter = document.getElementById("reportListFilter");
const reportListSearch = document.getElementById("reportListSearch");
const reportListSummary = document.getElementById("reportListSummary");
const reportMissingList = document.getElementById("reportMissingList");
const siteCompletedNotice = document.getElementById("siteCompletedNotice");
const bulkExcelBtn = document.getElementById("bulkExcelBtn");
const bulkPdfBtn = document.getElementById("bulkPdfBtn");
const bulkPrintBtn = document.getElementById("bulkPrintBtn");
const ledgerExcelBtn = document.getElementById("ledgerExcelBtn");
const ledgerPrintBtn = document.getElementById("ledgerPrintBtn");
const completeSiteBtn = document.getElementById("completeSiteBtn");
const reopenSiteBtn = document.getElementById("reopenSiteBtn");

const copyDialog = document.getElementById("copySiteDialog");
const copyForm = document.getElementById("copySiteForm");
const copyNewNameInput = document.getElementById("copySiteNewName");
const copyReportsCheckbox = document.getElementById("copySiteReportsCheckbox");
const copyCancelBtn = document.getElementById("copySiteCancelBtn");

let currentSite = null;

function fmtPeriod(site) {
  if (!site.startDate && !site.endDate) return "-";
  return `${site.startDate || "未定"} 〜 ${site.endDate || "未定"}`;
}

let allReports = [];
let shownReports = [];

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP") : "");
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 工期（着工日〜竣工予定日。今日より先は含めない）のうち、日報のない日。休工日も含まれる */
function missingDates(site, reports) {
  if (!site.startDate) return null;
  const has = new Set(reports.map((r) => r.date));
  const endIso = [site.endDate || todayIso(), todayIso()].sort()[0];
  const out = [];
  const d = new Date(`${site.startDate}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  for (let n = 0; d <= end && n < 3660; n++, d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!has.has(iso)) out.push(iso);
  }
  return out.reverse();
}

function matchesFilter(report, filter) {
  switch (filter) {
    case "unprinted": case "printed": case "reprinted": return getPrintStatus(report) === filter;
    case "editedAfterPrint": return isEditedAfterPrint(report);
    case "confirmed": return !!report.confirmedAt;
    case "unconfirmed": return !report.confirmedAt;
    default: return true;
  }
}

function matchesSearch(report, q) {
  if (!q) return true;
  const hay = [report.date, report.weather, report.remarks, report.tomorrowPlan, ...(report.siteSupervisorNames || []),
    ...(report.companies || []).flatMap((c) => [c.companyName, c.occupation, c.workContent, c.safetyNotes, c.foremanName, c.machinery])]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

function reportCardHtml(report) {
  const status = getPrintStatus(report);
  const badges = [
    `<span class="status-badge ${report.confirmedAt ? "input-confirmed" : "input-unconfirmed"}">${report.confirmedAt ? "確認済み" : "入力済み・未確認"}</span>`,
    `<span class="status-badge print-${status}">${PRINT_STATUS_LABELS[status]}${report.printCount > 1 ? `（${report.printCount}回）` : ""}</span>`,
    report.lastPrintedAt ? `<span>最終印刷 ${escapeHtml(fmtDateTime(report.lastPrintedAt))}</span>` : "",
    report.lastOutputAt ? `<span>最終出力 ${escapeHtml(fmtDateTime(report.lastOutputAt))}</span>` : "",
    isEditedAfterPrint(report) ? `<span class="status-badge status-warning">印刷後に修正あり</span>` : "",
    report.finalizedAt ? `<span class="status-badge status-default">確定済み</span>` : ""
  ].filter(Boolean).join("");
  return `
      <p class="report-card-date">${escapeHtml(report.date) || "日付未設定"}</p>
      <p class="report-card-meta">${escapeHtml(report.weather)}／作業人数 ${escapeHtml(report.workerCountTotal) || "-"}人</p>
      <p class="report-card-status">${badges}</p>`;
}

async function renderReportList() {
  allReports = await listReportsBySite(currentSite.id);
  const filter = reportListFilter.value;
  const q = reportListSearch.value.trim().toLowerCase();
  reportListEl.innerHTML = "";
  reportMissingList.innerHTML = "";
  reportListEmptyEl.style.display = allReports.length === 0 ? "block" : "none";

  const counts = { unprinted: 0, printed: 0, reprinted: 0, confirmed: 0 };
  for (const r of allReports) {
    counts[getPrintStatus(r)]++;
    if (r.confirmedAt) counts.confirmed++;
  }
  const missing = missingDates(currentSite, allReports);
  reportListSummary.textContent = `全${allReports.length}件（未印刷${counts.unprinted}・印刷済み${counts.printed}・再印刷${counts.reprinted}・確認済み${counts.confirmed}）${missing ? `／未入力（日報のない日）${missing.length}日` : "／着工日が未設定のため未入力日は判定できません"}`;

  if (filter === "missing") {
    reportListEl.hidden = true;
    reportMissingList.hidden = false;
    shownReports = [];
    const list = (missing || []).filter((d) => !q || d.includes(q));
    reportMissingList.innerHTML = missing === null
      ? `<li class="empty-message">着工日が未設定のため、未入力日を判定できません（現場情報で着工日を設定してください）。</li>`
      : list.length === 0
        ? `<li class="empty-message">工期内に日報のない日はありません。</li>`
        : list.map((d) => `<li class="report-missing-card" data-date="${d}"><strong>${d}</strong>　日報なし（休工日も含みます）${currentSite.completedAt ? "" : "　― 押すとこの日の日報を作成"}</li>`).join("");
    return;
  }
  reportListEl.hidden = false;
  reportMissingList.hidden = true;
  shownReports = allReports.filter((r) => matchesFilter(r, filter) && matchesSearch(r, q));
  for (const report of shownReports) {
    const li = document.createElement("li");
    li.className = "report-card";
    li.dataset.reportId = report.id;
    li.innerHTML = reportCardHtml(report);
    reportListEl.appendChild(li);
  }
  if (allReports.length > 0 && shownReports.length === 0) {
    reportListEl.innerHTML = `<li class="empty-message">条件に合う日報はありません。</li>`;
  }
}

reportListFilter.addEventListener("change", renderReportList);
reportListSearch.addEventListener("input", renderReportList);

reportMissingList.addEventListener("click", (e) => {
  const li = e.target.closest(".report-missing-card");
  if (!li || currentSite.completedAt) return;
  navigate(`/sites/${currentSite.id}/report/new?date=${li.dataset.date}`);
});

function bulkTargets() {
  if (reportListFilter.value === "missing" || shownReports.length === 0) {
    showMessage("出力する日報がありません（一覧の絞り込みを確認してください）。", true);
    return null;
  }
  return [...shownReports].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

bulkExcelBtn.addEventListener("click", async () => {
  const targets = bulkTargets();
  if (!targets) return;
  bulkExcelBtn.disabled = true;
  try {
    const r = await exportReportsExcelZip(targets.map((t) => t.id), `${currentSite.name}_日報Excel_${targets[0].date}〜${targets[targets.length - 1].date}.zip`);
    showMessage(`日報${r.count}件のExcelをZIPで出力しました。${r.usedCompanyTemplate ? "" : " 注意: 会社指定様式が見つからないため汎用フォーマットで出力しました。"}`, !r.usedCompanyTemplate);
    await renderReportList();
  } catch (err) {
    showMessage(`一括出力に失敗しました: ${err.message}`, true);
  } finally {
    bulkExcelBtn.disabled = false;
  }
});

async function openBulkPrint(mode) {
  const targets = bulkTargets();
  if (!targets) return;
  let built;
  try {
    built = await buildReportsPrintHtml(targets.map((t) => t.id), `${currentSite.name} 工事日報`);
  } catch (err) {
    showMessage(`印刷用データの作成に失敗しました: ${err.message}`, true);
    return;
  }
  openReportPrintDialog({
    html: built.html,
    mode,
    title: `${mode === "pdf" ? "PDF一括出力" : "まとめて印刷"}（${targets.length}件: ${targets[0].date}〜${targets[targets.length - 1].date}）`,
    note: built.usedCompanyTemplate ? "会社指定様式のレイアウトで、1日報1ページで出力します。" : "会社指定様式が見つからない日報があるため、アプリ独自のレイアウトで出力します。",
    onPrinted: async () => {
      for (const t of targets) await recordReportOutput(t.id, "print");
      showMessage(`${targets.length}件を印刷済み（2回目以降は再印刷）として記録しました。`);
      await renderReportList();
    },
    onPdfOpened: async () => {
      for (const t of targets) await recordReportOutput(t.id, "pdf");
      await renderReportList();
    }
  });
}

bulkPdfBtn.addEventListener("click", () => openBulkPrint("pdf"));
bulkPrintBtn.addEventListener("click", () => openBulkPrint("print"));

ledgerExcelBtn.addEventListener("click", async () => {
  ledgerExcelBtn.disabled = true;
  showMessage("台帳を作成しています…");
  try {
    const r = await exportSiteLedgerExcel(currentSite.id);
    const notes = r.warnings.length ? ` 注意: ${r.warnings.join(" ")}` : "";
    showMessage(`台帳Excelを出力しました（${r.firstDate}〜${r.lastDate}、${r.pageCount}頁・シート${r.sheetNames.length}枚、日報${r.placedCount}件）。${notes}`);
  } catch (err) {
    showMessage(`台帳を出力できませんでした: ${err.message}`, true);
  } finally {
    ledgerExcelBtn.disabled = false;
  }
});

ledgerPrintBtn.addEventListener("click", async () => {
  ledgerPrintBtn.disabled = true;
  showMessage("台帳の印刷用データを作成しています…");
  let built;
  try {
    built = await buildSiteLedgerPrintHtml(currentSite.id);
  } catch (err) {
    showMessage(`台帳の印刷用データを作成できませんでした: ${err.message}`, true);
    return;
  } finally {
    ledgerPrintBtn.disabled = false;
  }
  showMessage("");
  openReportPrintDialog({
    html: built.html,
    mode: "pdf",
    title: `台帳の印刷・PDF（${built.firstDate}〜${built.lastDate}、${built.printPageCount}頁）`,
    note: "台帳Excelと同じ内容を1日1頁で出力します。紙に印刷する場合も、この画面の印刷先でプリンターを選んでください（台帳の出力は日報ごとの印刷記録には残しません）。"
  });
});

completeSiteBtn.addEventListener("click", async () => {
  if (!confirm(`「${currentSite.name}」を工事完了にしますか？\n\nこの現場の日報${allReports.length}件をすべて確定します。以後は日報の修正・追加ができなくなりますが、閲覧・検索・再出力はいつでもできます（データは削除されません）。\n確定の前に、必要ならExcel一括出力・PDF一括出力を行ってください。`)) return;
  currentSite = await completeSite(currentSite.id);
  showMessage("工事完了にし、日報を確定しました。必要に応じて一括出力・アーカイブを行ってください。");
  renderSiteInfo();
  await renderReportList();
});

reopenSiteBtn.addEventListener("click", async () => {
  if (!confirm("工事完了を取り消しますか？日報の確定が解除され、修正・追加ができるようになります。")) return;
  currentSite = await reopenSite(currentSite.id);
  showMessage("工事完了を取り消しました。");
  renderSiteInfo();
  await renderReportList();
});

reportListEl.addEventListener("click", (e) => {
  const card = e.target.closest(".report-card");
  if (!card) return;
  navigate(`/sites/${currentSite.id}/report/${card.dataset.reportId}`);
});

editBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/edit`));
backBtn.addEventListener("click", () => navigate("/sites"));
newReportBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/report/new`));
goToEstimateListBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates`));
goToVendorQuoteImportFromSiteBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes/import`));
goToComparisonFromSiteBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes/compare`));
goToSubmissionFromSiteBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/submission`));

copyBtn.addEventListener("click", () => {
  copyNewNameInput.value = `${currentSite.name}のコピー`;
  copyReportsCheckbox.checked = false;
  copyDialog.showModal();
});
copyCancelBtn.addEventListener("click", () => copyDialog.close());
copyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newSite = await copySite(currentSite.id, {
    newName: copyNewNameInput.value.trim(),
    copyReports: copyReportsCheckbox.checked
  });
  copyDialog.close();
  showMessage(`現場「${newSite.name}」を作成しました。`);
  navigate(`/sites/${newSite.id}`);
});

toggleArchiveBtn.addEventListener("click", async () => {
  if (currentSite.status === "archived") {
    currentSite = await unarchiveSite(currentSite.id);
    showMessage("現場を進行中に戻しました。");
  } else {
    if (!confirm(`「${currentSite.name}」をアーカイブしますか？一覧から非表示になります（後で戻せます）。`)) return;
    currentSite = await archiveSite(currentSite.id);
    showMessage("現場をアーカイブしました。");
  }
  renderSiteInfo();
});

/** 日報のExcel様式（どの様式の、何版を、なぜ使うか）を表示する。最新版への切り替え・元に戻すボタンも出す */
async function renderSiteTemplateInfo() {
  const site = currentSite;
  reportTemplateEl.textContent = "確認中…";
  const resolved = await resolveCompanyTemplateForSite(site);
  if (site !== currentSite) return; // 表示中の現場が切り替わっていたら捨てる
  if (!resolved) {
    reportTemplateEl.textContent = "未設定（汎用フォーマットで出力。テンプレート管理で標準テンプレートを登録してください）";
    return;
  }
  const parts = [];
  parts.push(`<span class="site-template-name">${escapeHtml(resolved.templateName)}</span> 第${resolved.revision || "?"}版`);
  parts.push(resolved.pinned ? `（${escapeHtml(resolved.sourceLabel)}・この現場に固定）` : `（${escapeHtml(resolved.sourceLabel)}・最初の出力時にこの版に固定されます）`);
  if (resolved.sha256) parts.push(`<br><small class="site-template-sha">SHA-256: ${escapeHtml(resolved.sha256.slice(0, 16))}…</small>`);
  if (resolved.notice) parts.push(`<br><span class="status-badge status-warning">${escapeHtml(resolved.notice)}</span>`);
  const buttons = [];
  if (resolved.pinned && !resolved.isLatest && resolved.latestRevision) {
    parts.push(`<br><span class="status-badge">最新は第${resolved.latestRevision}版</span>`);
    if (!currentSite.completedAt) buttons.push(`<button type="button" class="secondary-btn" id="siteTemplateUpgradeBtn">最新版（第${resolved.latestRevision}版）に切り替える</button>`);
  }
  if (resolved.pinned && (currentSite.templatePinHistory || []).length > 0 && !currentSite.completedAt) {
    const prev = currentSite.templatePinHistory[0];
    buttons.push(`<button type="button" class="secondary-btn" id="siteTemplateRevertBtn">前の版（第${prev.revision || "?"}版）に戻す</button>`);
  }
  reportTemplateEl.innerHTML = parts.join("") + (buttons.length ? `<div class="toolbar site-template-actions">${buttons.join("")}</div>` : "");
}

reportTemplateEl.addEventListener("click", async (e) => {
  if (e.target.closest("#siteTemplateUpgradeBtn")) {
    try {
      const preview = await previewSiteTemplateUpgrade(currentSite.id);
      const diffText = preview.diffs.length
        ? `様式の固定文言の違い（${preview.diffs.length}か所）:\n${preview.diffs.slice(0, 10).map((d) => `・${d.cell}: 「${d.before || "（空）"}」→「${d.after || "（空）"}」`).join("\n")}${preview.diffs.length > 10 ? "\n・…ほか" : ""}`
        : "様式の固定文言に違いはありません（ファイルの内容は異なります）。";
      const warn = preview.warnings.length ? `\n\n注意:\n・${preview.warnings.join("\n・")}` : "";
      if (!confirm(`この現場の日報Excel様式を、第${preview.resolved.revision}版から第${preview.latest.revision}版に切り替えますか？\n\n${diffText}${warn}\n\n切り替えると、この現場の過去の日報を再出力・再印刷した場合や台帳も新しい版になります。あとで「前の版に戻す」で戻せます。`)) return;
      currentSite = await upgradeSiteTemplate(currentSite.id);
      showMessage("この現場の様式を最新版に切り替えました。");
    } catch (err) {
      showMessage(`切り替えられませんでした: ${err.message}`, true);
    }
    await renderSiteTemplateInfo();
    return;
  }
  if (e.target.closest("#siteTemplateRevertBtn")) {
    const prev = currentSite.templatePinHistory?.[0];
    if (!confirm(`この現場の日報Excel様式を、前の版（第${prev?.revision || "?"}版）に戻しますか？`)) return;
    try {
      currentSite = await revertSiteTemplate(currentSite.id);
      showMessage("この現場の様式を前の版に戻しました。");
    } catch (err) {
      showMessage(`戻せませんでした: ${err.message}`, true);
    }
    await renderSiteTemplateInfo();
  }
});

function renderSiteInfo() {
  nameEl.textContent = currentSite.name;
  statusBadgeEl.textContent = currentSite.status === "archived" ? "アーカイブ済み" : "進行中";
  statusBadgeEl.className = `status-badge status-${currentSite.status}`;
  clientNameEl.textContent = currentSite.clientName || "-";
  renderSiteTemplateInfo();
  addressEl.textContent = currentSite.address || "-";
  periodEl.textContent = fmtPeriod(currentSite);
  memoEl.textContent = currentSite.memo || "-";
  toggleArchiveBtn.textContent = currentSite.status === "archived" ? "アーカイブを解除" : "この現場をアーカイブ";
  const completed = !!currentSite.completedAt;
  siteCompletedNotice.hidden = !completed;
  siteCompletedNotice.textContent = completed ? `工事完了（${new Date(currentSite.completedAt).toLocaleString("ja-JP")}）: 日報は確定済みです。閲覧・検索・再出力はできます。` : "";
  if (completed) statusBadgeEl.textContent += "・工事完了";
  completeSiteBtn.hidden = completed || !hasPermission("manageSites");
  reopenSiteBtn.hidden = !completed || !hasPermission("manageSites");
  newReportBtn.hidden = completed || !hasPermission("editReports");
}

export async function initSiteDetailView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site)) {
    showMessage("この現場を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  currentSite = site;
  showView("view-site-detail");

  // 現場管理（編集・コピー・アーカイブ）は管理者のみ。日報作成は
  // 管理者・監督（担当現場のみ、ここまで到達している時点で担当確認済み）。
  // 閲覧のみは日報作成も不可。
  editBtn.hidden = !hasPermission("manageSites");
  copyBtn.hidden = !hasPermission("manageSites");
  toggleArchiveBtn.hidden = !hasPermission("manageSites");
  reportListFilter.value = "all";
  reportListSearch.value = "";

  renderSiteInfo();
  await renderReportList();
}
