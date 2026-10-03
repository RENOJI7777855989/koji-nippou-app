/* ==========================================================
   日報カレンダーの「日報なし」の日から、その日の状態を登録するダイアログ
   ・通常作業 → 既存の日報作成画面（#/sites/:id/report/new?date=）を開く（新しい入力画面は作らない）
   ・作業なし・休工日・事務作業日 → 連絡事項・進捗率（任意）・天気だけで、既存の日報（reports）として
     既存の createReport で保存する。日の状態は既存の dayStatus（dailyFlow.js の DAY_STATUSES）を使い、
     新しい項目は作らない（事務作業の内容は連絡事項に書く）。
   ・業者・人数は入れない（稼働人数・人工に数えない）。巡回点検は空欄のまま（○にしない。
     休工日・作業なし・事務作業日で記録が無い日は「未実施」、03-2は斜線＝patrolChecklist.js）。
   ・「日報なし」を自動で「作業なし」にはしない（利用者が選んだときだけ登録する）。
   ========================================================== */

import { createReport, listReportsBySite } from "../reports.js";
import { DAY_STATUSES, labelOf } from "../dashboard/dailyFlow.js";
import { navigate } from "../router.js";
import { showMessage } from "./common.js";

const dialog = document.getElementById("dayStatusDialog");
const chooseEl = document.getElementById("dayStatusChoose");
const titleEl = document.getElementById("dayStatusDialogTitle");
const form = document.getElementById("dayStatusQuickForm");
const quickTitleEl = document.getElementById("dayStatusQuickTitle");
const remarksLabelEl = document.getElementById("dayStatusRemarksLabel");
const remarksEl = document.getElementById("dayStatusRemarks");
const progressEl = document.getElementById("dayStatusProgress");
const weatherEl = document.getElementById("dayStatusWeather");
const saveBtn = document.getElementById("dayStatusSaveBtn");

let current = { site: null, date: "", status: "", onSaved: null };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dateLabel = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`;
};

function showChoose() {
  form.hidden = true;
  chooseEl.hidden = false;
}

/**
 * @param {{site: object, date: string, onSaved?: () => Promise<void>|void}} p
 */
export function openDayStatusDialog({ site, date, onSaved }) {
  current = { site, date, status: "", onSaved };
  titleEl.textContent = `${dateLabel(date)}　日報なし`;
  showChoose();
  dialog.showModal();
}

dialog?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-day-status]");
  if (!btn) return;
  const status = btn.dataset.dayStatus;
  if (status === "work") {
    // 通常作業は既存の日報作成画面で入力する
    dialog.close();
    navigate(`/sites/${current.site.id}/report/new?date=${current.date}`);
    return;
  }
  current.status = status;
  quickTitleEl.textContent = `${dateLabel(current.date)} を「${labelOf(DAY_STATUSES, status)}」で登録`;
  remarksLabelEl.textContent = status === "office" ? "連絡事項・事務作業の内容（任意）" : "連絡事項（任意）";
  remarksEl.value = "";
  progressEl.value = "";
  weatherEl.value = "晴れ";
  chooseEl.hidden = true;
  form.hidden = false;
});

document.getElementById("dayStatusCancelBtn")?.addEventListener("click", () => dialog.close());
document.getElementById("dayStatusBackBtn")?.addEventListener("click", showChoose);

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = progressEl.value.trim();
  if (progressEl.validity.badInput || (raw !== "" && !/^\d+$/.test(raw)) || (raw !== "" && Number(raw) > 100)) {
    showMessage("進捗率は0〜100の整数で入力してください（空欄でも登録できます）。", true);
    progressEl.focus();
    return;
  }
  saveBtn.disabled = true;
  try {
    // 開いている間に別の画面で同じ日の日報が作られていないか（二重登録しない）
    const exists = (await listReportsBySite(current.site.id)).some((r) => !r.isDeleted && r.date === current.date);
    if (exists) throw new Error("この日の日報はすでにあります。カレンダーから開いて修正してください。");
    await createReport({
      siteId: current.site.id,
      date: current.date,
      dayStatus: current.status,
      weather: weatherEl.value,
      remarks: remarksEl.value.trim(),
      progressPercent: raw === "" ? null : Number(raw),
      companies: [],
      patrolChecklist: {} // 巡回点検は空欄（○にしない）
    });
    dialog.close();
    showMessage(`${dateLabel(current.date)} を「${labelOf(DAY_STATUSES, current.status)}」で登録しました。`);
    if (current.onSaved) await current.onSaved();
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
});
