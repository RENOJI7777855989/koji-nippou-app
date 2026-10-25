/* ==========================================================
   業者管理（#/sites/:id/vendors）
   ・対象年月を選び、［業者別稼働］［請求人工管理］を切り替える。業者を押すとその業者・月の日別の詳細。
   ・業者別稼働: 実際の現場稼働（稼働日数・稼働人数・実績人工（1人＝1人工）・作業時間）。請求人工は使わない。
   ・請求人工管理: 日報の「請求人工」欄に入力された値（既存の companies[].billingManDays）だけを業者ごとに合計。
     その月に請求人工を入力した業者だけを出す。請求状況（未確認／請求あり／請求なし）と月の締めは別に保存
     （site.billingMonths。js/billing/billingMonthly.js）。稼働人数・人工・作業時間から請求人工を作らない。
   ・現場ダッシュボード・現場掲示（A3）・03-2には出さない。日報は書き換えない（日付を押すと既存の日報画面を開く）。
   ・業者×職種の明細（2026-10-25）: 業者の行の下に、日報に保存された職種の名前ごとの明細（似た名前はまとめない。
     billingMonthly.js の vendorTradeLines）と業者合計。明細の［日報］で根拠の日付を並べ、押すとその日の日報を開いて
     該当の業者の行を目立たせる（?hl=業者の行の companyId）。保存・キャンセルするとこの画面に戻り、集計し直す（?from=vendors）。
   ========================================================== */

import { getSite } from "../sites.js";
import { listReportsBySite } from "../reports.js";
import { hasPermission, canAccessSite } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { showView, showMessage } from "./common.js";
import { buildVendorActivity, buildVendorPeriodActivity, buildVendorPeriodDetail, buildMonthlyBilling, buildVendorMonthDetail, setBillingStatus, setBillingClose, BILLING_STATUSES, BILLING_CLOSE_STATUSES } from "../billing/billingMonthly.js";
import { durationLabel } from "../dashboard/dailyFlow.js";
import { openBillingDialog } from "./billing-input-dialog.js";

const siteNameEl = document.getElementById("vendorMgmtSiteName");
const monthSelect = document.getElementById("vendorMgmtMonth");
const bodyEl = document.getElementById("vendorMgmtBody");
const viewEl = document.getElementById("view-vendor-management");

// period: 期間を指定した集計の開始・終了年月（利用者が選ぶまでは表示している月の1か月）。periodTouched: 利用者が期間を選んだか。
// vendorPeriod: 期間の日別の詳細を表示しているか
let state = { site: null, reports: [], month: "", tab: "activity", vendor: null, period: null, periodTouched: false, vendorPeriod: false, openLine: null };

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
  bodyEl.innerHTML = state.vendor ? (state.vendorPeriod ? periodDetailHtml() : detailHtml()) : state.tab === "activity" ? activityHtml() + periodHtml() : billingHtml();
}

/**
 * 業者×職種の明細の行（業者の行の下に置く）。cells(line) は2列目以降のセルのHTML。
 * key ごとに［日報］で根拠の日付（日報）を開く行を出す（openLine）
 */
function lineRows(kind, vendor, lines, cells, colCount, entriesOf = (l) => l.entries) {
  return lines.map((l) => {
    const key = `${kind}|${vendor}|${l.trade}`; // HTML の属性に入れるので、見えない制御文字は使わない
    const entries = entriesOf(l);
    const open = state.openLine === key;
    const btn = entries.length ? `<button type="button" class="link-btn vm-line-toggle" data-vm-line="${escapeHtml(key)}" aria-expanded="${open}">日報（${new Set(entries.map((e) => e.date)).size}日）${open ? "▲" : "▼"}</button>` : "";
    const list = open ? `<tr class="vm-line-dates"><td colspan="${colCount}"><span class="empty-message">${escapeHtml(vendor)}／${escapeHtml(l.trade)} の日報: </span>${entries.map((e) => `<button type="button" class="secondary-btn vm-line-report" data-report-id="${escapeHtml(e.reportId)}" data-cids="${escapeHtml(e.companyIds.join(","))}">${md(e.date)}（${e.value}）</button>`).join(" ")}</td></tr>` : "";
    return `<tr class="vm-line" data-vm-line-row="${escapeHtml(key)}"><td class="vm-line-name">└ ${escapeHtml(l.trade)}<br>${btn}</td>${cells(l)}</tr>${list}`;
  }).join("");
}

function activityHtml() {
  const a = buildVendorActivity({ reports: state.reports, month: state.month, today: todayIso(), startDate: state.site.startDate || null });
  if (!a.rows.length) return `<p class="empty-message">${monthLabel(state.month)}までに現場で稼働した業者はありません（通常作業の日報で稼働人数が1人以上の業者）。</p>`;
  const none = a.totals.vendors === 0 ? `<p class="empty-message">${monthLabel(state.month)}に現場で稼働した業者はありません（下の表は、${md(a.cutoff)}までの累計です）。</p>` : "";
  return `<p class="vm-lead">${monthLabel(state.month)}の業者別の現場稼働（${md(a.cutoff)}までの日報）。請求人工とは別の、実際の稼働実績です。業者を押すと日別の稼働を表示します。</p>${none}
    <div class="dash-table-wrap"><table class="dash-table vm-table vm-activity">
      <thead><tr><th>業者</th><th class="num">稼働日数</th><th class="num">稼働人数</th><th class="num">実績人工</th><th class="num">作業時間</th><th class="num">累計実績人工<br><small>（${md(a.cutoff)}まで）</small></th></tr></thead>
      <tbody>${a.rows.map((r) => `<tr class="vm-vendor-row${r.days ? "" : " vm-row-idle"}"><td><button type="button" class="link-btn vm-vendor" data-vm-vendor="${escapeHtml(r.vendor)}">${escapeHtml(r.vendor)}</button><br><small class="vm-total-label">業者合計</small>${r.days ? "" : `<br><small class="empty-message">この月の稼働なし</small>`}</td><td class="num">${r.days}日</td><td class="num">${r.workers}人</td><td class="num">${r.manDays}</td><td class="num">${hoursText(r.minutes)}${r.hoursMissing ? `<br><small class="empty-message">作業時間未入力 ${r.hoursMissing}件</small>` : ""}</td><td class="num"><b>${r.cumManDays}</b></td></tr>${lineRows("activity", r.vendor, r.lines, (l) => `<td class="num">${l.days}日</td><td class="num">${l.workers}人</td><td class="num">${l.manDays}</td><td class="num">${hoursText(l.minutes)}</td><td class="num">${l.cumManDays}</td>`, 6, (l) => (l.entries.length ? l.entries : l.cumEntries))}`).join("")}</tbody>
      <tfoot><tr><th>合計（${a.totals.vendors}社${a.totals.listed > a.totals.vendors ? `・累計 ${a.totals.listed}社` : ""}）</th><td class="num">${a.totals.days}日</td><td class="num">${a.totals.workers}人</td><td class="num">${a.totals.workers}</td><td class="num">${hoursText(a.totals.minutes)}</td><td class="num"><b>${a.totals.cumManDays}</b></td></tr></tfoot>
    </table></div>
    <p class="empty-message">業者の行の下は、日報に保存された職種の名前ごとの明細です（名前が似ていてもまとめません。名前を直すときは［日報］から日報を開いて修正してください）。業者の行は業者合計（明細の合計）です。稼働日＝通常作業の日報で、その業者の稼働人数が1人以上の日（現場作業なし・休工日・雨天作業不可日・事務作業日は数えません）。実績人工は1人＝1人工、作業時間は業者の作業時間（開始～終了）の合計です。累計実績人工は、工期開始日${state.site.startDate ? `（${md(state.site.startDate)}）` : ""}から${md(a.cutoff)}（この月の末日。今月は今日）までの日報の実績人工の合計で（同じ決まりで数えます。請求人工は使いません）、この月に稼働していない業者も、それより前に稼働していれば表示します（この月の欄は0）。</p>`;
}

/** 期間を指定した集計（業者別稼働の表の下）。開始年月の1日〜終了年月の末日（今月を含めば今日まで） */
function periodHtml() {
  const opts = monthOptions();
  // 利用者が期間を選ぶまでは、表示している月の1か月（月を切り替えると一緒に変わる）
  if (!state.periodTouched || !state.period) state.period = { from: state.month, to: state.month };
  const p = state.period;
  const select = (key, label) => `<label>${label} <select class="vm-period-${key}" aria-label="集計の${label}">${opts.map((m) => `<option value="${m}"${m === p[key] ? " selected" : ""}>${monthLabel(m)}</option>`).join("")}</select></label>`;
  const head = `<section class="vm-period"><h3>期間を指定して集計（実績人工）</h3>
    <div class="vm-head vm-period-head">${select("from", "開始年月")}<span>～</span>${select("to", "終了年月")}</div>`;
  const r = buildVendorPeriodActivity({ reports: state.reports, fromMonth: p.from, toMonth: p.to, today: todayIso(), startDate: state.site.startDate || null });
  if (r.error) return `${head}<p class="billing-warn vm-period-error">${escapeHtml(r.error)}</p></section>`;
  const label = r.from === r.to ? monthLabel(r.from) : `${monthLabel(r.from)} ～ ${monthLabel(r.to)}`;
  if (!r.rows.length) return `${head}<p class="vm-lead vm-period-label">集計期間: <b>${label}</b>（${md(r.cutoff)}までの日報）</p><p class="empty-message">この期間までに現場で稼働した業者はありません。</p></section>`;
  const mLabel = (m) => { const [y, mm] = m.split("-").map(Number); return r.months.some((x) => x.slice(0, 4) !== r.months[0].slice(0, 4)) ? `${y}年${mm}月` : `${mm}月`; };
  return `${head}<p class="vm-lead vm-period-label">集計期間: <b>${label}</b>（${md(`${r.from}-01`)}～${md(r.cutoff)}の日報。期間合計は月ごとの実績人工の合計です）。業者を押すと、この期間の日別の稼働を表示します。</p>
    <div class="dash-table-wrap"><table class="dash-table vm-table vm-period-table">
      <thead><tr><th>業者</th><th class="num vm-period-total">期間合計<br><small>（実績人工）</small></th><th class="num">稼働日数</th>${r.months.map((m) => `<th class="num">${mLabel(m)}</th>`).join("")}</tr></thead>
      <tbody>${r.rows.map((x) => `<tr class="vm-vendor-row${x.days ? "" : " vm-row-idle"}"><td><button type="button" class="link-btn vm-vendor" data-vm-period-vendor="${escapeHtml(x.vendor)}">${escapeHtml(x.vendor)}</button><br><small class="vm-total-label">業者合計</small>${x.days ? "" : `<br><small class="empty-message">この期間の稼働なし</small>`}</td><td class="num vm-period-total"><b>${x.total}</b></td><td class="num">${x.days}日</td>${r.months.map((m) => `<td class="num">${x.byMonth[m]}</td>`).join("")}</tr>${lineRows("period", x.vendor, x.lines, (l) => `<td class="num vm-period-total">${l.total}</td><td class="num">${l.days}日</td>${r.months.map((m) => `<td class="num">${l.byMonth[m]}</td>`).join("")}`, 3 + r.months.length)}`).join("")}</tbody>
      <tfoot><tr><th>合計（${r.totals.vendors}社）</th><td class="num vm-period-total"><b>${r.totals.total}</b></td><td class="num">${r.totals.days}日</td>${r.months.map((m) => `<td class="num">${r.monthTotals[m]}</td>`).join("")}</tr></tfoot>
    </table></div>
    <p class="empty-message">数え方は上の表と同じです（通常作業の日だけ・1人＝1人工・請求人工は使いません）。期間内に稼働していない業者も、それより前に稼働していれば表示します（期間内の欄は0）。</p></section>`;
}

/** 業者・期間の日別の稼働（期間の集計の根拠。月ごとの小計つき） */
function periodDetailHtml() {
  const p = state.period;
  const d = buildVendorPeriodDetail({ reports: state.reports, fromMonth: p.from, toMonth: p.to, today: todayIso(), vendor: state.vendor, startDate: state.site.startDate || null });
  const label = p.from === p.to ? monthLabel(p.from) : `${monthLabel(p.from)} ～ ${monthLabel(p.to)}`;
  const minutes = d.days.reduce((t, x) => t + (x.minutes || 0), 0);
  return `<button type="button" class="link-btn vm-back">← 業者別稼働の一覧に戻る</button>
    <h3 class="vm-detail-title">${escapeHtml(d.vendor)}・${label}</h3>
    <dl class="dash-dl dash-dl-row vm-summary"><dt>稼働日</dt><dd>${d.summary.workDays}日</dd><dt>稼働人数（延べ）</dt><dd>${d.summary.workers}人</dd><dt>実績人工（期間合計）</dt><dd>${d.summary.manDays}</dd><dt>作業時間</dt><dd>${hoursText(minutes)}</dd></dl>
    <p class="vm-period-months">月ごと: ${d.months.map((m) => `${monthLabel(m.month)} <b>${m.manDays}</b>（${m.days}日）`).join("・")}</p>
    ${d.days.length
      ? `<div class="dash-table-wrap"><table class="dash-table vm-table vm-days vm-period-days">
          <thead><tr><th>日付</th><th>日の状態</th><th class="num">稼働</th><th>作業時間</th></tr></thead>
          <tbody>${d.days.map((x) => `<tr class="vm-worked"><td><button type="button" class="link-btn vm-report" data-report-id="${escapeHtml(x.reportId)}">${x.date.slice(0, 4)}/${md(x.date)}</button></td><td>${escapeHtml(x.dayStatusLabel)}</td><td class="num">稼働 ${x.workers}人</td><td>${escapeHtml(x.hours || "")}${x.minutes ? `<br><small class="empty-message">${durationLabel(x.minutes)}</small>` : ""}</td></tr>`).join("")}</tbody>
        </table></div>`
      : `<p class="empty-message">この期間の稼働はありません。</p>`}
    <p class="empty-message">通常作業の日報で稼働人数が1人以上の日を表示しています（日ごとの稼働の合計が、期間合計・月ごとの実績人工です）。日付を押すと、その日の日報を開きます。</p>`;
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
          <tbody>${b.rows.map((r) => `<tr class="vm-vendor-row billing-${r.status}" data-billing-row="${escapeHtml(r.vendor)}"><td><button type="button" class="link-btn vm-vendor" data-vm-vendor="${escapeHtml(r.vendor)}">${escapeHtml(r.vendor)}</button><br><small class="vm-total-label">業者合計</small></td><td class="num"><b>${r.manDays}人工</b>${r.multiReportDates.length ? `<br><small class="billing-multi">⚠ 同じ日に日報が複数（${r.multiReportDates.map(md).join("・")}）の分も合算</small>` : ""}</td><td class="num">${r.enteredDays}日</td><td>${statusSelect(r)}</td></tr>${lineRows("billing", r.vendor, r.lines, (l) => `<td class="num">${l.manDays}人工</td><td class="num">${l.enteredDays}日</td><td></td>`, 4)}`).join("")}</tbody>
        </table></div>`
      : `<p class="empty-message">${monthLabel(state.month)}に請求人工を入力した業者はありません。</p>`}
    ${b.sameDayReportDates.length ? `<p class="billing-warn">⚠ 同じ日に日報が複数ある日があります（${b.sameDayReportDates.map(md).join("・")}）。月間請求人工は、その日のすべての日報の請求人工を合算しています。同じ内容の重複登録なら、日報カレンダーから不要な日報を確認してください（自動では削除・0にしません）。</p>` : ""}
    ${b.billedWithoutManDays.length ? `<p class="billing-warn">請求あり・請求人工未入力：${escapeHtml(b.billedWithoutManDays.join("・"))}（請求状況は「請求あり」ですが、この月の請求人工が入力されていません）</p>` : ""}
    <label class="billing-close">月の締め <select class="billing-close-status"${canEdit ? "" : " disabled"}>${BILLING_CLOSE_STATUSES.map((s) => `<option value="${s.value}"${s.value === b.closeStatus ? " selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <p class="empty-message">業者の行の下は、日報に保存された職種の名前ごとの明細で、業者の行は業者合計（明細の合計）です（名前が似ていてもまとめません。名前を直すときは［日報］から日報を開いて修正してください）。請求人工は入力された値だけを使います（稼働人数・実績人工・作業時間からは作りません。未入力は0にしません）。請求状況は請求書を確認して選びます（請求人工が入っていても自動で「請求あり」にはしません。「請求なし」でも請求人工は0にしません）。月を切り替えると、その月に入力された値だけで集計します。</p>`;
}

function detailHtml() {
  const billingTab = state.tab === "billing";
  // 業者別稼働の詳細は工期開始日以降の稼働だけ（請求人工管理の詳細は従来どおり）
  const d = buildVendorMonthDetail({ reports: state.reports, site: state.site, month: state.month, today: todayIso(), vendor: state.vendor, startDate: billingTab ? null : state.site.startDate || null });
  const s = d.summary;
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
  state = { site, reports: (await listReportsBySite(site.id)).filter((r) => !r.isDeleted), month: sameSite && state.month ? state.month : todayIso().slice(0, 7), tab: sameSite ? state.tab : "activity", vendor: sameSite ? state.vendor : null, period: sameSite ? state.period : null, periodTouched: sameSite ? state.periodTouched : false, vendorPeriod: sameSite ? state.vendorPeriod : false, openLine: sameSite ? state.openLine : null };
  siteNameEl.textContent = `（${site.name}）`;
  document.getElementById("vendorMgmtBillingInputBtn").hidden = !hasPermission("editReports");
  renderMonthSelect();
  render();
  showView("view-vendor-management");
}

document.getElementById("backToSiteFromVendorMgmtBtn")?.addEventListener("click", () => navigate(`/sites/${state.site.id}`));
// 請求人工入力: 表示している月の今日（過去の月なら月末）から開き、閉じたあと（保存のたび）この画面を読み直す
document.getElementById("vendorMgmtBillingInputBtn")?.addEventListener("click", () => {
  const today = todayIso();
  const end = (() => { const [y, m] = state.month.split("-").map(Number); return `${state.month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; })();
  const date = today.slice(0, 7) === state.month ? today : today < end ? `${state.month}-01` : end;
  openBillingDialog({ site: state.site, date, onSaved: () => reload() });
});
// 月・タブを切り替えるたびに、現場（請求状況）と日報を読み直してから表示する
monthSelect?.addEventListener("change", async () => { state.month = monthSelect.value; await reload(); });
viewEl?.addEventListener("click", async (e) => {
  const nav = e.target.closest(".vm-month-nav");
  if (nav) { state.month = shiftMonth(state.month, Number(nav.dataset.shift)); renderMonthSelect(); await reload(); return; }
  const tab = e.target.closest("[data-vm-tab]");
  if (tab) { state.tab = tab.dataset.vmTab; state.vendor = null; state.vendorPeriod = false; state.openLine = null; await reload(); return; }
  const vendor = e.target.closest("[data-vm-vendor]");
  if (vendor) { state.vendor = vendor.dataset.vmVendor; state.vendorPeriod = false; render(); window.scrollTo(0, 0); return; }
  const pvendor = e.target.closest("[data-vm-period-vendor]");
  if (pvendor) { state.vendor = pvendor.dataset.vmPeriodVendor; state.vendorPeriod = true; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest(".vm-back")) { state.vendor = null; state.vendorPeriod = false; render(); return; }
  const lt = e.target.closest(".vm-line-toggle");
  if (lt) { state.openLine = state.openLine === lt.dataset.vmLine ? null : lt.dataset.vmLine; render(); return; }
  // 明細の日付: その日の日報を開き、該当の業者の行を目立たせる。保存・キャンセルするとこの画面に戻る（集計し直す）
  const lr = e.target.closest(".vm-line-report");
  if (lr) { navigate(`/sites/${state.site.id}/report/${lr.dataset.reportId}?from=vendors${lr.dataset.cids ? `&hl=${encodeURIComponent(lr.dataset.cids)}` : ""}`); return; }
  const rep = e.target.closest(".vm-report");
  if (rep) navigate(`/sites/${state.site.id}/report/${rep.dataset.reportId}`);
});
viewEl?.addEventListener("change", async (e) => {
  // 期間を指定した集計の開始・終了年月
  const pf = e.target.closest(".vm-period-from, .vm-period-to");
  if (pf) { state.period = { ...(state.period || {}), [pf.classList.contains("vm-period-from") ? "from" : "to"]: pf.value }; state.periodTouched = true; await reload(); return; }
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
