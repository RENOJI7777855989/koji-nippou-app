/* ==========================================================
   帳票テンプレート管理画面
   会社ごとにExcel(.xlsx)/PDFの様式ファイルを登録・編集・削除する。
   Excel(.xlsx)形式で登録した場合、rendererIdを既定で
   "xlsx-template-patch"（アップロードした.xlsxへ直接セルを
   書き込むレンダラー）に設定する。mappingは登録時点ではnullのままとし、
   レンダラー側が組み込みの既定マッピングにフォールバックする
   （このアプリはまだマッピング編集画面を持たないため）。
   PDF形式は引き続き未対応（rendererId/mapping共にnull）。
   ========================================================== */

import {
  listCompanyProfiles,
  createCompanyProfile,
  listReportTemplates,
  createReportTemplate,
  updateReportTemplate,
  deleteReportTemplate,
  setDefaultReportTemplate
} from "../report-output/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

const listEl = document.getElementById("reportTemplateList");
const emptyEl = document.getElementById("reportTemplateListEmpty");
const addBtn = document.getElementById("addReportTemplateBtn");
const backBtn = document.getElementById("backToSiteListFromTemplatesBtn");

const dialog = document.getElementById("reportTemplateFormDialog");
const form = document.getElementById("reportTemplateForm");
const formTitle = document.getElementById("reportTemplateFormTitle");
const companySelect = document.getElementById("reportTemplateCompanySelect");
const newCompanyWrap = document.getElementById("reportTemplateNewCompanyWrap");
const newCompanyNameInput = document.getElementById("reportTemplateNewCompanyName");
const nameInput = document.getElementById("reportTemplateName");
const fileInput = document.getElementById("reportTemplateFile");
const fileRequiredMark = document.getElementById("reportTemplateFileRequiredMark");
const fileInfoEl = document.getElementById("reportTemplateFileInfo");
const cancelBtn = document.getElementById("reportTemplateCancelBtn");

let editingId = null;
let editingExistingFile = null; // { name, mimeType } 編集時、ファイル未選択なら保持する

const FORMAT_LABEL = { excel: "Excel", pdf: "PDF" };
const DEFAULT_RENDERER_ID_BY_FORMAT = { excel: "xlsx-template-patch", pdf: null };

function detectFormatFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) return "excel";
  if (name.endsWith(".pdf")) return "pdf";
  if (file.type === "application/pdf") return "pdf";
  if (file.type.includes("spreadsheetml")) return "excel";
  return null;
}

function formatDate(isoString) {
  if (!isoString) return "-";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

async function populateCompanySelect(selectedId) {
  const companies = await listCompanyProfiles();
  const options = companies.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  companySelect.innerHTML = options + `<option value="__new__">＋ 新しい会社を追加</option>`;
  companySelect.value = selectedId && companies.some((c) => c.id === selectedId) ? selectedId : (companies[0]?.id || "__new__");
  toggleNewCompanyWrap();
}

function toggleNewCompanyWrap() {
  newCompanyWrap.style.display = companySelect.value === "__new__" ? "block" : "none";
}

async function renderList() {
  const [templates, companies] = await Promise.all([listReportTemplates(), listCompanyProfiles()]);
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

  templates.sort((a, b) => (companyNameById.get(a.companyProfileId) || "").localeCompare(companyNameById.get(b.companyProfileId) || "", "ja") || a.name.localeCompare(b.name, "ja"));

  listEl.innerHTML = "";
  emptyEl.style.display = templates.length === 0 ? "block" : "none";

  templates.forEach((tpl) => {
    const li = document.createElement("li");
    li.className = "report-template-item";
    li.dataset.templateId = tpl.id;
    li.innerHTML = `
      <div class="report-template-info">
        <p class="report-template-name">${escapeHtml(tpl.name)}${tpl.isDefault ? ` <span class="status-badge status-default">使用中</span>` : ""}</p>
        <p class="report-template-meta">${escapeHtml(companyNameById.get(tpl.companyProfileId) || "会社未設定")}
          <span class="status-badge">${escapeHtml(FORMAT_LABEL[tpl.format] || tpl.format)}</span>
        </p>
        <p class="report-template-meta">登録日: ${formatDate(tpl.createdAt)}${tpl.sourceFileName ? ` / ${escapeHtml(tpl.sourceFileName)}` : ""}</p>
      </div>
      <div class="report-template-actions">
        ${tpl.isDefault ? "" : `<button type="button" class="secondary-btn setDefaultReportTemplateBtn">既定に設定</button>`}
        <button type="button" class="secondary-btn editReportTemplateBtn">編集</button>
        <button type="button" class="secondary-btn deleteReportTemplateBtn">削除</button>
      </div>
    `;
    listEl.appendChild(li);
  });
}

function resetForm() {
  editingId = null;
  editingExistingFile = null;
  form.reset();
  fileRequiredMark.style.display = "inline";
  fileInfoEl.textContent = "";
}

async function openCreateDialog() {
  resetForm();
  formTitle.textContent = "テンプレートを追加";
  await populateCompanySelect();
  dialog.showModal();
}

async function openEditDialog(tpl) {
  resetForm();
  editingId = tpl.id;
  editingExistingFile = { name: tpl.sourceFileName, mimeType: tpl.sourceFileMimeType };
  formTitle.textContent = "テンプレートを編集";
  await populateCompanySelect(tpl.companyProfileId);
  nameInput.value = tpl.name;
  fileRequiredMark.style.display = "none";
  fileInfoEl.textContent = tpl.sourceFileName ? `現在のファイル: ${tpl.sourceFileName}（変更する場合のみ選択してください）` : "";
  dialog.showModal();
}

addBtn.addEventListener("click", openCreateDialog);
cancelBtn.addEventListener("click", () => dialog.close());
backBtn.addEventListener("click", () => navigate("/sites"));
companySelect.addEventListener("change", toggleNewCompanyWrap);

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) {
    fileInfoEl.textContent = editingExistingFile?.name ? `現在のファイル: ${editingExistingFile.name}（変更する場合のみ選択してください）` : "";
    return;
  }
  const format = detectFormatFromFile(file);
  fileInfoEl.textContent = format
    ? `選択中: ${file.name}（${FORMAT_LABEL[format]}として登録されます）`
    : `選択中: ${file.name}（.xlsxまたは.pdfのみ登録できます）`;
});

listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".report-template-item");
  if (!li) return;
  const templateId = li.dataset.templateId;

  if (e.target.closest(".editReportTemplateBtn")) {
    const templates = await listReportTemplates();
    const tpl = templates.find((t) => t.id === templateId);
    if (tpl) await openEditDialog(tpl);
    return;
  }

  if (e.target.closest(".setDefaultReportTemplateBtn")) {
    await setDefaultReportTemplate(templateId);
    showMessage("既定テンプレートに設定しました。");
    await renderList();
    return;
  }

  if (e.target.closest(".deleteReportTemplateBtn")) {
    const nameEl = li.querySelector(".report-template-name");
    if (!confirm(`「${nameEl.textContent}」を削除しますか？`)) return;
    await deleteReportTemplate(templateId);
    showMessage("テンプレートを削除しました。");
    await renderList();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = nameInput.value.trim();
  if (!name) {
    showMessage("テンプレート名を入力してください。", true);
    return;
  }

  let companyProfileId = companySelect.value;
  if (companyProfileId === "__new__") {
    const newName = newCompanyNameInput.value.trim();
    if (!newName) {
      showMessage("新しい会社名を入力してください。", true);
      return;
    }
    const company = await createCompanyProfile({ name: newName });
    companyProfileId = company.id;
  }

  const file = fileInput.files[0];
  if (!file && !editingId) {
    showMessage("ファイル（.xlsxまたは.pdf）を選択してください。", true);
    return;
  }

  let format, sourceFileBlob, sourceFileName, sourceFileMimeType, rendererId;
  if (file) {
    format = detectFormatFromFile(file);
    if (!format) {
      showMessage("対応していないファイル形式です。.xlsxまたは.pdfを選択してください。", true);
      return;
    }
    sourceFileBlob = file;
    sourceFileName = file.name;
    sourceFileMimeType = file.type;
    rendererId = DEFAULT_RENDERER_ID_BY_FORMAT[format] ?? null;
  }

  if (editingId) {
    const patch = { name, companyProfileId };
    if (file) {
      Object.assign(patch, { format, sourceFileBlob, sourceFileName, sourceFileMimeType, rendererId });
    }
    await updateReportTemplate(editingId, patch);
    showMessage("テンプレートを更新しました。");
  } else {
    await createReportTemplate({ companyProfileId, format, name, sourceFileBlob, sourceFileName, sourceFileMimeType, rendererId });
    showMessage("テンプレートを追加しました。");
  }

  dialog.close();
  await renderList();
});

export async function initReportTemplateListView() {
  showView("view-report-templates");
  await renderList();
}
