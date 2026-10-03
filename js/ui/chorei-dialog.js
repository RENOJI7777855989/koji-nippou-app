/* ==========================================================
   朝礼入力（現場ダッシュボードの「🗣 朝礼入力」）
   朝礼で各業者から聞いた「今日の実績人数」を、業者の行ごとに続けて入力する画面。
   ・保存先は既存の日報の実績人数（companies[].actualWorkerCount）だけ。朝礼専用の人数データは作らない。
     作業人数（合計）workerCountTotal も日報画面と同じく実績人数の合計にそろえる。
   ・対象は表示している日の通常作業の日報の業者の行（業者＋工種は日報の行のまま。業者名から工種を決めない）。
     予定人数（plannedWorkerCount）・請求人工（billingManDays）・ほかの項目は書き換えない。
   ・空欄＝未入力、0＝0人（未入力を0人にしない）。
   ・日報が無い日は日報を作らない（日報の作成画面へ案内するだけ）。作業しない日・確定済みの日報は入力できない。
   ・03-2・現場掲示・業者別稼働・人工（1人＝1人工）は、日報の実績人数をそのまま使う既存の仕組みで反映される。
   ========================================================== */

import { getReport, updateReport } from "../reports.js";
import { dayStatusOf, labelOf, DAY_STATUSES } from "../dashboard/dailyFlow.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { showMessage } from "./common.js";

const dialog = document.getElementById("choreiDialog");
const titleEl = document.getElementById("choreiTitle");
const bodyEl = document.getElementById("choreiBody");
const progressEl = document.getElementById("choreiProgress");
const saveBtn = document.getElementById("choreiSaveBtn");

let current = { siteId: "", date: "", reportId: "", onSaved: null };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dayTitle = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${m}月${d}日（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`; };
/** 業者の行の識別（companyId。無い古い行は並び順） */
const rowKey = (c, i) => c.companyId || `#${i}`;
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/** 0以上の整数か空欄。それ以外は null（入力の誤り） */
function readCount(input) {
  const raw = input.value.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)); // 全角数字も読む
  if (raw === "") return { value: "" };
  return /^\d+$/.test(raw) ? { value: String(Number(raw)) } : null;
}

function updateProgress() {
  const inputs = [...bodyEl.querySelectorAll(".chorei-count")];
  let filled = 0;
  for (const input of inputs) {
    const r = readCount(input);
    const row = input.closest(".chorei-row");
    const state = !r ? "error" : r.value === "" ? "blank" : "done";
    row.dataset.state = state;
    row.querySelector(".chorei-state").textContent = state === "error" ? "0以上の整数" : state === "blank" ? "未入力" : `${r.value}人`;
    if (state === "done") filled++;
  }
  progressEl.textContent = inputs.length ? `入力済み ${filled}／${inputs.length}行（空欄は未入力のまま保存します。0人は「0」と入力）` : "";
}

/**
 * @param {{site: object, date: string, reportId: string|null, onSaved?: () => Promise<void>|void}} p
 *   reportId はダッシュボードで表示している日の日報（同じ日に複数あれば最後に更新したもの）
 */
export async function openChoreiDialog({ site, date, reportId, sameDayCount = 1, onSaved }) {
  current = { siteId: site.id, date, reportId: reportId || "", onSaved };
  titleEl.textContent = `${dayTitle(date)}の朝礼入力（今日の実績人数）`;
  saveBtn.hidden = true;
  progressEl.textContent = "";
  const report = reportId ? await getReport(reportId) : null;
  const goForm = (label) => `<button type="button" class="chorei-go" data-chorei-go="${report ? "edit" : "new"}">${label}</button>`;
  if (!report || report.isDeleted) {
    bodyEl.innerHTML = `<p class="chorei-note">この日の日報がまだありません。朝礼入力は日報の業者の行に人数を入れるため、先に日報を作成して業者（業者名・工種）を登録してください（自動では日報を作りません）。</p>${site.completedAt ? "" : goForm("この日の日報を作成する")}`;
  } else if (dayStatusOf(report) !== "work") {
    bodyEl.innerHTML = `<p class="chorei-note">この日の日報は「${escapeHtml(labelOf(DAY_STATUSES, dayStatusOf(report)))}」です。作業しない日のため、朝礼の実績人数は入力できません（現場作業員の稼働人数に数えない日です）。日の状態を変える場合は日報を開いてください。</p>${goForm("日報を開く")}`;
  } else if (report.finalizedAt || site.completedAt) {
    bodyEl.innerHTML = `<p class="chorei-note">工事完了により確定済みのため、人数は変更できません。</p>`;
  } else {
    const rows = (report.companies || []).map((c, i) => ({ c, key: rowKey(c, i) })).filter(({ c }) => (c.companyName || "").trim() || (c.occupation || "").trim());
    if (!rows.length) {
      bodyEl.innerHTML = `<p class="chorei-note">この日の日報に業者が登録されていません。日報を開いて、業者名・工種を登録してください（業者名から工種を自動では決めません）。</p>${goForm("日報を開いて業者を登録する")}`;
    } else {
      bodyEl.innerHTML = `${sameDayCount > 1 ? `<p class="chorei-note">この日の日報が${sameDayCount}件あります。最後に更新した日報（ダッシュボードに表示している日報）に入力します。</p>` : ""}
        <ol class="chorei-list">${rows.map(({ c, key }, i) => `
          <li class="chorei-row" data-key="${escapeHtml(key)}">
            <div class="chorei-who"><span class="chorei-vendor">${escapeHtml(c.companyName || "（業者名なし）")}</span><span class="chorei-trade">${escapeHtml(c.occupation || "工種なし")}</span></div>
            <div class="chorei-plan">予定 ${isBlank(c.plannedWorkerCount) ? "未入力" : `${escapeHtml(c.plannedWorkerCount)}人`}</div>
            <label class="chorei-input">実績<input type="text" class="chorei-count" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="4" enterkeyhint="${i === rows.length - 1 ? "done" : "next"}" aria-label="${escapeHtml(`${c.companyName || ""} ${c.occupation || ""} の今日の実績人数`)}" value="${isBlank(c.actualWorkerCount) ? "" : escapeHtml(c.actualWorkerCount)}">人</label>
            <span class="chorei-state"></span>
            <button type="button" class="secondary-btn chorei-next" data-next="${i}">${i === rows.length - 1 ? "最後" : "次へ"}</button>
          </li>`).join("")}</ol>`;
      saveBtn.hidden = false;
      saveBtn.disabled = false;
      updateProgress();
    }
  }
  dialog.showModal();
  bodyEl.querySelector(".chorei-row[data-state=blank] .chorei-count, .chorei-count")?.focus();
}

const focusNext = (index) => {
  const inputs = [...bodyEl.querySelectorAll(".chorei-count")];
  const next = inputs[index + 1];
  if (next) { next.focus(); next.select?.(); next.scrollIntoView({ block: "center" }); } else saveBtn.focus();
};

bodyEl?.addEventListener("input", updateProgress);
// 欄に移ったら中身を選択する（既に入っている人数をそのまま打ち直せる）
// select() はその欄へ入力の場所を移すので、少し後で実行する選択は「その欄にまだ入力の場所があり、まだ何も打っていない」ときだけ
// （すばやく次の欄へ移ったときに、前の欄へ入力の場所が戻って数字が前の欄に入る・消えるのを防ぐ）
bodyEl?.addEventListener("focusin", (e) => {
  const input = e.target;
  if (!input.classList.contains("chorei-count")) return;
  const valueAtFocus = input.value;
  setTimeout(() => { if (document.activeElement === input && input.value === valueAtFocus) input.select(); }, 0);
});
bodyEl?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("chorei-count")) return;
  e.preventDefault();
  focusNext([...bodyEl.querySelectorAll(".chorei-count")].indexOf(e.target));
});
bodyEl?.addEventListener("click", (e) => {
  const next = e.target.closest(".chorei-next");
  if (next) { focusNext(Number(next.dataset.next)); return; }
  const go = e.target.closest("[data-chorei-go]");
  if (go) {
    dialog.close();
    navigate(go.dataset.choreiGo === "edit" ? `/sites/${current.siteId}/report/${current.reportId}` : `/sites/${current.siteId}/report/new?date=${current.date}`);
  }
});

saveBtn?.addEventListener("click", async () => {
  const edits = new Map();
  for (const row of bodyEl.querySelectorAll(".chorei-row")) {
    const input = row.querySelector(".chorei-count");
    const r = readCount(input);
    if (!r) { showMessage("実績人数は0以上の整数で入力してください（分からない業者は空欄のまま＝未入力）。", true); input.focus(); return; }
    edits.set(row.dataset.key, r.value);
  }
  saveBtn.disabled = true;
  try {
    // 保存の直前に日報を読み直し、実績人数だけを書き換える（予定人数・請求人工・ほかの項目・ほかの行はそのまま）
    const fresh = await getReport(current.reportId);
    if (!fresh || fresh.isDeleted) throw new Error("日報が見つかりません（削除された可能性があります）。");
    if (dayStatusOf(fresh) !== "work") throw new Error("この日報は通常作業ではなくなったため、保存しませんでした。");
    let changed = 0;
    let missing = 0;
    const found = new Set();
    const companies = (fresh.companies || []).map((c, i) => {
      const key = rowKey(c, i);
      if (!edits.has(key)) return c;
      found.add(key);
      const value = edits.get(key);
      if (String(c.actualWorkerCount ?? "") === value) return c;
      changed++;
      return { ...c, actualWorkerCount: value };
    });
    for (const k of edits.keys()) if (!found.has(k)) missing++;
    if (changed) {
      // 作業人数（合計）は日報画面と同じく、実績人数の入力がある行の合計
      const total = companies.reduce((s, c) => s + (isBlank(c.actualWorkerCount) ? 0 : Number(c.actualWorkerCount) || 0), 0);
      await updateReport(fresh.id, { companies, workerCountTotal: String(total) });
    }
    dialog.close();
    showMessage(changed ? `朝礼の実績人数を保存しました（${changed}行）。${missing ? `ほかの画面で削除された業者の行${missing}件は保存していません。` : ""}` : "変更はありませんでした。");
    if (current.onSaved) await current.onSaved();
  } catch (err) {
    showMessage(err.message, true);
    saveBtn.disabled = false;
  }
});

document.getElementById("choreiCloseBtn")?.addEventListener("click", () => dialog.close());
