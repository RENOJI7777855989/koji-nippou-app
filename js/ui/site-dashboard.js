/* ==========================================================
   現場ダッシュボード（現場詳細画面の上部）。2つのタブに分ける。
   ・現場掲示: 作業員・業者に見せる内容（A3「今日の現場シート」と同じ考え方）。監督向けの
     確認事項・日誌状況は出さない。請求人工は出さない。
   ・監督管理: 今日の確認事項・危険予知活動表の受付・現場概要・昨日→今日・巡回点検・日誌・日誌状況。
     日報カレンダー（#reportCalendar。描画は site-detail-view.js）も監督管理タブの中に移して表示する。
   日誌の内容は表示するだけ（編集は日誌で行う）。危険予知活動表だけは、日報とは別の提出物として
   監督管理タブで受け付ける（js/ky/kySubmissions.js）。
   集計は js/dashboard/siteDashboardModel.js、A3「今日の現場シート」は todaySheetHtml.js。
   ========================================================== */

import { listReportsBySite } from "../reports.js";
import { dbGetAll } from "../db.js";
import { hasPermission } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { buildDashboardModel } from "../dashboard/siteDashboardModel.js";
import { buildTodaySheetHtml } from "../dashboard/todaySheetHtml.js";
import { BOARD_SECTIONS, BOARD_LAYOUT_VERSION, KY_BOARD_LABELS, buildInfoBand } from "../dashboard/boardContent.js";
import { openReportPrintDialog } from "./report-print-dialog.js";
import { listKySubmissions, addKyVendor, setKyState } from "../ky/kySubmissions.js";
import { showMessage } from "./common.js";

const root = document.getElementById("siteDashboard");
let current = { site: null, date: null, onFilter: null };
// 表示中のタブ（board=現場掲示 / manage=監督管理）。端末ごとの表示の好みとして覚える（保存できなくても動く）
const TAB_KEY = "siteDashboardTab";
let currentTab = (() => { try { return localStorage.getItem(TAB_KEY) === "manage" ? "manage" : "board"; } catch { return "board"; } })();

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmtDate = (iso, weekday) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}（${weekday}）`;
};

async function loadModel(site, date) {
  const reports = (await listReportsBySite(site.id)).filter((r) => !r.isDeleted);
  const ids = new Set(reports.map((r) => r.id));
  const signatures = (await dbGetAll("signatures")).filter((s) => ids.has(s.reportId));
  const kySubmissions = await listKySubmissions(site.id, date);
  return buildDashboardModel({ site, reports, signatures, date, kySubmissions });
}

/** 上部の情報帯（工期・本日・工事○日目・工期経過・残り・進捗・天気）。A3の印刷と同じ buildInfoBand から作る */
function infoBandHtml(model) {
  return buildInfoBand(model).map((it) => `<span class="dash-chip dash-band-${it.key}${it.missing ? " is-missing" : ""}">${escapeHtml(it.label)} <b>${escapeHtml(it.value)}</b></span>`).join("");
}

function progressHistoryHtml(h) {
  if (!h.progressHistory?.length) return "";
  const md = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
  return `<p class="dash-sub dash-progress-history">進捗の推移: ${h.progressHistory.map((p) => `${md(p.date)} ${p.value}%`).join(" → ")}</p>`;
}

function render(model) {
  const h = model.header;
  const canEdit = hasPermission("editReports") && !current.site.completedAt;
  const empty = (text) => `<p class="dash-empty">${escapeHtml(text)}</p>`;

  const flowHtml = model.flow.length
    ? `<ol class="dash-flow">${model.flow
        .map((f) => `<li class="dash-flow-item${f.kind === "delivery" ? ` is-delivery${f.direction === "out" ? " is-out" : ""}` : ""}${f.cancelled ? " is-cancelled" : ""}">
          <span class="dash-flow-time">${escapeHtml(f.time || "--:--")}</span>
          <span class="dash-flow-mark" aria-hidden="true">${f.mark}</span>
          <span class="dash-flow-body"><span class="dash-flow-title">${f.kind !== "delivery" && f.kindLabel && f.title !== f.kindLabel ? `<span class="dash-kind">${escapeHtml(f.kindLabel)}</span>` : ""}${escapeHtml(f.title)}</span>${f.note ? `<span class="dash-flow-note">${escapeHtml(f.note)}</span>` : ""}</span>
          ${f.status ? `<span class="dash-badge">${escapeHtml(f.status)}</span>` : ""}
        </li>`)
        .join("")}</ol>`
    : empty(model.reportId ? "日誌の「本日の現場の流れ」「搬入・搬出」に入力すると、ここに時刻順で表示されます。" : "この日の日誌はまだありません。");

  // 1行目: 時刻・区分（◆搬入／◇搬出）・品名・数量・状況、2行目: 業者、3行目: 元 → 先。タップで車両・備考まで開く
  const deliveryHtml = model.deliveries.length
    ? model.deliveries
        .map((d) => `<details class="dash-delivery${d.direction === "out" ? " is-out" : ""}${d.status === "cancelled" ? " is-cancelled" : ""}">
          <summary><span class="dash-flow-time">${escapeHtml(d.time || "--:--")}</span><span class="dash-dir">${d.mark} ${escapeHtml(d.directionLabel)}</span>
            <span class="dash-dlv-main"><b>${escapeHtml(d.item || d.directionLabel)}</b>${d.quantity ? ` ${escapeHtml(d.quantity)}` : ""}</span><span class="dash-badge">${escapeHtml(d.statusLabel)}</span>
            ${d.vendor ? `<span class="dash-sub">${escapeHtml(d.vendor)}</span>` : ""}
            ${d.origin || d.destination ? `<span class="dash-sub">${escapeHtml(d.origin || "―")} → ${escapeHtml(d.destination || "―")}</span>` : ""}</summary>
          <dl class="dash-dl">
            ${[[`${d.directionLabel}業者`, d.vendor], ["数量", d.quantity], [`${d.directionLabel}元`, d.origin], [`${d.directionLabel}先`, d.destination], ["車両", d.vehicle], ["備考", d.note]]
              .filter(([, v]) => v)
              .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v).replace(/\n/g, "<br>")}</dd>`)
              .join("")}
          </dl>
        </details>`)
        .join("")
    : empty("本日の搬入・搬出はありません。");
  const inCount = model.deliveries.filter((d) => d.direction === "in").length;
  const outCount = model.deliveries.length - inCount;

  const s = model.staff;
  const staffHtml = `
    <div class="dash-big">${s.today}<small>人</small></div>
    <p class="dash-sub">本日の実績人数${s.plannedToday ? `（予定 ${s.plannedToday}人）` : ""}</p>
    <dl class="dash-dl dash-dl-row">
      ${s.byOccupation.map((o) => `<dt>${escapeHtml(o.occupation)}</dt><dd>${o.count}人<small class="dash-sub">（累計${o.cumulative}人）</small></dd>`).join("")}
      <dt>職長</dt><dd>${s.foremen}人</dd><dt>業者</dt><dd>${s.vendors}社</dd>
      ${s.supervisors ? `<dt>現場監督</dt><dd>${s.supervisors}人</dd>` : ""}
      ${s.supervisors ? `<dt>計（社員を含む）</dt><dd>${s.totalToday}人</dd>` : ""}
      <dt>累計（社員を含む）</dt><dd>${s.cumulative.toLocaleString()}人</dd>
      <dt>延べ労働時間</dt><dd>${s.laborHoursCumulative.toLocaleString()}時間</dd>
    </dl>`;

  const d = model.diary;
  const diaryHtml = d
    ? `<dl class="dash-dl">
        <dt>天候</dt><dd>${escapeHtml(d.weather || "-")}${d.temperature ? `　${escapeHtml(d.temperature)}` : ""}</dd>
        <dt>作業</dt><dd>${model.works.length ? model.works.map((w) => escapeHtml(`${w.vendor ? w.vendor + "：" : ""}${w.content || w.occupation || ""}`)).join("<br>") : "-"}</dd>
        ${d.tomorrowPlan ? `<dt>明日の予定</dt><dd>${escapeHtml(d.tomorrowPlan).replace(/\n/g, "<br>")}</dd>` : ""}
      </dl>
      <p class="dash-sub">${d.confirmed ? "確認済み" : "未確認"}・${d.printed ? "印刷済み" : "未印刷"}</p>`
    : empty("この日の日誌はまだありません。");

  // 業者別 稼働状況（人工は稼働人数を 1人＝1人工 として数えた現場集計の値。請求人工は表示しない）
  const fmtNum = (n) => (n == null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
  const vendorRows = model.works.filter((w) => w.vendor || w.actual);
  const totalWorkers = vendorRows.reduce((s, w) => s + (w.actual || 0), 0);
  const totalManDays = vendorRows.reduce((s, w) => s + (w.manDays || 0), 0);
  const vendorHtml = vendorRows.length
    ? `<div class="dash-table-wrap"><table class="dash-table dash-vendors">
        <thead><tr><th>業者</th><th>工種</th><th class="num">稼働人数</th><th>作業時間</th><th class="num">人工</th><th class="num">累計人工</th></tr></thead>
        <tbody>${vendorRows.map((w) => `<tr><td><b>${escapeHtml(w.vendor || "（業者名なし）")}</b></td><td>${escapeHtml(w.occupation)}</td><td class="num dash-workers"><b>${w.actual ?? "-"}</b>人</td><td>${escapeHtml(w.hours || "-")}${w.hoursDuration ? `<br><small class="dash-sub">${escapeHtml(w.hoursDuration)}</small>` : ""}</td><td class="num">${fmtNum(w.manDays)}</td><td class="num">${fmtNum(w.cumulativeManDays)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><th colspan="2">合計（${vendorRows.length}社）</th><th class="num"><b>${totalWorkers}</b>人</th><th></th><th class="num">${fmtNum(totalManDays)}</th><th></th></tr></tfoot>
      </table></div><p class="dash-sub">人工は稼働人数を1人＝1人工として数えた現場集計の値です。</p>`
    : empty(model.reportId ? "日誌の業者欄に入力すると、ここに業者別の稼働人数が表示されます。" : "この日の日誌はまだありません。");
  const textCard = (text, none) => (text ? `<p class="dash-notice">${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : empty(model.reportId ? none : "この日の日誌はまだありません。"));
  const focusHtml = textCard(model.diary?.focusInstructions, "日誌の「本日の重点指示」に入力すると、ここに表示されます。");
  const coordHtml = textCard(model.diary?.workCoordination, "日誌の「作業間の連絡・調整」に入力すると、ここに表示されます。");

  // 業者別の安全注意事項・連絡事項・巡回点検（いずれも日誌の入力から）
  const safetyHtml = model.safety.length
    ? model.safety.map((v) => `<div class="dash-safety"><b>${escapeHtml(v.vendor)}</b>${v.occupation ? ` <span class="dash-sub">${escapeHtml(v.occupation)}</span>` : ""}<ul>${v.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`).join("")
    : empty(model.reportId ? "日誌の業者ごとの「安全注意事項」に入力すると、ここに業者別に表示されます。" : "この日の日誌はまだありません。");
  const notice = model.diary?.remarks || "";
  const noticeHtml = notice ? `<p class="dash-notice">${escapeHtml(notice).replace(/\n/g, "<br>")}</p>` : empty(model.reportId ? "日誌の「連絡事項」に入力すると、ここに表示されます。" : "この日の日誌はまだありません。");
  const p = model.patrol;
  const ps = model.patrolStatus;
  // 巡回点検の状況（表示時に判定。休工日等で記録が無ければ未実施、日報が無ければ記録なし）
  const patrolStateHtml = `<p class="dash-patrol-state is-${ps.state}">巡回点検：<b>${escapeHtml(ps.label)}</b></p>`;
  const patrolHtml = p && ps.state !== "notdone"
    ? `${patrolStateHtml}<dl class="dash-dl dash-dl-row"><dt>良好 ○</dt><dd>${p.good}</dd><dt>不良 ×</dt><dd>${p.bad}</dd><dt>該当なし</dt><dd>${p.na}</dd><dt>未記入</dt><dd>${p.unset}</dd></dl>
      ${p.badItems.length || p.comment
        ? `<div class="dash-patrol-attention"><h4>巡回点検・要確認</h4>
            ${p.badItems.length ? `<ul class="dash-bad">${p.badItems.map((i) => `<li>${escapeHtml(i)}　<b>×</b></li>`).join("")}</ul>` : ""}
            ${p.comment ? `<p class="dash-sub">是正指示あり（その日の巡回点検全体への指示）</p><p>${escapeHtml(p.comment).replace(/\n/g, "<br>")}</p>` : ""}
            <p class="dash-sub">対応したかどうか（対応状況）は記録していないため、ここでは「要確認」として表示しています。</p></div>`
        : ""}
      ${p.inspector ? `<p class="dash-sub">巡回者: ${escapeHtml(p.inspector)}</p>` : ""}`
    : `${patrolStateHtml}<p class="dash-sub">${ps.state === "none" ? "この日の日報が無いため、巡回点検の記録はありません（未実施とは判定しません）。" : "巡回点検の記録はありません（03-2の巡回点検の欄は斜線になります）。"}</p>`;
  // 現場掲示用の巡回点検（状況・件数・×の項目・是正指示。対応状況は推測しない）
  const patrolBoardHtml = `${patrolStateHtml}${p && ps.state !== "notdone" && ps.state !== "blank" ? `<p class="dash-sub">良好○ ${p.good}　不良× ${p.bad}　該当なし－ ${p.na}${p.unset ? `　未記入 ${p.unset}` : ""}</p>${p.badItems.length || p.comment ? `<div class="dash-patrol-attention"><h4>巡回点検・要確認</h4>${p.badItems.length ? `<ul class="dash-bad">${p.badItems.map((i) => `<li>${escapeHtml(i)}　<b>×</b></li>`).join("")}</ul>` : ""}${p.comment ? `<p class="dash-sub">是正指示</p><p>${escapeHtml(p.comment).replace(/\n/g, "<br>")}</p>` : ""}</div>` : ""}` : ""}`;

  // ① 今日の状態（日報なし／通常作業／作業なし／休工日）
  const stateHtml = !model.reportId
    ? `<div class="dash-state is-missing">この日の日報は<b>未入力</b>です</div>`
    : model.dayStatus === "nowork"
      ? `<div class="dash-state is-nowork">本日は<b>作業なし</b>（稼働人数・人工には数えません）</div>`
      : model.dayStatus === "office"
        ? `<div class="dash-state is-office">本日は<b>事務作業日</b>（稼働人数・人工には数えません）</div>`
      : model.dayStatus === "holiday"
        ? `<div class="dash-state is-holiday">本日は<b>休工日</b>（稼働人数・人工には数えません）</div>`
        : "";
  // ② 今日の確認事項・要確認（日報DBの値から判定）
  const att = model.attention;
  const checksHtml = `
    <div class="dash-attention${att.length ? " has-items" : ""}">
      <h4>要確認 ${att.length}件</h4>
      ${att.length ? `<ul>${att.map((c) => `<li><b>${escapeHtml(c.label)}</b>　${escapeHtml(c.value)}</li>`).join("")}</ul>` : `<p class="dash-sub">要確認の項目はありません。</p>`}
    </div>
    <dl class="dash-checks">${model.checks.map((c) => `<dt>${escapeHtml(c.label)}</dt><dd class="lv-${c.level}">${escapeHtml(c.value)}</dd>`).join("")}</dl>`;
  // 昨日 → 今日（片方の日報が無ければ比較しない）
  const cmp = model.compare;
  const fig = (x, key, unit) => (!x ? "日報なし" : x.state ? x.state : x[key] == null ? "未入力" : `${fmtNum(x[key])}${unit}`);
  const cmpRows = [["作業員", "workers", "人"], ["人工", "manDays", ""], ["進捗率", "progress", "%"], ["業者数", "vendors", "社"]]
    .map(([label, key, unit]) => `<tr><th>${label}</th><td>${escapeHtml(fig(cmp.prev, key, unit))}</td><td>→</td><td><b>${escapeHtml(fig(cmp.now, key, unit))}</b></td></tr>`).join("");
  const md2 = (iso) => { const [, m2, d2] = iso.split("-").map(Number); return `${m2}/${d2}`; };
  const compareHtml = `<table class="dash-compare"><thead><tr><th></th><th>${md2(cmp.prevDate)}（前日）</th><th></th><th>${md2(h.date)}</th></tr></thead><tbody>${cmpRows}</tbody></table>${!cmp.prev || !cmp.now ? `<p class="dash-sub">日報が無い日は比較しません。</p>` : ""}`;
  // 現場概要（自動）
  const ov = model.overview;
  const overviewHtml = `<dl class="dash-dl dash-dl-row">
      ${ov.constructionNumber ? `<dt>工事番号</dt><dd>${escapeHtml(ov.constructionNumber)}</dd>` : ""}
      <dt>進捗率</dt><dd>${ov.progress != null ? `${ov.progress}%` : "未入力"}</dd>
      <dt>本日稼働</dt><dd>${ov.workers != null ? `${ov.workers}人` : escapeHtml(ov.stateLabel)}</dd>
      <dt>人工</dt><dd>${ov.manDays != null ? fmtNum(ov.manDays) : "-"}</dd>
      <dt>業者</dt><dd>${ov.vendors != null ? `${ov.vendors}社` : "-"}</dd>
      <dt>要確認</dt><dd>${ov.attentionCount}件</dd>
    </dl>${ov.focus ? `<p class="dash-sub">本日の重点指示: ${escapeHtml(ov.focus)}</p>` : ""}`;

  const st = model.status;
  const statusRow = (label, value, filter) =>
    `<button type="button" class="dash-status-row"${filter ? ` data-filter="${filter}"` : " disabled"}><span>${label}</span><b>${value == null ? "-" : value}</b></button>`;
  const statusHtml = `
    ${st.scheduled == null ? `<p class="dash-sub">工事開始日を入れると提出予定・未提出を数えます。</p>` : ""}
    ${statusRow("提出予定", st.scheduled, null)}
    ${statusRow("未提出", st.missing, "missing")}
    ${statusRow("未署名", st.unsigned, null)}
    ${statusRow("未承認（未確認）", st.unconfirmed, "unconfirmed")}
    ${statusRow("未印刷", st.unprinted, "unprinted")}
    <p class="dash-sub">${escapeHtml(fmtDate(h.date, h.weekday))}までの日誌</p>`;

  // 現場掲示に出す日の状態（作業なし・休工日だけ。日報未入力は監督向けの情報なので出さない）
  const boardStateHtml = { nowork: `<div class="dash-state is-nowork">本日は<b>作業なし</b></div>`, office: `<div class="dash-state is-office">本日は<b>事務作業日</b></div>`, holiday: `<div class="dash-state is-holiday">本日は<b>休工日</b></div>` }[model.dayStatus] || "";

  // 危険予知活動表（紙のKY活動表が提出されたか。日報とは別の提出物）。掲示は業者ごとの提出済み／未提出だけ（時刻は出さない）
  const ky = model.ky;
  const kyManageSummary = `<p class="dash-ky-summary">対象 <b>${ky.targetCount}</b>業者　提出済み <b>${ky.submittedCount}</b>業者　未提出 <b>${ky.notSubmittedCount}</b>業者　対象外 <b>${ky.excludedCount}</b>業者</p>`;
  const kyBoardHtml = ky.rows.length
    ? `<ul class="dash-ky-list">${ky.rows.map((r) => `<li class="is-${r.state}"><b>${escapeHtml(r.vendorName)}</b>　${KY_BOARD_LABELS[r.state]}</li>`).join("")}</ul><p class="dash-ky-summary">対象 <b>${ky.targetCount}</b>業者　提出済み <b>${ky.submittedCount}</b>業者　未提出 <b>${ky.notSubmittedCount}</b>業者${ky.excludedCount ? `　対象外 <b>${ky.excludedCount}</b>業者` : ""}</p>`
    : empty("本日の危険予知活動表の対象業者は、まだ登録されていません。");
  const hhmm = (iso) => { if (!iso) return "—"; const t = new Date(iso); return Number.isNaN(t.getTime()) ? "—" : `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`; };
  const kyRowHtml = (r) => `<tr class="ky-${r.state}"><td><b>${escapeHtml(r.vendorName)}</b></td>
      <td><div class="dash-ky-states" role="group" aria-label="${escapeHtml(r.vendorName)}の提出状況">${[["submitted", "提出済み"], ["not_submitted", "未提出"], ["excluded", "対象外"]]
        .map(([v, label]) => `<button type="button" class="dash-ky-state${r.state === v ? " is-on" : ""}" data-ky-id="${escapeHtml(r.id)}" data-ky-state="${v}" aria-pressed="${r.state === v}"${canEdit ? "" : " disabled"}>${label}</button>`).join("")}</div></td>
      <td class="num">${hhmm(r.submittedAt)}</td></tr>`;
  const candidateChips = (names) => names.map((n) => `<button type="button" class="dash-ky-add" data-ky-add="${escapeHtml(n)}"${canEdit ? "" : " disabled"}>＋ ${escapeHtml(n)}</button>`).join("");
  const prevLabel = ky.candidates.previousDate ? (() => { const [, pm, pd] = ky.candidates.previousDate.split("-").map(Number); return `${pm}/${pd}`; })() : "";
  const kyManageHtml = `
    ${kyManageSummary}
    ${ky.notSubmittedCount ? `<p class="dash-ky-missing">未提出: ${ky.notSubmittedNames.map((n) => escapeHtml(n)).join("・")}</p>` : ""}
    ${ky.rows.length
      ? `<div class="dash-table-wrap"><table class="dash-table dash-ky-table"><thead><tr><th>業者</th><th>状態</th><th class="num">提出時刻</th></tr></thead><tbody>${ky.rows.map(kyRowHtml).join("")}</tbody></table></div>`
      : `<p class="dash-sub">対象業者を選んで登録してください（日報がまだ無くても登録できます）。</p>`}
    ${canEdit
      ? `<div class="dash-ky-candidates">
          ${ky.candidates.today.length ? `<p class="dash-sub">この日の日報の業者（押すと対象に追加）</p><div class="dash-ky-chips">${candidateChips(ky.candidates.today)}</div>` : ""}
          ${ky.candidates.previous.length ? `<p class="dash-sub">前の作業日（${prevLabel}）の業者（候補。押した業者だけ対象に追加）</p><div class="dash-ky-chips">${candidateChips(ky.candidates.previous)}</div>` : ""}
          <form class="dash-ky-form"><input type="text" class="dash-ky-name" placeholder="業者名を入力（日報に無い業者も登録できます）" aria-label="追加する業者名"><button type="submit" class="secondary-btn">追加</button></form>
        </div>`
      : ""}
    <p class="dash-sub">会社指定の紙のKY活動表が現場に提出されたかだけを記録します（KYの内容は記録しません）。「未提出」は紙がまだ提出されていないという意味です。日報とは別の提出物で、日報の入力・確認とは連動しません。「提出済み」を押した時刻を提出時刻として記録します。業者は業者名で区別します（表記が違えば別の業者）。</p>`;

  const worksHtml = model.works.length
    ? `<div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>業者</th><th>工種</th><th>予定/実績</th><th>作業時間</th><th>作業内容</th><th>職長</th><th>使用機械</th></tr></thead>
        <tbody>${model.works
          .map((w) => `<tr><td>${escapeHtml(w.vendor)}</td><td>${escapeHtml(w.occupation)}</td><td class="num">${w.planned ?? "-"} / ${w.actual ?? "-"}</td><td>${escapeHtml(w.hours)}${w.hoursDuration ? `<br><small class="dash-sub">${escapeHtml(w.hoursDuration)}</small>` : ""}</td><td>${escapeHtml(w.content)}</td><td>${escapeHtml(w.foreman)}</td><td>${escapeHtml(w.machinery)}</td></tr>`)
          .join("")}</tbody></table></div>`
    : empty("本日の作業（日誌の業者欄）はまだありません。");

  // 現場掲示の欄（欄名・並びは boardContent.js の BOARD_SECTIONS。A3の印刷も同じ定義を使う）
  const BOARD_ICONS = { works: "👷", flow: "", deliveries: "🚚", focus: "🎯", ky: "📝", patrol: "🔍", safety: "⚠️", staff: "👷", coordination: "🤝", notice: "📢", tomorrow: "📅" };
  const tomorrowHtml = textCard(model.diary?.tomorrowPlan, "日誌の「明日の予定」に入力すると、ここに表示されます。");
  const boardBody = {
    works: model.isWork ? vendorHtml + `<h4 class="dash-subhead">作業内容・職長・使用機械</h4>` + worksHtml : "",
    flow: flowHtml,
    deliveries: deliveryHtml,
    focus: focusHtml,
    ky: kyBoardHtml,
    patrol: patrolBoardHtml,
    safety: safetyHtml,
    staff: staffHtml,
    coordination: coordHtml,
    notice: noticeHtml,
    tomorrow: tomorrowHtml
  };
  const boardHtml = BOARD_SECTIONS.filter((sec) => boardBody[sec.key])
    .map((sec) => `<section class="dash-card${sec.key === "works" ? " dash-card-wide" : ""}${sec.key === "flow" ? " dash-card-flow" : ""}${sec.key === "ky" ? " dash-ky-board" : ""}" data-board-section="${sec.key}"><h3>${BOARD_ICONS[sec.key] ? BOARD_ICONS[sec.key] + " " : ""}${escapeHtml(sec.title)}${sec.key === "deliveries" && model.deliveries.length ? `<span class="dash-dlv-count">搬入${inCount}件・搬出${outCount}件</span>` : ""}</h3>${boardBody[sec.key]}</section>`)
    .join("");

  parkCalendar();
  root.innerHTML = `
    <div class="dash-head">
      <div class="dash-title-row">
        <h2 class="dash-title">🏗 現場ダッシュボード</h2>
        <div class="dash-date">
          <button type="button" class="secondary-btn dash-nav" data-shift="-1" aria-label="前の日">◀</button>
          <input type="date" class="dash-date-input" value="${escapeHtml(h.date)}" aria-label="表示する日">
          <button type="button" class="secondary-btn dash-nav" data-shift="1" aria-label="次の日">▶</button>
          <button type="button" class="secondary-btn dash-nav" data-today="1">今日</button>
        </div>
      </div>
      <p class="dash-site">${escapeHtml(h.siteName)}　<span class="dash-sub">${escapeHtml(fmtDate(h.date, h.weekday))}</span></p>
      <div class="dash-chips">
        ${h.constructionNumber ? `<span class="dash-chip">工事番号 ${escapeHtml(h.constructionNumber)}</span>` : ""}
        ${infoBandHtml(model)}
      </div>
      ${progressHistoryHtml(h)}
      ${model.sameDayCount > 1 ? `<p class="dash-sub">この日の日誌が${model.sameDayCount}件あります（最後に更新したものを表示）。</p>` : ""}
    </div>
    <div class="dash-tabs" role="tablist">
      <button type="button" role="tab" class="dash-tab${currentTab === "board" ? " is-active" : ""}" data-tab="board" aria-selected="${currentTab === "board"}">📋 現場掲示</button>
      <button type="button" role="tab" class="dash-tab${currentTab === "manage" ? " is-active" : ""}" data-tab="manage" aria-selected="${currentTab === "manage"}">🛠 監督管理</button>
    </div>
    <div class="dash-grid dash-panel" data-panel="board"${currentTab === "board" ? "" : " hidden"}>
      ${boardStateHtml ? `<section class="dash-card dash-card-wide">${boardStateHtml}</section>` : ""}
      ${boardHtml}
      <p class="dash-sub dash-board-ver">現場掲示レイアウト ${escapeHtml(BOARD_LAYOUT_VERSION)}版（「🖨 現場掲示をA3印刷」も同じ内容・同じ版で印刷します）</p>
    </div>
    <div class="dash-grid dash-panel" data-panel="manage"${currentTab === "manage" ? "" : " hidden"}>
      <section class="dash-card dash-card-wide dash-today"><h3>✅ 今日の確認事項</h3>${stateHtml}${checksHtml}</section>
      <section class="dash-card dash-card-wide dash-ky"><h3>📝 本日の危険予知活動表 提出状況</h3>${kyManageHtml}</section>
      <section class="dash-card"><h3>🏗 現場概要</h3>${overviewHtml}</section>
      <section class="dash-card"><h3>📈 昨日 → 今日</h3>${compareHtml}</section>
      <section class="dash-card"><h3>🔍 本日の巡回点検（03-2の巡回点検記録）</h3>${patrolHtml}</section>
      <section class="dash-card"><h3>📋 今日の日誌</h3>${diaryHtml}</section>
      <section class="dash-card"><h3>📊 日誌状況</h3>${statusHtml}</section>
      <section class="dash-card dash-card-wide"><h3>📅 日報カレンダー</h3><div class="dash-calendar-slot"></div></section>
    </div>
    <div class="dash-actions">
      ${canEdit ? `<button type="button" data-action="diary">＋日誌</button><button type="button" data-action="deliveries" class="secondary-btn">🚚搬入・搬出</button><button type="button" data-action="companies" class="secondary-btn">👷業者</button>` : ""}
      <button type="button" data-action="print" class="secondary-btn">🖨 現場掲示をA3印刷</button>
    </div>`;
  root.hidden = false;
  // 日報カレンダーを監督管理タブの中へ移す（要素そのものを移すので、描画・クリックの処理はそのまま動く）
  const slot = root.querySelector(".dash-calendar-slot");
  const cal = document.getElementById("reportCalendar");
  if (slot && cal) slot.appendChild(cal);
}

// 再描画（innerHTML の置き換え）でカレンダーの要素が消えないよう、いったん元の位置に戻す
const calendarHome = (() => { const cal = document.getElementById("reportCalendar"); if (!cal) return null; const mark = document.createComment("reportCalendar"); cal.before(mark); return mark; })();
function parkCalendar() {
  const cal = document.getElementById("reportCalendar");
  if (cal && calendarHome && root.contains(cal)) calendarHome.after(cal);
}

async function refresh() {
  const model = await loadModel(current.site, current.date);
  current.model = model;
  render(model);
}

/** 日誌を開く（その日の日誌があれば編集、無ければその日付で新規）。focus は入力画面で表示する欄 */
function openDiary(focus) {
  if (focus) window.__reportFormFocus = focus;
  const base = `/sites/${current.site.id}`;
  navigate(current.model.reportId ? `${base}/report/${current.model.reportId}` : `${base}/report/new?date=${current.date}`);
}

root?.addEventListener("click", async (e) => {
  const tab = e.target.closest(".dash-tab");
  if (tab) {
    currentTab = tab.dataset.tab === "manage" ? "manage" : "board";
    try { localStorage.setItem(TAB_KEY, currentTab); } catch { /* 保存できない環境でも切り替えは動く */ }
    root.querySelectorAll(".dash-tab").forEach((b) => { const on = b.dataset.tab === currentTab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    root.querySelectorAll(".dash-panel").forEach((p) => { p.hidden = p.dataset.panel !== currentTab; });
    return;
  }
  // 危険予知活動表: 提出済／未提出／対象外（提出済にした時刻はデータ層が自動で記録する）
  const kyState = e.target.closest("[data-ky-state]");
  if (kyState) {
    try { await setKyState(kyState.dataset.kyId, kyState.dataset.kyState); await refresh(); }
    catch (err) { showMessage(err.message, true); }
    return;
  }
  const kyAdd = e.target.closest("[data-ky-add]");
  if (kyAdd) {
    try { await addKyVendor({ siteId: current.site.id, date: current.date, vendorName: kyAdd.dataset.kyAdd }); await refresh(); }
    catch (err) { showMessage(err.message, true); }
    return;
  }
  const nav = e.target.closest(".dash-nav");
  if (nav) {
    current.date = nav.dataset.today ? todayIso() : shiftDate(current.date, Number(nav.dataset.shift));
    await refresh();
    return;
  }
  const statusBtn = e.target.closest(".dash-status-row[data-filter]");
  if (statusBtn && current.onFilter) {
    current.onFilter(statusBtn.dataset.filter);
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "diary") openDiary(null);
  if (action === "deliveries") openDiary("deliveries");
  if (action === "companies") openDiary("companies");
  if (action === "print") {
    const html = buildTodaySheetHtml(current.model);
    openReportPrintDialog({
      html,
      mode: "print",
      title: `現場掲示 今日の現場シート（${current.model.header.date}）A3横`,
      note: "A3・横向きで印刷してください（iPadは共有→プリント、Windowsは印刷画面で用紙A3・横を選択）。03-2の日報とは別の帳票で、日報の印刷記録には残りません。"
    });
  }
});

root?.addEventListener("submit", async (e) => {
  if (!e.target.classList.contains("dash-ky-form")) return;
  e.preventDefault();
  const input = e.target.querySelector(".dash-ky-name");
  try {
    const { created } = await addKyVendor({ siteId: current.site.id, date: current.date, vendorName: input.value });
    if (!created) showMessage("その業者はこの日の危険予知活動表に登録済みです。");
    await refresh();
  } catch (err) { showMessage(err.message, true); }
});

root?.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("dash-date-input") || !e.target.value) return;
  current.date = e.target.value;
  await refresh();
});

/**
 * @param {object} site
 * @param {{onFilter?: (filter: string) => void}} [options] 日誌状況の数字を押したときに日報一覧を絞り込む
 */
export async function renderSiteDashboard(site, { onFilter } = {}) {
  if (!root) return;
  const keepDate = current.site?.id === site.id && current.date ? current.date : todayIso();
  current = { site, date: keepDate, onFilter, model: null };
  await refresh();
}
