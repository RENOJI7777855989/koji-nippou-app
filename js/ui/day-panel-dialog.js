/* ==========================================================
   日報カレンダーで日報のある日を押したときの「この日の日報」
   ・一部未記入: 何が・誰の分が未記入かを表示 →［未記入を入力］［日報を全部見る］
   ・日報あり／現場作業なし・休工日・雨天作業不可日・事務作業日: 概要を表示 →［簡単に修正］［日報を全部見る］
   入力・修正は既存の日報画面（report-form-view.js）を簡単修正のモードで開いて行う（保存の処理は1つだけ）。
   保存後はカレンダーへ戻る（from=calendar）。日報のデータはここでは読むだけで書き換えない。
   日報の無い日は day-status-dialog.js（この日の状態を選んで登録）。
   ========================================================== */

import { dayStatusOf, labelOf, DAY_STATUSES, staffHeadcountInfo } from "../dashboard/dailyFlow.js";
import { calendarDayState, countVendors, countTrades } from "../dashboard/siteDashboardModel.js";
import { patrolStatusOf } from "../patrolChecklist.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";

const dialog = document.getElementById("dayPanelDialog");
const titleEl = document.getElementById("dayPanelTitle");
const bodyEl = document.getElementById("dayPanelBody");
const actionsEl = document.getElementById("dayPanelActions");

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
export const dayTitle = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}月${d}日（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`;
};

let current = { siteId: "", reportId: "" };

/** 現場作業員の実績人数の合計（通常作業の日だけ） */
const actualTotal = (report) => (report.companies || []).reduce((s, c) => s + (Number(c.actualWorkerCount) || 0), 0);

/**
 * @param {{site: object, report: object, signedCompanyIds?: Set<string>, canEdit: boolean}} p
 */
export function openDayPanel({ site, report, reports = [report], signedMap = new Map(), signedCompanyIds = new Set(), canEdit }) {
  current = { siteId: site.id, reportId: report.id };
  if (reports.length > 1) { openDayList({ site, reports, signedMap, canEdit }); return; }
  const { state, details } = calendarDayState(report, signedCompanyIds);
  const status = dayStatusOf(report);
  const editable = canEdit && !site.completedAt && !report.finalizedAt;
  titleEl.textContent = dayTitle(report.date);

  const stateText = state === "partial" ? "一部未記入" : state === "ok" ? "記入済み" : labelOf(DAY_STATUSES, status);
  const rows = [];
  const progress = report.progressPercent != null && report.progressPercent !== "" ? `${report.progressPercent}%` : "未入力";
  if (status === "work") {
    const cs = (report.companies || []).filter((c) => (c.companyName || "").trim() || (c.occupation || "").trim());
    rows.push(["作業人数", `${actualTotal(report)}人`]);
    rows.push(["業者", cs.length ? `${countVendors(cs)}社・${countTrades(cs)}工種` : "未入力"]);
  }
  rows.push(["進捗率", progress]);
  rows.push(["天気", report.weather || "未選択"]);
  if (status === "rain") rows.push(["中止となった予定作業", report.rainCancelledWork || "未入力"]);
  if (status !== "holiday") {
    const staff = staffHeadcountInfo(report);
    rows.push(["監督・職員", staff.count == null ? "未入力" : `${staff.count}人`]);
  }
  rows.push(["巡回点検", patrolStatusOf(report).label]);

  bodyEl.innerHTML = `
    <p class="day-panel-state is-${escapeHtml(state)}">日報：<b>${escapeHtml(stateText)}</b></p>
    ${state === "partial" ? `<div class="day-panel-missing"><h4>未記入項目</h4><ul>${details.map((d) => `<li>${escapeHtml(d.label)}</li>`).join("")}</ul></div>` : ""}
    <dl class="day-panel-summary">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
    ${report.finalizedAt ? `<p class="day-status-note">工事完了により確定済みのため、閲覧のみです。</p>` : site.completedAt ? `<p class="day-status-note">工事完了の現場のため、閲覧のみです。</p>` : ""}`;

  const buttons = [];
  if (editable && state === "partial") buttons.push(`<button type="button" data-day-go="missing" class="day-panel-main">未記入を入力</button>`);
  if (editable && state !== "partial") buttons.push(`<button type="button" data-day-go="quick" class="day-panel-main">簡単に修正</button>`);
  buttons.push(`<button type="button" data-day-go="full" class="secondary-btn">${editable ? "日報を全部見る" : "日報を見る"}</button>`);
  actionsEl.innerHTML = buttons.join("");
  dialog.showModal();
}

const WHEN = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "不明");

/**
 * 同じ日に日報が複数あるとき: 1件ずつ（日の状態・作業人数・業者・進捗率・作成と最終更新の日時）を並べ、開く日報を選ぶ。
 * 削除は開いた日報の画面の「この日報を削除」で1件ずつ行う（ここでは削除・統合しない）。
 */
function openDayList({ site, reports, signedMap, canEdit }) {
  titleEl.textContent = dayTitle(reports[0].date);
  const items = reports.map((r, i) => {
    const { state } = calendarDayState(r, signedMap.get(r.id) || new Set());
    const status = dayStatusOf(r);
    const cs = (r.companies || []).filter((c) => (c.companyName || "").trim() || (c.occupation || "").trim());
    const meta = [
      status === "work" ? `作業人数 ${actualTotal(r)}人` : labelOf(DAY_STATUSES, status),
      status === "work" ? (cs.length ? `業者 ${countVendors(cs)}社・${countTrades(cs)}工種` : "業者 未入力") : "",
      `進捗率 ${r.progressPercent != null && r.progressPercent !== "" ? `${r.progressPercent}%` : "未入力"}`,
      `作成 ${WHEN(r.createdAt)}`,
      `最終更新 ${WHEN(r.updatedAt)}`
    ].filter(Boolean).join("／");
    const st = state === "partial" ? "一部未記入" : state === "ok" ? "記入済み" : labelOf(DAY_STATUSES, status);
    return `<li><p class="day-panel-item-head">${i + 1}. 日報（${escapeHtml(st)}）</p><p class="day-panel-item-meta">${escapeHtml(meta)}</p><button type="button" class="secondary-btn" data-day-open="${escapeHtml(r.id)}">この日報を開く</button></li>`;
  });
  bodyEl.innerHTML = `
    <p class="day-panel-state is-partial">この日の日報：<b>${reports.length}件</b></p>
    <p class="day-status-note">同じ日に日報が複数あります。1件ずつ開いて内容を確認し、不要な日報は日報の画面の下の「この日報を削除」で削除できます（自動では削除・統合しません）。${!canEdit || site.completedAt ? "（この現場・権限では閲覧のみです）" : ""}</p>
    <ul class="day-panel-list">${items.join("")}</ul>`;
  actionsEl.innerHTML = "";
  dialog.showModal();
}

dialog?.addEventListener("click", (e) => {
  const open = e.target.closest("[data-day-open]");
  if (open) {
    dialog.close();
    navigate(`/sites/${current.siteId}/report/${open.dataset.dayOpen}?from=calendar`);
    return;
  }
  const btn = e.target.closest("[data-day-go]");
  if (!btn) return;
  const mode = btn.dataset.dayGo;
  dialog.close();
  const q = mode === "full" ? "from=calendar" : `mode=${mode}&from=calendar`;
  navigate(`/sites/${current.siteId}/report/${current.reportId}?${q}`);
});
document.getElementById("dayPanelCloseBtn")?.addEventListener("click", () => dialog.close());
