/* ==========================================================
   請求人工入力（業者管理・現場ダッシュボードの「💴 請求人工入力」。2026-10-17）
   業者から請求された人工を、日ごとに業者の行へ続けて入力する画面（朝礼入力と同じ形）。
   ・保存先は既存の日報の請求人工（companies[].billingManDays）だけ。月ごとの請求人工を保存する項目は作らない
     （月の合計は従来どおり billingMonthly.js の buildMonthlyBilling が日報から計算する＝二重管理にしない）。
   ・保存の直前に日報を読み直し、その行の請求人工だけを書き換える（実績人数・予定人数・作業時間・ほかの項目・ほかの行は変えない）。
   ・空欄＝未入力（保存しない値＝""）、0＝0人工。未入力を0にしない。0以上の数（小数可。小数点以下2桁まで）だけ保存する。
   ・稼働人数・稼働人工（1人＝1人工）は参考として並べるだけで、請求人工の計算には使わない。
   ・同じ画面で、その月の業者別の請求人工の合計（表示のたびに計算）・請求状況（既存の site.billingMonths。setBillingStatus）と、
     請求人工が未入力の行がある日を確認でき、押すとその日へ移る。
   ・現場掲示・A3・PDF・03-2・日報カレンダーには出さない（この画面と業者管理・日報画面だけ）。
   ========================================================== */

import { getReport, updateReport, listReportsBySite } from "../reports.js";
import { getSite } from "../sites.js";
import { dayStatusOf, isWorkDay, labelOf as dayLabelOf, DAY_STATUSES } from "../dashboard/dailyFlow.js";
import { buildMonthlyBilling, billingValueOf, setBillingStatus, BILLING_STATUSES } from "../billing/billingMonthly.js";
import { escapeHtml } from "../utils.js";
import { parseBillingInput, BILLING_INPUT_RULE } from "../billing/billingValue.js";
import { navigate } from "../router.js";
import { showMessage } from "./common.js";

const dialog = document.getElementById("billingDialog");
const dateInput = document.getElementById("billingDate");
const dayEl = document.getElementById("billingDay");
const monthEl = document.getElementById("billingMonth");
const progressEl = document.getElementById("billingProgress");
const saveBtn = document.getElementById("billingSaveBtn");

let current = { site: null, date: "", reportId: "", reports: [], readOnly: false, onSaved: null, dirty: false };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dayTitle = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${y}年${m}月${d}日（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`; };
const md = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shiftDay = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const monthLabel = (ym) => { const [y, m] = ym.split("-").map(Number); return `${y}年${m}月`; };
const rowKey = (c, i) => c.companyId || `#${i}`;
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
const named = (c) => (c.companyName || "").trim() || (c.occupation || "").trim();
const fmt = (n) => String(Math.round(n * 100) / 100);

/** 0以上の数（小数点以下2桁まで）か空欄。それ以外は null（入力の誤り）。決まりは日報画面・保存処理と共通（billingValue.js） */
const readValue = (input) => parseBillingInput(input.value);

/** その日の日報（同じ日に複数あれば最後に更新したもの。選び直せる） */
const reportsOn = (date) => current.reports.filter((r) => r.date === date).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

function updateProgress() {
  const inputs = [...dayEl.querySelectorAll(".billing-value")];
  let filled = 0;
  for (const input of inputs) {
    const r = readValue(input);
    const row = input.closest(".billing-row");
    const state = !r ? "error" : r.value === "" ? "blank" : "done";
    row.dataset.state = state;
    const changed = r && r.value !== row.dataset.saved;
    row.querySelector(".billing-state").textContent = state === "error" ? "0以上の数（小数は2桁まで）" : `${state === "blank" ? "未入力" : `${r.value}人工`}${changed ? "（未保存）" : state === "done" ? "・保存済み" : ""}`;
    row.classList.toggle("is-changed", !!changed);
    if (state === "done") filled++;
  }
  current.dirty = inputs.some((i) => { const r = readValue(i); return !r || r.value !== i.closest(".billing-row").dataset.saved; });
  progressEl.textContent = inputs.length ? `入力済み ${filled}／${inputs.length}行${current.dirty ? "・未保存の変更あり" : ""}（空欄は未入力のまま。0人工は「0」と入力）` : "";
}

function renderDay() {
  const date = current.date;
  dateInput.value = date;
  const same = reportsOn(date);
  const report = same.find((r) => r.id === current.reportId) || same[0] || null;
  current.reportId = report?.id || "";
  saveBtn.hidden = true;
  if (!report) {
    dayEl.innerHTML = `<p class="chorei-note">${escapeHtml(dayTitle(date))}の日報はありません。請求人工は日報の業者の行に入れるため、先に日報を作成してください（自動では日報を作りません）。</p>`;
    progressEl.textContent = "";
    return;
  }
  const rows = (report.companies || []).map((c, i) => ({ c, key: rowKey(c, i) })).filter(({ c }) => named(c));
  const work = isWorkDay(report);
  const choose = same.length > 1 ? `<p class="billing-warn">⚠ この日の日報が${same.length}件あります。月の請求人工は、この日のすべての日報に入力した値を合算します（重複登録なら、日報カレンダーから不要な日報を確認してください。自動では削除・0にしません）。</p><label class="billing-choose">入力する日報を選んでください<select class="billing-report-select">${same.map((r, i) => `<option value="${escapeHtml(r.id)}"${r.id === report.id ? " selected" : ""}>${i + 1}. ${escapeHtml(dayLabelOf(DAY_STATUSES, dayStatusOf(r)))}／業者 ${escapeHtml([...new Set((r.companies || []).map((c) => (c.companyName || "").trim()).filter(Boolean))].join("・") || "なし")}</option>`).join("")}</select></label>` : "";
  if (!rows.length) {
    dayEl.innerHTML = `${choose}<p class="chorei-note">この日の日報（${escapeHtml(dayLabelOf(DAY_STATUSES, dayStatusOf(report)))}）に業者の行がありません。請求人工は業者の行ごとに入れます。業者を登録するときは日報を開いてください。</p><button type="button" class="chorei-go" data-billing-open="${escapeHtml(report.id)}">日報を開く</button>`;
    progressEl.textContent = "";
    return;
  }
  const readOnly = current.readOnly || !!report.finalizedAt;
  dayEl.innerHTML = `${choose}${work ? "" : `<p class="chorei-note">この日は「${escapeHtml(dayLabelOf(DAY_STATUSES, dayStatusOf(report)))}」です（現場作業員の稼働には数えない日）。業者から請求があれば請求人工は入力できます。</p>`}
    ${readOnly ? `<p class="chorei-note">${report.finalizedAt ? "工事完了により確定済みの日報のため" : "この現場は工事完了のため"}、請求人工は変更できません（表示だけ）。</p>` : ""}
    <ol class="chorei-list billing-list">${rows.map(({ c, key }, i) => {
      const actual = isBlank(c.actualWorkerCount) ? null : Number(c.actualWorkerCount);
      const saved = billingValueOf(c);
      return `<li class="chorei-row billing-row" data-key="${escapeHtml(key)}" data-saved="${saved == null ? "" : escapeHtml(String(saved))}">
        <div class="chorei-who"><span class="chorei-vendor">${escapeHtml(c.companyName || "（業者名なし）")}</span><span class="chorei-trade">${escapeHtml(c.occupation || "工種なし")}</span></div>
        <div class="chorei-plan">参考（請求人工の計算には使いません）: 稼働人数 ${actual == null ? "未入力" : `${actual}人`}${work && actual != null ? `・稼働人工 ${actual}` : work ? "" : "・稼働に数えない日"}</div>
        <label class="chorei-input">請求<input type="text" class="chorei-count billing-value" inputmode="decimal" autocomplete="off" maxlength="7" enterkeyhint="${i === rows.length - 1 ? "done" : "next"}" aria-label="${escapeHtml(`${c.companyName || ""} ${c.occupation || ""} の請求人工`)}" value="${saved == null ? "" : escapeHtml(String(saved))}"${readOnly ? " disabled" : ""}>人工</label>
        <span class="chorei-state billing-state"></span>
        ${readOnly ? "" : `<button type="button" class="secondary-btn chorei-next billing-next" data-next="${i}">${i === rows.length - 1 ? "最後" : "次へ"}</button>`}
      </li>`;
    }).join("")}</ol>`;
  saveBtn.hidden = readOnly;
  saveBtn.disabled = false;
  updateProgress();
}

function renderMonth() {
  const ym = current.date.slice(0, 7);
  const today = todayIso();
  const m = buildMonthlyBilling({ reports: current.reports, site: current.site, month: ym, today });
  // 請求人工が未入力の業者の行がある日（基準日まで。業者の行がある日報だけ）
  const missing = [...new Set(current.reports.filter((r) => r.date && r.date.slice(0, 7) === ym && r.date <= m.cutoff && (r.companies || []).some((c) => (c.companyName || "").trim() && billingValueOf(c) == null)).map((r) => r.date))].sort();
  const statusOptions = (v) => BILLING_STATUSES.map((s) => `<option value="${s.value}"${s.value === v ? " selected" : ""}>${s.label}</option>`).join("");
  monthEl.innerHTML = `<h4>${monthLabel(ym)}の請求人工（日報に入力した値の合計。${md(m.cutoff)}まで）</h4>
    ${m.rows.length ? `<div class="dash-table-wrap"><table class="dash-table billing-month-table"><thead><tr><th>業者</th><th class="num">月間請求人工</th><th class="num">入力日数</th><th>請求状況</th></tr></thead><tbody>${m.rows.map((r) => `<tr><td>${escapeHtml(r.vendor)}</td><td class="num">${fmt(r.manDays)}${r.multiReportDates.length ? `<br><small class="billing-multi">⚠ 同じ日に日報が複数（${r.multiReportDates.map(md).join("・")}）の分も合算</small>` : ""}</td><td class="num">${r.enteredDays}日</td><td><select class="billing-month-status" data-vendor="${escapeHtml(r.vendor)}"${current.readOnly ? " disabled" : ""}>${statusOptions(r.status)}</select></td></tr>`).join("")}</tbody><tfoot><tr><th>合計</th><td class="num">${fmt(m.total)}</td><td colspan="2"></td></tr></tfoot></table></div>` : `<p class="empty-message">この月に請求人工を入力した業者はまだありません。</p>`}
    ${m.sameDayReportDates.length ? `<p class="billing-warn">⚠ 同じ日に日報が複数ある日（${m.sameDayReportDates.map(md).join("・")}）は、すべての日報の請求人工を合算しています（重複登録の可能性）。</p>` : ""}
    ${m.billedWithoutManDays.length ? `<p class="billing-warn">請求状況が「請求あり」なのに、この月の請求人工が未入力の業者: ${escapeHtml(m.billedWithoutManDays.join("・"))}</p>` : ""}
    <p class="billing-missing-head">請求人工が未入力の業者の行がある日（押すとその日へ移ります）</p>
    ${missing.length ? `<div class="billing-missing">${missing.map((d) => `<button type="button" class="secondary-btn" data-billing-date="${d}"${d === current.date ? " aria-current=\"true\"" : ""}>${md(d)}</button>`).join("")}</div>` : `<p class="empty-message">ありません。</p>`}`;
}

async function reloadReports() {
  current.site = (await getSite(current.site.id)) || current.site;
  current.reports = (await listReportsBySite(current.site.id)).filter((r) => !r.isDeleted);
}

async function goDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
  if (current.dirty && !confirm("保存していない請求人工があります。保存せずに日付を変えますか？")) { dateInput.value = current.date; return; }
  current.date = date;
  current.reportId = "";
  current.dirty = false;
  renderDay();
  renderMonth();
  dayEl.querySelector(".billing-row[data-state=blank] .billing-value, .billing-value")?.focus();
}

/**
 * @param {{site: object, date?: string, onSaved?: () => Promise<void>|void}} p date は最初に開く日（省略時は今日）
 */
export async function openBillingDialog({ site, date, onSaved }) {
  current = { site, date: date || todayIso(), reportId: "", reports: [], readOnly: !!site.completedAt, onSaved, dirty: false };
  await reloadReports();
  renderDay();
  renderMonth();
  dialog.showModal();
  dayEl.querySelector(".billing-row[data-state=blank] .billing-value, .billing-value")?.focus();
}

const focusNext = (index) => {
  const inputs = [...dayEl.querySelectorAll(".billing-value")];
  const next = inputs[index + 1];
  if (next) { next.focus(); next.select?.(); next.scrollIntoView({ block: "center" }); } else saveBtn.focus(); // 移った欄は中身を選ぶ（入っている値の後ろに続けて打たないように）
};

dayEl?.addEventListener("input", updateProgress);
// 欄に移ったら中身を選択する（朝礼入力と同じく、まだ何も打っていないときだけ。すばやく次の欄へ移ったときに入力の場所が戻らないように）
dayEl?.addEventListener("focusin", (e) => {
  const input = e.target;
  if (!input.classList.contains("billing-value")) return;
  const valueAtFocus = input.value;
  setTimeout(() => { if (document.activeElement === input && input.value === valueAtFocus) input.select(); }, 0);
});
dayEl?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("billing-value")) return;
  e.preventDefault();
  focusNext([...dayEl.querySelectorAll(".billing-value")].indexOf(e.target));
});
dayEl?.addEventListener("click", (e) => {
  const next = e.target.closest(".billing-next");
  if (next) { focusNext(Number(next.dataset.next)); return; }
  const open = e.target.closest("[data-billing-open]");
  if (open) { dialog.close(); navigate(`/sites/${current.site.id}/report/${open.dataset.billingOpen}`); }
});
dayEl?.addEventListener("change", (e) => {
  const sel = e.target.closest(".billing-report-select");
  if (!sel) return;
  if (current.dirty && !confirm("保存していない請求人工があります。保存せずに日報を切り替えますか？")) { sel.value = current.reportId; return; }
  current.reportId = sel.value;
  current.dirty = false;
  renderDay();
});
dateInput?.addEventListener("change", () => goDate(dateInput.value));
document.querySelectorAll("[data-billing-shift]").forEach((b) => b.addEventListener("click", () => goDate(shiftDay(current.date, Number(b.dataset.billingShift)))));
monthEl?.addEventListener("click", (e) => {
  const d = e.target.closest("[data-billing-date]");
  if (d) goDate(d.dataset.billingDate);
});
monthEl?.addEventListener("change", async (e) => {
  const sel = e.target.closest(".billing-month-status");
  if (!sel) return;
  try {
    // 請求状況だけを保存する（請求人工は変えない。請求なしでも0にしない）
    await setBillingStatus(current.site.id, current.date.slice(0, 7), sel.dataset.vendor, sel.value);
    await reloadReports();
    renderMonth();
    showMessage(`「${sel.dataset.vendor}」の${monthLabel(current.date.slice(0, 7))}の請求状況を「${BILLING_STATUSES.find((s) => s.value === sel.value)?.label}」にしました（請求人工は変えていません）。`);
  } catch (err) { showMessage(err.message, true); }
});

saveBtn?.addEventListener("click", async () => {
  const edits = new Map();
  for (const row of dayEl.querySelectorAll(".billing-row")) {
    const input = row.querySelector(".billing-value");
    const r = readValue(input);
    if (!r) { showMessage(BILLING_INPUT_RULE, true); input.focus(); return; }
    edits.set(row.dataset.key, r.value);
  }
  saveBtn.disabled = true;
  try {
    // 保存の直前に日報を読み直し、請求人工だけを書き換える（実績人数・予定人数・作業時間・ほかの項目・ほかの行はそのまま）
    const fresh = await getReport(current.reportId);
    if (!fresh || fresh.isDeleted) throw new Error("日報が見つかりません（削除された可能性があります）。");
    if (fresh.finalizedAt) throw new Error("工事完了により確定済みの日報のため、保存しませんでした。");
    let changed = 0;
    let missing = 0;
    const found = new Set();
    const companies = (fresh.companies || []).map((c, i) => {
      const key = rowKey(c, i);
      if (!edits.has(key)) return c;
      found.add(key);
      const value = edits.get(key);
      // 値が同じなら書き換えない（以前の版の manDays だけが入っている行も、そのまま残す）
      const before = billingValueOf(c);
      if ((before == null ? "" : String(before)) === value) return c;
      changed++;
      return { ...c, billingManDays: value };
    });
    for (const k of edits.keys()) if (!found.has(k)) missing++;
    if (changed) await updateReport(fresh.id, { companies });
    current.dirty = false;
    await reloadReports();
    renderDay();
    renderMonth();
    showMessage(changed ? `${md(current.date)}の請求人工を保存しました（${changed}行）。${missing ? `ほかの画面で削除された業者の行${missing}件は保存していません。` : ""}` : "変更はありませんでした。");
    progressEl.textContent = `${changed ? `保存しました（${changed}行）。` : "変更はありませんでした。"}${progressEl.textContent}`;
    if (current.onSaved) await current.onSaved();
  } catch (err) {
    showMessage(err.message, true);
    saveBtn.disabled = false;
  }
});

document.getElementById("billingCloseBtn")?.addEventListener("click", () => {
  if (current.dirty && !confirm("保存していない請求人工があります。保存せずに閉じますか？")) return;
  dialog.close();
});
