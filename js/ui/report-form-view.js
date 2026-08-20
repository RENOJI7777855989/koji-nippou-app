/* ==========================================================
   日報フォーム画面（新規作成／編集）
   業者行の動的追加（旧script.jsのパターンを踏襲・使用機械欄を追加）、
   写真添付を扱う。職長サインは業者行ごとに1本ずつ持たせており、
   各行のcompanyId（生成後は再利用）で署名レコードと紐付ける。
   ========================================================== */

import { getReport, createReport, updateReport, deleteReport } from "../reports.js";
import { getSite } from "../sites.js";
import { addPhoto, listPhotosByReport, deletePhoto } from "../photos.js";
import { saveSignature, listSignaturesByReport, deleteSignature } from "../signatures.js";
import { createId, escapeHtml } from "../utils.js";
import { createSignaturePad } from "../signature-pad.js";
import { PATROL_CHECKLIST_ITEMS, PATROL_STATUS_OPTIONS } from "../patrolChecklist.js";
import { hasPermission, canAccessSite } from "../auth.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

const reportSaveBtn = document.getElementById("reportSaveBtn");

const titleEl = document.getElementById("reportFormTitle");
const form = document.getElementById("reportForm");
const dateInput = document.getElementById("date");
const weatherSelect = document.getElementById("weather");
const temperatureInput = document.getElementById("temperature");
const workerCountTotalInput = document.getElementById("workerCountTotal");
const companiesContainer = document.getElementById("companiesContainer");
const addCompanyBtn = document.getElementById("addCompanyBtn");
const tomorrowPlanInput = document.getElementById("tomorrowPlan");
const remarksInput = document.getElementById("remarks");
const patrolInspectorNameInput = document.getElementById("patrolInspectorName");
const patrolChecklistContainer = document.getElementById("patrolChecklistContainer");
const patrolCommentInput = document.getElementById("patrolComment");
const photoInput = document.getElementById("photoInput");
const photoGrid = document.getElementById("photoGrid");
const cancelBtn = document.getElementById("reportCancelBtn");
const deleteBtn = document.getElementById("deleteReportBtn");
const backBtn = document.getElementById("backToSiteDetailBtn");
const goToReportOutputBtn = document.getElementById("goToReportOutputFromReportBtn");

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
    const hasInput = ["companyName", "occupation", "plannedWorkerCount", "actualWorkerCount", "workContent", "safetyNotes", "foremanName"].some(
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

function resetForm() {
  form.reset();
  companiesContainer.innerHTML = "";
  addCompanyRow();
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
  showView("view-report-form");
  editingReportId = null;
  draftReportId = createId();
  titleEl.textContent = "日報を作成";
  deleteBtn.hidden = true;
  goToReportOutputBtn.hidden = true; // 保存前（帳票出力対象になる日報がまだ存在しない）
  resetForm();
  dateInput.value = new Date().toISOString().split("T")[0];
  await renderPhotoGrid(draftReportId);
  applyReadOnlyMode(false); // このルートには編集権限があるユーザーしか到達しない
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
  titleEl.textContent = "日報を編集";
  deleteBtn.hidden = false;
  goToReportOutputBtn.hidden = false;

  form.reset();
  dateInput.value = report.date || "";
  weatherSelect.value = report.weather || "晴れ";
  temperatureInput.value = report.temperature || "";
  tomorrowPlanInput.value = report.tomorrowPlan || "";
  remarksInput.value = report.remarks || "";
  patrolInspectorNameInput.value = report.patrolInspectorName || "";
  patrolCommentInput.value = report.patrolComment || "";
  loadPatrolChecklist(report.patrolChecklist);

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
  applyReadOnlyMode(!hasPermission("editReports"));
}

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

  let workerCountTotal = workerCountTotalInput.value.trim();
  if (workerCountTotal !== "" && Number(workerCountTotal) < 0) workerCountTotal = "";

  const fields = {
    siteId: currentSiteId,
    date: dateInput.value,
    weather: weatherSelect.value,
    temperature: temperatureInput.value.trim(),
    workerCountTotal,
    companies: collectCompanies(),
    tomorrowPlan: tomorrowPlanInput.value.trim(),
    remarks: remarksInput.value.trim(),
    patrolInspectorName: patrolInspectorNameInput.value.trim(),
    patrolChecklist: collectPatrolChecklist(),
    patrolComment: patrolCommentInput.value.trim()
  };

  let report;
  if (editingReportId) {
    report = await updateReport(editingReportId, fields);
  } else {
    fields.id = draftReportId;
    report = await createReport(fields);
  }

  for (const row of companiesContainer.querySelectorAll(".company-row")) {
    const pad = row._signaturePad;
    if (!pad || pad.isEmpty()) continue;
    const blob = await pad.toBlob();
    if (row.dataset.existingSignatureId) await deleteSignature(row.dataset.existingSignatureId);
    await saveSignature({ reportId: report.id, companyId: row.dataset.companyId, blob });
  }

  showMessage(`保存しました（${report.date}）`);
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

deleteBtn.addEventListener("click", async () => {
  if (!confirm("この日報を削除しますか？")) return;
  await deleteReport(editingReportId);
  showMessage("日報を削除しました。");
  navigate(`/sites/${currentSiteId}`);
});
