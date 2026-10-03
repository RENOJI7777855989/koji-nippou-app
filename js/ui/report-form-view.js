/* ==========================================================
   日報フォーム画面（新規作成／編集）
   業者行の動的追加（旧script.jsのパターンを踏襲・使用機械欄を追加）、
   写真添付を扱う。職長サインは業者行ごとに1本ずつ持たせており、
   各行のcompanyId（生成後は再利用）で署名レコードと紐付ける。
   ========================================================== */

import { getReport, listReportsBySite, createReport, updateReport, getPrintStatus, isEditedAfterPrint, PRINT_STATUS_LABELS, recordReportOutput, setReportConfirmed } from "../reports.js";
import { exportReportExcel, buildReportPrintHtml } from "../reportPrint.js";
import { openReportPrintDialog } from "./report-print-dialog.js";
import { getSite } from "../sites.js";
import { addPhoto, listPhotosByReport, deletePhoto } from "../photos.js";
import { saveSignature, listSignaturesByReport, deleteSignature } from "../signatures.js";
import { createId, escapeHtml } from "../utils.js";
import { createSignaturePad } from "../signature-pad.js";
import { PATROL_CHECKLIST_ITEMS, PATROL_STATUS_OPTIONS } from "../patrolChecklist.js";
import { hasPermission, canAccessSite } from "../auth.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { FLOW_KINDS, FLOW_STATUSES, DELIVERY_DIRECTIONS, DELIVERY_STATUSES, WORK_TIME_OPTIONS, directionOf, normalizeFlowRow, normalizeDeliveryRow, parseWorkHours, formatWorkHours, workMinutes, durationLabel } from "../dashboard/dailyFlow.js";

const reportSaveBtn = document.getElementById("reportSaveBtn");

const titleEl = document.getElementById("reportFormTitle");
const form = document.getElementById("reportForm");
const dateInput = document.getElementById("date");
const weatherSelect = document.getElementById("weather");
const temperatureInput = document.getElementById("temperature");
const progressInput = document.getElementById("progressPercent");
const dayStatusSelect = document.getElementById("dayStatus");
const dayStatusHint = document.getElementById("dayStatusHint");
const DAY_STATUS_HINT = { work: "", nowork: "作業なしの日は、稼働人数・人工・作業時間・工種別累計に数えません（日報は履歴として残ります）。", office: "事務作業日は、稼働人数・人工・作業時間・工種別累計に数えません（日報は履歴として残ります）。巡回点検の記録が無ければ、03-2の巡回点検の欄は斜線になります。", holiday: "休工日は、稼働人数・人工・作業時間・工種別累計に数えません（日報は履歴として残ります）。" };
const updateDayStatusHint = () => { dayStatusHint.textContent = DAY_STATUS_HINT[dayStatusSelect.value] || ""; };
dayStatusSelect.addEventListener("change", updateDayStatusHint);
const progressHint = document.getElementById("progressPercentHint");
let previousProgress = null; // 参考表示: この日より前の日誌で最後に入力した進捗率 { date, value }
const workerCountTotalInput = document.getElementById("workerCountTotal");
const companiesContainer = document.getElementById("companiesContainer");
const addCompanyBtn = document.getElementById("addCompanyBtn");
const timelineContainer = document.getElementById("timelineContainer");
const addTimelineBtn = document.getElementById("addTimelineBtn");
const deliveriesContainer = document.getElementById("deliveriesContainer");
const addDeliveryBtn = document.getElementById("addDeliveryBtn");
const addCarryOutBtn = document.getElementById("addCarryOutBtn");
const tomorrowPlanInput = document.getElementById("tomorrowPlan");
const remarksInput = document.getElementById("remarks");
const focusInstructionsInput = document.getElementById("focusInstructions");
const workCoordinationInput = document.getElementById("workCoordination");
const siteSupervisorsContainer = document.getElementById("siteSupervisorsContainer");
const addSiteSupervisorBtn = document.getElementById("addSiteSupervisorBtn");
const patrolInspectorNameInput = document.getElementById("patrolInspectorName");
const patrolChecklistContainer = document.getElementById("patrolChecklistContainer");
const patrolCommentInput = document.getElementById("patrolComment");
const photoInput = document.getElementById("photoInput");
const photoGrid = document.getElementById("photoGrid");
const cancelBtn = document.getElementById("reportCancelBtn");
const deleteBtn = document.getElementById("deleteReportBtn");
const backBtn = document.getElementById("backToSiteDetailBtn");
const goToReportOutputBtn = document.getElementById("goToReportOutputFromReportBtn");
const outputPanel = document.getElementById("reportOutputPanel");
const outputStatusEl = document.getElementById("reportOutputStatus");
const reportExcelBtn = document.getElementById("reportExcelBtn");
const reportPdfBtn = document.getElementById("reportPdfBtn");
const reportPrintBtn = document.getElementById("reportPrintBtn");
const reportConfirmBtn = document.getElementById("reportConfirmBtn");

let currentSiteId = null;
let editingReportId = null; // 既存日報編集時のみ非null
let draftReportId = null; // 新規作成時、保存前の写真の一時的な紐付け先

function renderPatrolChecklistTemplate() {
  let currentCategory = null;
  const parts = [];
  PATROL_CHECKLIST_ITEMS.forEach((item) => {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      parts.push(`<h4 class="patrol-category">${escapeHtml(currentCategory)}</h4>`);
    }
    const options = PATROL_STATUS_OPTIONS.map(
      (opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`
    ).join("");
    parts.push(`
      <div class="patrol-item-row" data-key="${escapeHtml(item.key)}">
        <span class="patrol-item-label">${escapeHtml(item.label)}</span>
        <select class="patrol-item-status">${options}</select>
      </div>
    `);
  });
  patrolChecklistContainer.innerHTML = parts.join("");
}
renderPatrolChecklistTemplate();

// 新規日報作成時は、全項目を「良」で初期化する（実際には大半が良好であることが
// 多く、否・該当なしの項目だけを選び直す方が入力の手間が少ないため）。
// 既存日報の編集時（loadPatrolChecklist）は、保存済みの値をそのまま復元するため
// この既定値の影響は受けない。
function resetPatrolChecklist() {
  patrolChecklistContainer.querySelectorAll("select").forEach((select) => (select.value = "good"));
}

function loadPatrolChecklist(patrolChecklist = {}) {
  patrolChecklistContainer.querySelectorAll(".patrol-item-row").forEach((row) => {
    row.querySelector("select").value = patrolChecklist[row.dataset.key] || "";
  });
}

function collectPatrolChecklist() {
  const result = {};
  patrolChecklistContainer.querySelectorAll(".patrol-item-row").forEach((row) => {
    const value = row.querySelector("select").value;
    if (value) result[row.dataset.key] = value;
  });
  return result;
}

function renumberCompanyRows() {
  companiesContainer.querySelectorAll(".company-row").forEach((row, index) => {
    row.querySelector("h3").textContent = `業者 ${index + 1}`;
  });
}

/** 作業人数（合計）は、各業者の実績人数の合計を自動算出する（手入力欄ではない） */
function recalcWorkerCountTotal() {
  let total = 0;
  companiesContainer.querySelectorAll(".actualWorkerCount").forEach((input) => {
    const value = Number(input.value);
    if (input.value.trim() !== "" && !Number.isNaN(value)) total += value;
  });
  workerCountTotalInput.value = total;
}

/**
 * 作業時間（開始・終了を30分刻みで選ぶ）。保存は従来どおり workHours の文字列（"08:00～17:00"）で、
 * 非表示の .workHours に入れておく（保存・削除確認などの処理は従来の .workHours を読む）。
 * 以前に手入力した作業時間は読み取って開始・終了に入れる。30分刻みでない時刻（例 08:15）は選択肢に足す。
 * 読み取れない自由入力（例「朝から夕方」）は消さずにそのまま残し、開始・終了を選んだときだけ置き換える。
 */
function setupWorkHours(row, saved) {
  const startSel = row.querySelector(".workStart");
  const endSel = row.querySelector(".workEnd");
  const hidden = row.querySelector(".workHours");
  const info = row.querySelector(".workHoursInfo");
  const parsed = parseWorkHours(saved);
  const fill = (sel, extra) => {
    const times = [...new Set([...WORK_TIME_OPTIONS, ...(extra ? [extra] : [])])].sort();
    sel.innerHTML = `<option value="">--:--</option>` + times.map((t) => `<option value="${t}">${t}</option>`).join("");
  };
  fill(startSel, parsed?.start);
  fill(endSel, parsed?.end);
  startSel.value = parsed?.start || "";
  endSel.value = parsed?.end || "";
  const legacy = !parsed && saved.trim() ? saved.trim() : "";
  hidden.value = saved;
  const update = () => {
    const start = startSel.value;
    const end = endSel.value;
    if (start && end) hidden.value = formatWorkHours(start, end);
    else if (start || end) hidden.value = `${start}～${end}`;
    else hidden.value = legacy; // 何も選んでいなければ、以前の自由入力をそのまま残す
    const minutes = workMinutes(start, end);
    info.textContent = start && end
      ? minutes == null ? "終了が開始より前です（日をまたぐ作業は時間を計算しません）" : `${durationLabel(minutes)}（開始～終了）`
      : legacy ? `以前の入力: ${legacy}（開始・終了を選ぶと置き換わります）` : "";
  };
  startSel.addEventListener("change", () => {
    // 開始だけ選んだときは、終了の初期値を開始の9時間後（8:00なら17:00）にして選びやすくする
    if (startSel.value && !endSel.value) {
      const [h, m] = startSel.value.split(":").map(Number);
      const t = `${String(h + 9).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (h + 9 < 24 && [...endSel.options].some((o) => o.value === t)) endSel.value = t;
    }
    update();
  });
  endSel.addEventListener("change", update);
  update();
}

function addCompanyRow(data = {}) {
  const row = document.createElement("div");
  row.className = "company-row";
  row.dataset.companyId = data.companyId || createId();
  row.dataset.existingSignatureId = "";
  row.innerHTML = `
    <h3></h3>
    <label>業者名
      <input type="text" class="companyName" placeholder="例）〇〇建設">
    </label>
    <label>職種
      <input type="text" class="occupation" placeholder="例）鉄筋工">
    </label>
    <label>予定人数
      <input type="number" class="plannedWorkerCount" min="0" placeholder="例）5">
    </label>
    <label>実績人数
      <input type="number" class="actualWorkerCount" min="0" placeholder="例）5">
    </label>
    <div class="work-hours-field">
      <span class="work-hours-label">作業時間</span>
      <span class="work-hours-picker">
        <select class="workStart" aria-label="作業の開始時刻"></select>
        <span>～</span>
        <select class="workEnd" aria-label="作業の終了時刻"></select>
      </span>
      <small class="workHoursInfo"></small>
      <input type="hidden" class="workHours">
    </div>
    <label>請求人工（任意）
      <input type="number" class="billingManDays" min="0" step="0.25" inputmode="decimal" placeholder="未入力">
    </label>
    <label class="full-row">使用機械
      <input type="text" class="machinery" placeholder="例）バックホウ">
    </label>
    <label class="full-row">作業内容
      <textarea class="workContent" rows="2" placeholder="例）1階配筋工事"></textarea>
    </label>
    <label class="full-row">安全注意事項
      <textarea class="safetyNotes" rows="2" placeholder="例）高所作業のため親綱使用"></textarea>
    </label>
    <div class="foreman-signature-block full-row">
      <label>職長名
        <input type="text" class="foremanName" placeholder="例）山田太郎">
      </label>
      <h4>職長サイン</h4>
      <div class="signature-pad-wrap">
        <canvas class="signatureCanvas signature-canvas"></canvas>
      </div>
      <div class="toolbar">
        <button type="button" class="clearSignatureBtn secondary-btn">書き直し</button>
        <span class="signatureSignedAt signature-signed-at"></span>
      </div>
    </div>
    <button type="button" class="removeCompanyBtn">この業者を削除</button>
  `;
  row.querySelector(".companyName").value = data.companyName || "";
  row.querySelector(".occupation").value = data.occupation || "";
  row.querySelector(".plannedWorkerCount").value = data.plannedWorkerCount || "";
  row.querySelector(".actualWorkerCount").value = data.actualWorkerCount || "";
  row.querySelector(".machinery").value = data.machinery || "";
  // 請求人工。以前の版で「人工（請求用）」として保存した manDays も請求人工として読む（同じ入力欄の値）
  row.querySelector(".billingManDays").value = data.billingManDays ?? data.manDays ?? "";
  setupWorkHours(row, data.workHours || "");
  row.querySelector(".workContent").value = data.workContent || "";
  row.querySelector(".safetyNotes").value = data.safetyNotes || "";
  row.querySelector(".foremanName").value = data.foremanName || "";

  companiesContainer.appendChild(row);
  renumberCompanyRows();

  row._signaturePad = createSignaturePad(row.querySelector(".signatureCanvas"));

  return row;
}

async function loadSignatureIntoRow(row, signature) {
  row.dataset.existingSignatureId = signature.id;
  row.querySelector(".signatureSignedAt").textContent = `署名日時: ${new Date(signature.signedAt).toLocaleString("ja-JP")}`;
  const canvas = row.querySelector(".signatureCanvas");
  const bitmap = await createImageBitmap(signature.imageBlob);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

companiesContainer.addEventListener("input", (e) => {
  if (e.target.classList.contains("actualWorkerCount")) recalcWorkerCountTotal();
});

companiesContainer.addEventListener("click", async (e) => {
  const clearBtn = e.target.closest(".clearSignatureBtn");
  if (clearBtn) {
    const row = clearBtn.closest(".company-row");
    row._signaturePad.clear();
    row.querySelector(".signatureSignedAt").textContent = "";
    if (row.dataset.existingSignatureId) {
      await deleteSignature(row.dataset.existingSignatureId);
      row.dataset.existingSignatureId = "";
    }
    return;
  }

  const removeBtn = e.target.closest(".removeCompanyBtn");
  if (removeBtn) {
    const row = removeBtn.closest(".company-row");
    const hasInput = ["companyName", "occupation", "plannedWorkerCount", "actualWorkerCount", "workHours", "workContent", "safetyNotes", "foremanName"].some(
      (cls) => row.querySelector(`.${cls}`).value.trim() !== ""
    );
    const hasSignature = !row._signaturePad.isEmpty() || row.dataset.existingSignatureId;
    if ((hasInput || hasSignature) && !confirm("入力内容が削除されます。この業者を削除しますか？")) return;
    if (row.dataset.existingSignatureId) await deleteSignature(row.dataset.existingSignatureId);
    row._signaturePad.destroy();
    row.remove();
    renumberCompanyRows();
    recalcWorkerCountTotal();
  }
});

addCompanyBtn.addEventListener("click", () => addCompanyRow());

// ================= 本日の現場の流れ・搬入・搬出（現場ダッシュボード用。日誌に入力する） =================

const optionsHtml = (list, selected) => list.filter((o) => !o.legacy || o.value === selected).map((o) => `<option value="${o.value}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");

function addTimelineRow(data = {}) {
  const row = document.createElement("div");
  row.className = "timeline-row";
  row.dataset.rowId = data.id || createId();
  row.innerHTML = `
    <label>時刻<input type="time" class="flowTime" step="300"></label>
    <label>種別<select class="flowKind">${optionsHtml(FLOW_KINDS, data.kind || "work")}</select></label>
    <label class="full-row">内容<input type="text" class="flowTitle" placeholder="例）全体朝礼・KY／○○工事打合せ／3階巡回"></label>
    <label>状態（予定／実施済み）<select class="flowStatus">${optionsHtml(FLOW_STATUSES, data.status || "plan")}</select></label>
    <label class="full-row">メモ<input type="text" class="flowNote" placeholder="任意"></label>
    <button type="button" class="removeRowBtn secondary-btn">この行を削除</button>`;
  row.querySelector(".flowTime").value = data.time || "";
  row.querySelector(".flowTitle").value = data.title || "";
  row.querySelector(".flowNote").value = data.note || "";
  timelineContainer.appendChild(row);
  return row;
}

// 区分（搬入／搬出）に応じた項目名と入力例。保存する項目（origin/destination 等）は共通
const DELIVERY_TEXTS = {
  in: { time: "搬入時刻", item: "搬入物", vendor: "搬入業者", origin: "搬入元", destination: "搬入先", remove: "この搬入を削除", ph: { item: "例）鉄筋", origin: "例）〇〇工場", destination: "例）北側ゲート", note: "例）北側道路から進入・誘導員1名配置" } },
  out: { time: "搬出時刻", item: "搬出物", vendor: "搬出業者", origin: "搬出元", destination: "搬出先", remove: "この搬出を削除", ph: { item: "例）残土", origin: "例）現場", destination: "例）〇〇処分場", note: "例）マニフェスト持参・タイヤ洗浄" } }
};

function applyDeliveryDirection(row) {
  const dir = row.querySelector(".dlvDirection").value === "out" ? "out" : "in";
  const t = DELIVERY_TEXTS[dir];
  row.classList.toggle("is-out", dir === "out");
  for (const key of ["time", "item", "vendor", "origin", "destination"]) row.querySelector(`[data-label="${key}"]`).textContent = t[key];
  for (const [key, cls] of [["item", "dlvItem"], ["origin", "dlvOrigin"], ["destination", "dlvDestination"], ["note", "dlvNote"]]) row.querySelector(`.${cls}`).placeholder = t.ph[key];
  row.querySelector(".removeRowBtn").textContent = t.remove;
}

function addDeliveryRow(data = {}) {
  const row = document.createElement("div");
  row.className = "delivery-row";
  row.dataset.rowId = data.id || createId();
  row.innerHTML = `
    <label>区分<select class="dlvDirection">${optionsHtml(DELIVERY_DIRECTIONS, directionOf(data))}</select></label>
    <label>状況<select class="dlvStatus">${optionsHtml(DELIVERY_STATUSES, data.status || "plan")}</select></label>
    <label><span data-label="time"></span><input type="time" class="dlvTime" step="300"></label>
    <label><span data-label="item"></span><input type="text" class="dlvItem"></label>
    <label>数量<input type="text" class="dlvQuantity" placeholder="例）10t"></label>
    <label><span data-label="vendor"></span><input type="text" class="dlvVendor" placeholder="例）〇〇建設"></label>
    <label><span data-label="origin"></span><input type="text" class="dlvOrigin"></label>
    <label><span data-label="destination"></span><input type="text" class="dlvDestination"></label>
    <label>車両<input type="text" class="dlvVehicle" placeholder="例）10t車"></label>
    <label class="full-row">備考<textarea class="dlvNote" rows="2"></textarea></label>
    <button type="button" class="removeRowBtn secondary-btn"></button>`;
  row.querySelector(".dlvTime").value = data.time || "";
  for (const [cls, key] of [["dlvItem", "item"], ["dlvQuantity", "quantity"], ["dlvVendor", "vendor"], ["dlvVehicle", "vehicle"], ["dlvOrigin", "origin"], ["dlvDestination", "destination"], ["dlvNote", "note"]]) row.querySelector(`.${cls}`).value = data[key] || "";
  row.querySelector(".dlvDirection").addEventListener("change", () => applyDeliveryDirection(row));
  applyDeliveryDirection(row);
  deliveriesContainer.appendChild(row);
  return row;
}

function collectTimeline() {
  return [...timelineContainer.querySelectorAll(".timeline-row")]
    .map((row) => normalizeFlowRow({
      id: row.dataset.rowId,
      time: row.querySelector(".flowTime").value,
      kind: row.querySelector(".flowKind").value,
      title: row.querySelector(".flowTitle").value,
      status: row.querySelector(".flowStatus").value,
      note: row.querySelector(".flowNote").value
    }))
    .filter(Boolean);
}

function collectDeliveries() {
  return [...deliveriesContainer.querySelectorAll(".delivery-row")]
    .map((row) => normalizeDeliveryRow({
      id: row.dataset.rowId,
      direction: row.querySelector(".dlvDirection").value,
      time: row.querySelector(".dlvTime").value,
      status: row.querySelector(".dlvStatus").value,
      item: row.querySelector(".dlvItem").value,
      quantity: row.querySelector(".dlvQuantity").value,
      vendor: row.querySelector(".dlvVendor").value,
      vehicle: row.querySelector(".dlvVehicle").value,
      origin: row.querySelector(".dlvOrigin").value,
      destination: row.querySelector(".dlvDestination").value,
      note: row.querySelector(".dlvNote").value
    }))
    .filter(Boolean);
}

function loadFlowAndDeliveries(report = {}) {
  timelineContainer.innerHTML = "";
  deliveriesContainer.innerHTML = "";
  (report.timeline || []).forEach((r) => addTimelineRow(r));
  (report.deliveries || []).forEach((r) => addDeliveryRow(r));
}

addTimelineBtn.addEventListener("click", () => addTimelineRow());
addDeliveryBtn.addEventListener("click", () => addDeliveryRow({ direction: "in" }));
addCarryOutBtn.addEventListener("click", () => addDeliveryRow({ direction: "out" }));
for (const container of [timelineContainer, deliveriesContainer]) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".removeRowBtn");
    if (!btn) return;
    const row = btn.closest(".timeline-row, .delivery-row");
    const hasInput = [...row.querySelectorAll("input, textarea")].some((el) => el.value.trim() !== "");
    if (hasInput && !confirm("入力内容が削除されます。この行を削除しますか？")) return;
    row.remove();
  });
}

async function renderPhotoGrid(reportId) {
  const photos = await listPhotosByReport(reportId);
  photoGrid.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
  photoGrid.innerHTML = "";
  photos.forEach((photo) => {
    const url = URL.createObjectURL(photo.blob);
    const div = document.createElement("div");
    div.className = "photo-tile";
    div.dataset.photoId = photo.id;
    div.innerHTML = `<img src="${url}" alt="添付写真"><button type="button" class="removePhotoBtn" aria-label="この写真を削除">×</button>`;
    photoGrid.appendChild(div);
  });
}

photoGrid.addEventListener("click", async (e) => {
  const btn = e.target.closest(".removePhotoBtn");
  if (!btn) return;
  const tile = btn.closest(".photo-tile");
  if (!confirm("この写真を削除しますか？")) return;
  await deletePhoto(tile.dataset.photoId);
  await renderPhotoGrid(editingReportId || draftReportId);
});

photoInput.addEventListener("change", async () => {
  const reportId = editingReportId || draftReportId;
  const files = Array.from(photoInput.files);
  for (const file of files) {
    await addPhoto(reportId, currentSiteId, file);
  }
  photoInput.value = "";
  await renderPhotoGrid(reportId);
});

/* ---------- 進捗率（その日の日誌ごとに記録。0〜100の整数・空欄も保存できるが「未入力」と目立たせる）---------- */

/** 入力値を確かめる。空欄は null、正しい値は整数、不正な値は { error } */
function readProgress() {
  if (progressInput.validity.badInput) return { error: "進捗率は数字（0〜100の整数）で入力してください。" };
  const raw = progressInput.value.trim();
  if (raw === "") return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) return { error: "進捗率は0〜100の整数（％）で入力してください。" };
  return { value: n };
}

function updateProgressHint() {
  const r = readProgress();
  const prev = previousProgress ? `前回の日誌（${previousProgress.date}）は ${previousProgress.value}%` : "";
  progressInput.classList.toggle("is-missing", !r.error && r.value == null);
  progressInput.classList.toggle("is-invalid", !!r.error);
  progressHint.classList.toggle("is-warn", !!r.error || r.value == null);
  progressHint.textContent = r.error ? r.error : r.value == null ? `進捗率が未入力です${prev ? `（${prev}）` : ""}` : prev;
}
progressInput.addEventListener("input", updateProgressHint);

/** この日より前で、進捗率を入力した一番新しい日誌（参考表示用。値を自動で入れることはしない） */
async function loadPreviousProgress(siteId, date, excludeId) {
  const reports = siteId ? await listReportsBySite(siteId) : [];
  const prev = reports
    .filter((r) => !r.isDeleted && r.id !== excludeId && r.progressPercent != null && r.date && (!date || r.date < date))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  previousProgress = prev ? { date: prev.date, value: prev.progressPercent } : null;
  updateProgressHint();
}
dateInput.addEventListener("change", () => loadPreviousProgress(currentSiteId, dateInput.value, editingReportId));

function resetForm() {
  form.reset();
  companiesContainer.innerHTML = "";
  addCompanyRow();
  siteSupervisorsContainer.innerHTML = "";
  loadFlowAndDeliveries({});
  resetPatrolChecklist();
  photoGrid.innerHTML = "";
  recalcWorkerCountTotal();
}

/** 閲覧のみロール（および担当外の監督が直接URL遷移した場合）向けに、
 *  入力・保存・削除操作をすべて封じた読み取り専用表示に切り替える。
 *  業者行・巡回点検欄は動的生成される都合上、生成し終えた後に
 *  この関数を呼ぶ前提（addCompanyRow等より後段で実行する）。 */
function applyReadOnlyMode(readOnly) {
  form.classList.toggle("read-only-form", readOnly);
  form.querySelectorAll("input, select, textarea").forEach((el) => {
    el.disabled = readOnly;
  });
  reportSaveBtn.hidden = readOnly;
  if (readOnly) deleteBtn.hidden = true;
  cancelBtn.textContent = readOnly ? "一覧に戻る" : "キャンセル";
}

export async function initReportFormViewNew(params) {
  currentSiteId = params.id;
  const site = await getSite(currentSiteId);
  if (!site || !canAccessSite(site)) {
    showMessage("この現場の日報を作成する権限がありません。", true);
    navigate("/sites");
    return;
  }
  if (site.completedAt) {
    showMessage("工事完了済みの現場には日報を追加できません。", true);
    navigate(`/sites/${currentSiteId}`);
    return;
  }
  outputPanel.hidden = true;
  showView("view-report-form");
  editingReportId = null;
  draftReportId = createId();
  titleEl.textContent = "日報を作成";
  deleteBtn.hidden = true;
  goToReportOutputBtn.hidden = true; // 保存前（帳票出力対象になる日報がまだ存在しない）
  resetForm();
  // 一覧の「未入力（日報のない日）」から来た場合はその日付を初期値にする
  // 初期値は端末の日付（toISOString()はUTCのため、日本時間0〜9時に前日になっていた）
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(params.date || "") ? params.date : localToday;
  progressInput.value = "";
  dayStatusSelect.value = "work";
  updateDayStatusHint();
  await loadPreviousProgress(currentSiteId, dateInput.value, null);
  await renderPhotoGrid(draftReportId);
  applyReadOnlyMode(false); // このルートには編集権限があるユーザーしか到達しない
  focusRequestedSection();
}

export async function initReportFormViewEdit(params) {
  currentSiteId = params.id;
  const site = await getSite(currentSiteId);
  if (!site || !canAccessSite(site)) {
    showMessage("この現場の日報を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  const report = await getReport(params.reportId);
  if (!report) {
    showMessage("日報が見つかりませんでした。", true);
    navigate(`/sites/${currentSiteId}`);
    return;
  }
  showView("view-report-form");
  editingReportId = report.id;
  draftReportId = null;
  titleEl.textContent = report.finalizedAt ? "日報（確定済み・閲覧のみ）" : "日報を編集";
  deleteBtn.hidden = true; // 日報は削除しない（修正で対応）
  goToReportOutputBtn.hidden = false;

  form.reset();
  dateInput.value = report.date || "";
  weatherSelect.value = report.weather || "晴れ";
  temperatureInput.value = report.temperature || "";
  progressInput.value = report.progressPercent ?? "";
  dayStatusSelect.value = ["nowork", "office", "holiday"].includes(report.dayStatus) ? report.dayStatus : "work";
  updateDayStatusHint();
  tomorrowPlanInput.value = report.tomorrowPlan || "";
  remarksInput.value = report.remarks || "";
  focusInstructionsInput.value = report.focusInstructions || "";
  workCoordinationInput.value = report.workCoordination || "";
  siteSupervisorsContainer.innerHTML = "";
  (report.siteSupervisorNames || []).forEach((name) => addSiteSupervisorRow(name));
  patrolInspectorNameInput.value = report.patrolInspectorName || "";
  patrolCommentInput.value = report.patrolComment || "";
  loadPatrolChecklist(report.patrolChecklist);
  loadFlowAndDeliveries(report);
  await loadPreviousProgress(report.siteId, report.date, report.id);

  companiesContainer.innerHTML = "";
  const signatures = await listSignaturesByReport(report.id);
  const signatureByCompanyId = new Map(
    signatures.filter((s) => s.role === "foreman" && s.companyId).map((s) => [s.companyId, s])
  );
  if (report.companies && report.companies.length) {
    for (const c of report.companies) {
      const row = addCompanyRow(c);
      const signature = signatureByCompanyId.get(c.companyId);
      if (signature) await loadSignatureIntoRow(row, signature);
    }
  } else {
    addCompanyRow();
  }
  recalcWorkerCountTotal();

  await renderPhotoGrid(report.id);
  applyReadOnlyMode(!hasPermission("editReports") || !!report.finalizedAt);
  renderOutputPanel(report);
  focusRequestedSection();
}

/** 現場ダッシュボードの「🚚搬入」「👷業者」から開いたときは、その欄まで移動する（搬入は空なら1行追加） */
function focusRequestedSection() {
  const focus = window.__reportFormFocus;
  window.__reportFormFocus = null;
  if (!focus) return;
  if (focus === "deliveries" && !deliveriesContainer.querySelector(".delivery-row") && !form.classList.contains("read-only-form")) addDeliveryRow();
  const target = document.getElementById(focus === "deliveries" ? "deliveriesHeading" : "companiesHeading");
  target?.scrollIntoView({ block: "start" });
}

// ================= 出力・印刷・再印刷 =================

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP") : "なし");

function renderOutputPanel(report) {
  outputPanel.hidden = false;
  const status = getPrintStatus(report);
  const parts = [
    `印刷状態: <strong>${PRINT_STATUS_LABELS[status]}</strong>${report.printCount > 1 ? `（${report.printCount}回）` : ""}`,
    `最終印刷: ${escapeHtml(fmtDateTime(report.lastPrintedAt))}`,
    `最終出力: ${escapeHtml(fmtDateTime(report.lastOutputAt))}${report.lastOutputFormat ? `（${report.lastOutputFormat === "excel" ? "Excel" : "PDF"}）` : ""}`,
    `確認: ${report.confirmedAt ? `確認済み（${escapeHtml(fmtDateTime(report.confirmedAt))}）` : "未確認"}`
  ];
  if (report.finalizedAt) parts.push("工事完了により確定済み（修正不可・再出力は可能）");
  if (isEditedAfterPrint(report)) parts.push(`<span class="status-badge status-warning">印刷後に内容が修正されています（紙が古い内容の可能性。再印刷を検討してください）</span>`);
  outputStatusEl.innerHTML = parts.join("　／　");
  reportPrintBtn.textContent = status === "unprinted" ? "印刷" : "再印刷";
  reportConfirmBtn.textContent = report.confirmedAt ? "確認済みを解除" : "内容を確認済みにする";
  reportConfirmBtn.hidden = !hasPermission("editReports");
}

async function refreshOutputPanel() {
  renderOutputPanel(await getReport(editingReportId));
}

reportExcelBtn.addEventListener("click", async () => {
  reportExcelBtn.disabled = true;
  try {
    const r = await exportReportExcel(editingReportId);
    showMessage(`Excelを出力しました（${r.filename}）${r.usedCompanyTemplate ? "" : " ／ 注意: 会社指定様式が見つからないため汎用フォーマットで出力しました（テンプレート管理で標準テンプレートを登録してください）"}`, !r.usedCompanyTemplate);
    await refreshOutputPanel();
  } catch (err) {
    showMessage(`Excel出力に失敗しました: ${err.message}`, true);
  } finally {
    reportExcelBtn.disabled = false;
  }
});

async function openPrint(mode) {
  const reportId = editingReportId;
  let built;
  try {
    built = await buildReportPrintHtml(reportId);
  } catch (err) {
    showMessage(`印刷用データの作成に失敗しました: ${err.message}`, true);
    return;
  }
  const report = await getReport(reportId);
  openReportPrintDialog({
    html: built.html,
    mode,
    title: `${mode === "pdf" ? "PDF出力" : mode === "reprint" ? "再印刷" : "印刷"}（${report.date || "日付未設定"}）`,
    note: built.usedCompanyTemplate ? `会社指定様式「${built.company.templateName}」のレイアウトで出力します。` : "会社指定様式が見つからないため、アプリ独自のレイアウトで出力します。",
    onPrinted: async () => {
      const updated = await recordReportOutput(reportId, "print");
      showMessage(`${PRINT_STATUS_LABELS[getPrintStatus(updated)]}として記録しました。`);
      await refreshOutputPanel();
    },
    onPdfOpened: async () => {
      await recordReportOutput(reportId, "pdf");
      await refreshOutputPanel();
    }
  });
}

reportPdfBtn.addEventListener("click", () => openPrint("pdf"));
reportPrintBtn.addEventListener("click", async () => {
  const report = await getReport(editingReportId);
  openPrint(getPrintStatus(report) === "unprinted" ? "print" : "reprint");
});

reportConfirmBtn.addEventListener("click", async () => {
  const report = await getReport(editingReportId);
  await setReportConfirmed(editingReportId, !report.confirmedAt);
  showMessage(report.confirmedAt ? "確認済みを解除しました。" : "確認済みにしました。");
  await refreshOutputPanel();
});

function addSiteSupervisorRow(name = "") {
  const row = document.createElement("div");
  row.className = "site-supervisor-row";
  row.innerHTML = `
    <input type="text" class="siteSupervisorNameInput" placeholder="例）鈴木一郎">
    <button type="button" class="removeSiteSupervisorBtn">削除</button>
  `;
  row.querySelector(".siteSupervisorNameInput").value = name;
  siteSupervisorsContainer.appendChild(row);
  return row;
}

function collectSiteSupervisorNames() {
  const names = [];
  siteSupervisorsContainer.querySelectorAll(".siteSupervisorNameInput").forEach((input) => {
    const value = input.value.trim();
    if (value) names.push(value);
  });
  return names;
}

addSiteSupervisorBtn.addEventListener("click", () => addSiteSupervisorRow());
siteSupervisorsContainer.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".removeSiteSupervisorBtn");
  if (!removeBtn) return;
  removeBtn.closest(".site-supervisor-row").remove();
});

function collectCompanies() {
  const companies = [];
  companiesContainer.querySelectorAll(".company-row").forEach((row) => {
    let plannedWorkerCount = row.querySelector(".plannedWorkerCount").value.trim();
    if (plannedWorkerCount !== "" && Number(plannedWorkerCount) < 0) plannedWorkerCount = "";
    let actualWorkerCount = row.querySelector(".actualWorkerCount").value.trim();
    if (actualWorkerCount !== "" && Number(actualWorkerCount) < 0) actualWorkerCount = "";
    companies.push({
      companyId: row.dataset.companyId,
      companyName: row.querySelector(".companyName").value.trim(),
      occupation: row.querySelector(".occupation").value.trim(),
      plannedWorkerCount,
      actualWorkerCount,
      machinery: row.querySelector(".machinery").value.trim(),
      // 請求人工（請求・見積・提出用。利用者の入力だけ）。未入力は ""。稼働人数・人工・作業時間からは計算しない。
      // ダッシュボード・03-2には使わない（人工は稼働人数から1人＝1人工で数える）
      billingManDays: row.querySelector(".billingManDays").value.trim(),
      workHours: row.querySelector(".workHours").value.trim(),
      workContent: row.querySelector(".workContent").value.trim(),
      safetyNotes: row.querySelector(".safetyNotes").value.trim(),
      foremanName: row.querySelector(".foremanName").value.trim()
    });
  });
  return companies;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!dateInput.value) {
    showMessage("日付を入力してください。", true);
    dateInput.focus();
    return;
  }

  const progress = readProgress();
  if (progress.error) {
    showMessage(progress.error, true);
    progressInput.focus();
    return;
  }

  // 請求人工（任意）は0以上の数字だけ
  const badManDays = [...companiesContainer.querySelectorAll(".billingManDays")].find((el) => el.validity.badInput || (el.value.trim() !== "" && !(Number(el.value) >= 0)));
  if (badManDays) {
    showMessage("請求人工は0以上の数字で入力してください（未定の場合は空欄のままにしてください）。", true);
    badManDays.focus();
    return;
  }

  let workerCountTotal = workerCountTotalInput.value.trim();
  if (workerCountTotal !== "" && Number(workerCountTotal) < 0) workerCountTotal = "";

  const fields = {
    siteId: currentSiteId,
    date: dateInput.value,
    weather: weatherSelect.value,
    temperature: temperatureInput.value.trim(),
    progressPercent: progress.value,
    dayStatus: dayStatusSelect.value,
    workerCountTotal,
    companies: collectCompanies(),
    tomorrowPlan: tomorrowPlanInput.value.trim(),
    remarks: remarksInput.value.trim(),
    focusInstructions: focusInstructionsInput.value.trim(),
    workCoordination: workCoordinationInput.value.trim(),
    siteSupervisorNames: collectSiteSupervisorNames(),
    patrolInspectorName: patrolInspectorNameInput.value.trim(),
    patrolChecklist: collectPatrolChecklist(),
    patrolComment: patrolCommentInput.value.trim(),
    timeline: collectTimeline(),
    deliveries: collectDeliveries()
  };

  let report;
  try {
    if (editingReportId) {
      report = await updateReport(editingReportId, fields);
    } else {
      fields.id = draftReportId;
      report = await createReport(fields);
    }
  } catch (err) {
    showMessage(err.message, true);
    return;
  }

  for (const row of companiesContainer.querySelectorAll(".company-row")) {
    const pad = row._signaturePad;
    if (!pad || pad.isEmpty()) continue;
    const blob = await pad.toBlob();
    if (row.dataset.existingSignatureId) await deleteSignature(row.dataset.existingSignatureId);
    await saveSignature({ reportId: report.id, companyId: row.dataset.companyId, blob });
  }

  showMessage(`保存しました（${report.date}）${progress.value == null ? "。進捗率が未入力です（日誌を開いて入力できます）" : ""}`);
  navigate(`/sites/${currentSiteId}`);
});

cancelBtn.addEventListener("click", async () => {
  const isReadOnly = form.classList.contains("read-only-form");
  if (!isReadOnly && !confirm("入力内容を破棄しますか？")) return;
  if (draftReportId && !editingReportId) {
    // 保存前に添付した写真は孤立するため削除する
    const photos = await listPhotosByReport(draftReportId);
    for (const p of photos) await deletePhoto(p.id);
  }
  navigate(currentSiteId ? `/sites/${currentSiteId}` : "/sites");
});

backBtn.addEventListener("click", () => cancelBtn.click());

goToReportOutputBtn.addEventListener("click", () => {
  navigate(`/report-output?siteId=${currentSiteId}&reportId=${editingReportId}`);
});

// 日報は通常操作では削除できない（削除ボタンは常に非表示。誤りは修正で対応する）
deleteBtn.addEventListener("click", () => {
  showMessage("日報は削除できません。内容に誤りがある場合は修正して保存してください。", true);
});
