/* ==========================================================
   業者管理（#/sites/:id/vendors）
   ・対象年月を選び、［業者別稼働］［請求人工管理］を切り替える。業者を押すとその業者・月の日別の詳細。
   ・業者別稼働: 実際の現場稼働（稼働日数・稼働人数・実績人工（1人＝1人工）・作業時間）。請求人工は使わない。
   ・請求人工管理: 日報の「請求人工」欄に入力された値（既存の companies[].billingManDays）だけを業者ごとに合計。
     その月に請求人工を入力した業者だけを出す。請求状況（未確認／請求あり／請求なし）と月の締めは別に保存
     （site.billingMonths。js/billing/billingMonthly.js）。稼働人数・人工・作業時間から請求人工を作らない。
   ・現場ダッシュボード・現場掲示（A3）・03-2には出さない。日報は書き換えない（日付を押すと既存の日報画面を開く）。
   ========================================================== */

import { getSite } from "../sites.js";
import { listReportsBySite } from "../reports.js";
import { hasPermission, canAccessSite } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { showView, showMessage } from "./common.js";
import { buildVendorActivity, buildMonthlyBilling, buildVendorMonthDetail, setBillingStatus, setBillingClose, BILLING_STATUSES, BILLING_CLOSE_STATUSES } from "../billing/billingMonthly.js";
import { durationLabel } from "../dashboard/dailyFlow.js";

const siteNameEl = document.getElementById("vendorMgmtSiteName");
const monthSelect = document.getElementById("vendorMgmtMonth");
const bodyEl = document.getElementById("vendorMgmtBody");
const viewEl = document.getElementById("view-vendor-management");

let state = { site: null, reports: [], month: "", tab: "activity", vendor: null };

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const monthLabel = (m) => { const [y, mm] = m.split("-").map(Number); return `${y}年${mm}月`; };
const shiftMonth = (m, n) => { const [y, mm] = m.split("-").map(Number); const d = new Date(y, mm - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const md = (iso) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
const hoursText = (min) => (min ? durationLabel(min) : "0時間");

/** 選べる月: 工期開始（または最初の日報）の月から、今月・工期終了の月までの遅いほう */
function monthOptions() {
  const today = todayIso().slice(0, 7);
  const dates = state.reports.map((r) => r.date).filter(Boolean).sort();
  let first = [state.site.startDate, dates[0], today].filter(Boolean).sort()[0].slice(0, 7);
  let last = [state.site.endDate, dates[dates.length - 1], today].filter(Boolean).sort().pop().slice(0, 7);
  if (last > today) last = last > shiftMonth(today, 12) ? shiftMonth(today, 12) : last;
  const list = [];
  for (let m = first; m <= last && list.length < 120; m = shiftMonth(m, 1)) list.push(m);
  if (!list.includes(state.month)) list.push(state.month);
  return list.sort();
}

function renderMonthSelect() {
  monthSelect.innerHTML = monthOptions().map((m) => `<option value="${m}"${m === state.month ? " selected" : ""}>${monthLabel(m)}</option>`).join("");
}

function render() {
  viewEl.querySelectorAll("[data-vm-tab]").forEach((b) => { const on = b.dataset.vmTab === state.tab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
  bodyEl.innerHTML = state.vendor ? detailHtml() : state.tab === "activity" ? activityHtml() : billingHtml();
}

function activityHtml() {
  const a = buildVendorActivity({ reports: state.reports, month: state.month, today: todayIso() });
  if (!a.rows.length) return `<p class="empty-message">${monthLabel(state.month)}に現場で稼働した業者はありません（通常作業の日報で稼働人数が1人以上の業者）。</p>`;
  return `<p class="vm-lead">${monthLabel(state.month)}の業者別の現場稼働（${md(a.cutoff)}までの日報）。請求人工とは別の、実際の稼働実績です。業者を押すと日別の稼働を表示します。</p>
    <div class="dash-table-wrap"><table class="dash-table vm-table vm-activity">
      <thead><tr><th>業者</th><th class="num">稼働日数</th><th class="num">稼働人数</th><th class="num">実績人工</th><th class="num">作業時間</th></tr></thead>
      <tbody>${a.rows.map((r) => `<tr><td><button type="button" class="link-btn vm-vendor" data-vm-vendor="${escapeHtml(r.vendor)}">${escapeHtml(r.vendor)}</button>${r.trades.length ? `<br><small class="empty-message">${escapeHtml(r.trades.join("・"))}</small>` : ""}</td><td class="num">${r.days}日</td><td class="num">${r.workers}人</td><td class="num">${r.manDays}</td><td class="num">${hoursText(r.minutes)}${r.hoursMissing ? `<br><small class="empty-message">作業時間未入力 ${r.hoursMissing}件</small>` : ""}</td></tr>`).join("")}</tbody>
      <tfoot><tr><th>合計（${a.totals.vendors}社）</th><td class="num">${a.totals.days}日</td><td class="num">${a.totals.workers}人</td><td class="num">${a.totals.workers}</td><td class="num">${hoursText(a.totals.minutes)}</td></tr></tfoot>
    </table></div>
    <p class="empty-message">稼働日＝通常作業の日報で、その業者の稼働人数が1人以上の日（現場作業なし・休工日・雨天作業不可日・事務作業日は数えません）。実績人工は1人＝1人工、作業時間は業者の作業時間（開始～終了）の合計です。</p>`;
}

function billingHtml() {
  const b = buildMonthlyBilling({ reports: state.reports, site: state.site, month: state.month, today: todayIso() });
  const canEdit = hasPermission("editReports");
  const statusSelect = (row) => `<select class="billing-status" data-billing-vendor="${escapeHtml(row.vendor)}" aria-label="${escapeHtml(row.vendor)}の請求状況"${canEdit ? "" : " disabled"}>${BILLING_STATUSES.map((s) => `<option value="${s.value}"${s.value === row.status ? " selected" : ""}>${s.label}</option>`).join("")}</select>`;
  return `<p class="vm-lead">${monthLabel(state.month)}に「請求人工」欄へ入力された値だけの合計です（${md(b.cutoff)}までの日報。入力した業者だけを表示）。業者を押すと、稼働日と請求人工の入力日を日別に表示します。</p>
    <p class="billing-summary">請求あり <b>${b.counts.billed}</b>社・未確認 <b>${b.counts.unconfirmed}</b>社・請求なし <b>${b.counts.none}</b>社　／　月間請求人工 計 <b>${b.total}</b></p>
    ${b.rows.length
      ? `<div class="dash-table-wrap"><table class="dash-table vm-table billing-table">
          <thead><tr><th>業者</th><th class="num">月間請求人工</th><th class="num">入力日数</th><th>請求状況</th></tr></thead>
          <tbody>${b.rows.map((r) => `<tr class="billing-${r.status}" data-billing-row="${escapeHtml(r.vendor)}"><td><button type="button" class="link-btn vm-vendor" data-vm-vendor="${escapeHtml(r.vendor)}">${escapeHtml(r.vendor)}</button></td><td class="num">${r.manDays}人工</td><td class="num">${r.enteredDays}日</td><td>${statusSelect(r)}</td></tr>`).join("")}</tbody>
        </table></div>`
      : `<p class="empty-message">${monthLabel(state.month)}に請求人工を入力した業者はありません。</p>`}
    ${b.billedWithoutManDays.length ? `<p class="billing-warn">請求あり・請求人工未入力：${escapeHtml(b.billedWithoutManDays.join("・"))}（請求状況は「請求あり」ですが、この月の請求人工が入力されていません）</p>` : ""}
    <label class="billing-close">月の締め <select class="billing-close-status"${canEdit ? "" : " disabled"}>${BILLING_CLOSE_STATUSES.map((s) => `<option value="${s.value}"${s.value === b.closeStatus ? " selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <p class="empty-message">請求人工は入力された値だけを使います（稼働人数・実績人工・作業時間からは作りません。未入力は0にしません）。請求状況は請求書を確認して選びます（請求人工が入っていても自動で「請求あり」にはしません。「請求なし」でも請求人工は0にしません）。月を切り替えると、その月に入力された値だけで集計します。</p>`;
}

function detailHtml() {
  const d = buildVendorMonthDetail({ reports: state.reports, site: state.site, month: state.month, today: todayIso(), vendor: state.vendor });
  const s = d.summary;
  const billingTab = state.tab === "billing";
  // 業者別稼働の詳細は実際に稼働した日だけ。請求人工管理の詳細は稼働日と請求人工の入力日の両方
  const days = billingTab ? d.days : d.days.filter((x) => x.worked);
  const minutes = days.reduce((t, x) => t + (x.minutes || 0), 0);
  return `<button type="button" class="link-btn vm-back">← ${billingTab ? "請求人工管理" : "業者別稼働"}の一覧に戻る</button>
    <h3 class="vm-detail-title">${escapeHtml(d.vendor)}・${monthLabel(d.month)}</h3>
    <dl class="dash-dl dash-dl-row vm-summary">
      <dt>稼働日</dt><dd>${s.workDays}日</dd><dt>稼働人数（延べ）</dt><dd>${s.workers}人</dd><dt>実績人工</dt><dd>${s.manDays}</dd>
      ${billingTab ? `<dt>請求人工</dt><dd>${s.billing == null ? "未入力" : `${s.billing}人工`}</dd><dt>請求人工の入力日</dt><dd>${s.billingDays}日</dd><dt>請求状況</dt><dd>${escapeHtml(s.statusLabel)}</dd>` : `<dt>作業時間</dt><dd>${hoursText(minutes)}</dd>`}
    </dl>
    ${days.length
      ? `<div class="dash-table-wrap"><table class="dash-table vm-table vm-days">
          <thead><tr><th>日付</th><th>日の状態</th><th class="num">稼働</th><th>作業時間</th>${billingTab ? `<th class="num">請求人工</th>` : ""}</tr></thead>
          <tbody>${days.map((x) => `<tr class="${x.worked ? "vm-worked" : "vm-notworked"}"><td><button type="button" class="link-btn vm-report" data-report-id="${escapeHtml(x.reportId)}">${md(x.date)}</button></td><td>${escapeHtml(x.dayStatusLabel)}</td><td class="num">${x.worked ? `稼働 ${x.workers}人` : "稼働なし"}</td><td>${escapeHtml(x.hours || "")}${x.minutes ? `<br><small class="empty-message">${durationLabel(x.minutes)}</small>` : ""}</td>${billingTab ? `<td class="num">${x.billing == null ? "請求 未入力" : `請求 ${x.billing}`}</td>` : ""}</tr>`).join("")}</tbody>
        </table></div>`
      : `<p class="empty-message">この月の記録はありません。</p>`}
    <p class="empty-message">${billingTab ? "「稼働」は実際に働いた人数（通常作業の日）、「請求」は請求人工欄に入力した値です（別のものです）。" : "通常作業の日報で稼働人数が1人以上の日を表示しています。"}日付を押すと、その日の日報を開きます。</p>`;
}

async function reload() {
  state.site = await getSite(state.site.id);
  state.reports = (await listReportsBySite(state.site.id)).filter((r) => !r.isDeleted);
  render();
}

export async function initVendorManagementView(params) {
  const site = await getSite(params.id);
  if (!site) { showMessage("現場が見つかりませんでした。", true); navigate("/sites"); return; }
  if (!canAccessSite(site)) { showMessage("この現場を閲覧する権限がありません。", true); navigate("/sites"); return; }
  const sameSite = state.site?.id === site.id;
  state = { site, reports: (await listReportsBySite(site.id)).filter((r) => !r.isDeleted), month: sameSite && state.month ? state.month : todayIso().slice(0, 7), tab: sameSite ? state.tab : "activity", vendor: sameSite ? state.vendor : null };
  siteNameEl.textContent = `（${site.name}）`;
  renderMonthSelect();
  render();
  showView("view-vendor-management");
}

document.getElementById("backToSiteFromVendorMgmtBtn")?.addEventListener("click", () => navigate(`/sites/${state.site.id}`));
// 月・タブを切り替えるたびに、現場（請求状況）と日報を読み直してから表示する
monthSelect?.addEventListener("change", async () => { state.month = monthSelect.value; await reload(); });
viewEl?.addEventListener("click", async (e) => {
  const nav = e.target.closest(".vm-month-nav");
  if (nav) { state.month = shiftMonth(state.month, Number(nav.dataset.shift)); renderMonthSelect(); await reload(); return; }
  const tab = e.target.closest("[data-vm-tab]");
  if (tab) { state.tab = tab.dataset.vmTab; state.vendor = null; await reload(); return; }
  const vendor = e.target.closest("[data-vm-vendor]");
  if (vendor) { state.vendor = vendor.dataset.vmVendor; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest(".vm-back")) { state.vendor = null; render(); return; }
  const rep = e.target.closest(".vm-report");
  if (rep) navigate(`/sites/${state.site.id}/report/${rep.dataset.reportId}`);
});
viewEl?.addEventListener("change", async (e) => {
  const st = e.target.closest(".billing-status");
  const close = e.target.closest(".billing-close-status");
  if (!st && !close) return;
  try {
    if (st) await setBillingStatus(state.site.id, state.month, st.dataset.billingVendor, st.value);
    else await setBillingClose(state.site.id, state.month, close.value);
    await reload();
  } catch (err) {
    showMessage(err.message, true);
  }
});
