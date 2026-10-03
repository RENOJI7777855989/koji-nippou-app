/* ==========================================================
   日報カレンダーから搬入・搬出だけを素早く登録する（現場作業なし・雨天作業不可日の日の「この日の日報」の［搬入・搬出を追加］）
   ・保存先は既存の日報の搬入・搬出（report.deliveries）だけ。項目も既存のまま（区分 direction・時刻・品名 item・数量・業者・
     元 origin・先 destination・車両・状況 status・備考 note）。1行の整え方は日報画面と同じ normalizeDeliveryRow。
   ・保存の直前に日報を読み直し、搬入・搬出に1行足すだけ（日の状態・人数・人工・請求人工・雨天の記録・ほかの項目は変えない）。
   ・必須は区分・時刻・品名。ほかの欄は空欄のまま保存する（0・なし などに変えない）。
   ・登録した行は通常の日報画面の「搬入・搬出」でそのまま確認・編集・削除できる。
   ========================================================== */

import { getReport, updateReport } from "../reports.js";
import { DELIVERY_STATUSES, normalizeDeliveryRow, dayStatusOf } from "../dashboard/dailyFlow.js";
import { createId } from "../utils.js";
import { showMessage } from "./common.js";

const dialog = document.getElementById("deliveryQuickDialog");
const form = document.getElementById("deliveryQuickForm");
const titleEl = document.getElementById("deliveryQuickTitle");
const statusEl = document.getElementById("deliveryQuickStatus");
const savedListEl = document.getElementById("deliveryQuickSaved");
const f = (name) => form.querySelector(`[name="${name}"]`);

const LABELS = {
  in: { origin: "搬入元", destination: "搬入先", vendor: "搬入業者", item: "搬入物（品名・資材名）" },
  out: { origin: "搬出元", destination: "搬出先", vendor: "搬出業者", item: "搬出物（品名）" }
};

let current = { reportId: "", onSaved: null, onClosed: null, savedCount: 0 };

function applyDirection() {
  const dir = form.querySelector('[name="direction"]:checked')?.value === "out" ? "out" : "in";
  for (const key of ["origin", "destination", "vendor", "item"]) form.querySelector(`[data-label="${key}"]`).textContent = LABELS[dir][key];
}

function resetFields(keepDirection) {
  const dir = form.querySelector('[name="direction"]:checked')?.value || "in";
  form.reset();
  form.querySelector(`[name="direction"][value="${keepDirection ? dir : "in"}"]`).checked = true;
  f("status").value = "plan";
  applyDirection();
}

/**
 * @param {{report: object, dateLabel: string, onSaved?: () => Promise<void>|void, onClosed?: () => Promise<void>|void}} p
 *   onSaved は保存のたび（カレンダー等の表示を更新）、onClosed は閉じたあと（この日の日報を開き直す）
 */
export function openDeliveryQuickDialog({ report, dateLabel, onSaved, onClosed }) {
  current = { reportId: report.id, onSaved, onClosed, savedCount: 0 };
  titleEl.textContent = `${dateLabel}の搬入・搬出を追加`;
  statusEl.textContent = "";
  savedListEl.innerHTML = "";
  f("status").innerHTML = DELIVERY_STATUSES.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
  resetFields(false);
  dialog.showModal();
}

form?.addEventListener("change", (e) => { if (e.target.name === "direction") applyDirection(); });

async function save(continueAfter) {
  const direction = form.querySelector('[name="direction"]:checked')?.value === "out" ? "out" : "in";
  statusEl.classList.remove("is-ok");
  const time = f("time").value.trim();
  const item = f("item").value.trim();
  if (!time) { statusEl.textContent = "時刻を入れてください。"; f("time").focus(); return; }
  if (!item) { statusEl.textContent = `${direction === "out" ? "搬出物" : "搬入物"}（品名）を入れてください。`; f("item").focus(); return; }
  const row = normalizeDeliveryRow({
    id: createId(), direction, time, item,
    quantity: f("quantity").value, vendor: f("vendor").value, origin: f("origin").value, destination: f("destination").value,
    vehicle: f("vehicle").value, status: f("status").value, note: f("note").value
  });
  if (!row?.time) { statusEl.textContent = "時刻を正しく入れてください（例 10:00）。"; f("time").focus(); return; }
  const buttons = [...form.querySelectorAll("button[type=submit], .delivery-quick-continue")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const fresh = await getReport(current.reportId);
    if (!fresh || fresh.isDeleted) throw new Error("日報が見つかりません（削除された可能性があります）。");
    if (fresh.finalizedAt) throw new Error("工事完了により確定済みの日報には追加できません。");
    const before = dayStatusOf(fresh);
    // 搬入・搬出に1行足すだけ（日の状態・人数・人工・請求人工・雨天の記録などは触らない）
    const updated = await updateReport(fresh.id, { deliveries: [...(fresh.deliveries || []), row] });
    if (dayStatusOf(updated) !== before) throw new Error("日の状態が変わりました（想定外）。日報を確認してください。");
    current.savedCount++;
    const label = `${row.time} ${direction === "out" ? "搬出" : "搬入"} ${row.item}${row.quantity ? ` ${row.quantity}` : ""}${row.vendor ? ` ${row.vendor}` : ""}`;
    if (continueAfter) {
      // 先に入力欄を空にして（区分はそのまま）次を打てるようにしてから、保存済みの一覧に足す。カレンダー等の更新はそのあと
      resetFields(true);
      f("time").focus();
      statusEl.textContent = `保存しました（${current.savedCount}件目）。続けて入力できます。`;
      statusEl.classList.add("is-ok");
      savedListEl.insertAdjacentHTML("beforeend", `<li>${label.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))}</li>`);
      if (current.onSaved) await current.onSaved();
    } else {
      if (current.onSaved) await current.onSaved();
      dialog.close();
      showMessage(`搬入・搬出を保存しました（${current.savedCount}件）。`);
      if (current.onClosed) await current.onClosed();
    }
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

form?.addEventListener("submit", (e) => { e.preventDefault(); save(false); });
form?.querySelector(".delivery-quick-continue")?.addEventListener("click", () => save(true));
document.getElementById("deliveryQuickCloseBtn")?.addEventListener("click", async () => {
  dialog.close();
  if (current.onClosed) await current.onClosed();
});
