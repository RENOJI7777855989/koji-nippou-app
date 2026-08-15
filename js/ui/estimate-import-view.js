/* ==========================================================
   積算Excel/PDF取込画面
   ファイル選択→シート(ページ)選択→列の対応付け（プレビュー確認しながら
   ユーザーが指定）→変換プレビュー→保存確定、の一連の流れを扱う。
   Excel/PDFいずれもjs/estimate/のreadEstimateFile()が同じ
   {sheetNames, readSheet}形状に変換してくれるため、この画面は
   ファイル形式を意識せずDOM操作のみを担う。
   ========================================================== */

import { getSite } from "../sites.js";
import {
  readEstimateFile,
  MAPPING_FIELDS,
  buildPreviewRows,
  extractEstimateRows,
  createEstimateBatch,
  createEstimateItems
} from "../estimate/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite, hasPermission } from "../auth.js";

const backBtn = document.getElementById("backToEstimateListBtn");
const fileInput = document.getElementById("estimateFileInput");
const sheetSection = document.getElementById("estimateImportSheetSection");
const sheetSelect = document.getElementById("estimateSheetSelect");
const mappingSection = document.getElementById("estimateImportMappingSection");
const mappingFieldsEl = document.getElementById("estimateMappingFields");
const dataStartRowInput = document.getElementById("estimateDataStartRow");
const previewTableEl = document.getElementById("estimatePreviewTable");
const convertBtn = document.getElementById("estimateConvertBtn");
const resultSection = document.getElementById("estimateImportResultSection");
const resultSummaryEl = document.getElementById("estimateResultSummary");
const resultWarningEl = document.getElementById("estimateResultWarning");
const resultTableEl = document.getElementById("estimateResultTable");
const commitBtn = document.getElementById("estimateCommitBtn");
const cancelBtn = document.getElementById("estimateImportCancelBtn");

let currentSite = null;
let workbook = null;
let currentSourceFileType = "excel";
let currentSheetName = "";
let currentLayout = null;
let lastMapping = {}; // フィールドkey→列文字（同一セッション内でシートを切り替えても引き継ぐ）
let convertedItems = null;
let convertedSkipped = 0;

function fmt(n) {
  return n == null ? "" : n.toLocaleString("ja-JP");
}

function resetImportState() {
  workbook = null;
  currentSheetName = "";
  currentLayout = null;
  convertedItems = null;
  convertedSkipped = 0;
  sheetSection.hidden = true;
  mappingSection.hidden = true;
  resultSection.hidden = true;
  sheetSelect.innerHTML = "";
  mappingFieldsEl.innerHTML = "";
  previewTableEl.innerHTML = "";
  resultTableEl.innerHTML = "";
}

function renderMappingFields(colLetters) {
  mappingFieldsEl.innerHTML = MAPPING_FIELDS.map(({ key, label }) => {
    const options = ['<option value="">－</option>'].concat(colLetters.map((l) => `<option value="${l}">${l}列</option>`)).join("");
    return `<label>${escapeHtml(label)}
      <select data-field="${key}" class="estimateMappingSelect">${options}</select>
    </label>`;
  }).join("");

  MAPPING_FIELDS.forEach(({ key }) => {
    const select = mappingFieldsEl.querySelector(`[data-field="${key}"]`);
    if (lastMapping[key] && colLetters.includes(lastMapping[key])) select.value = lastMapping[key];
    select.addEventListener("change", () => {
      lastMapping[key] = select.value;
    });
  });
}

function readMappingFromForm() {
  const mapping = {};
  mappingFieldsEl.querySelectorAll(".estimateMappingSelect").forEach((select) => {
    mapping[select.dataset.field] = select.value || null;
  });
  return mapping;
}

function renderPreviewRows(preview) {
  const headHtml = `<tr><th></th>${preview.colLetters.map((l) => `<th>${l}</th>`).join("")}</tr>`;
  const bodyHtml = preview.rows
    .map((row) => `<tr><th>${row.rowNumber}</th>${preview.colLetters.map((l) => `<td>${escapeHtml(row.cells[l])}</td>`).join("")}</tr>`)
    .join("");
  previewTableEl.innerHTML = `<thead>${headHtml}</thead><tbody>${bodyHtml}</tbody>`;
}

async function loadSheet(sheetName) {
  currentSheetName = sheetName;
  currentLayout = await workbook.readSheet(sheetName);
  const preview = buildPreviewRows(currentLayout, 12);
  renderMappingFields(preview.colLetters);
  renderPreviewRows(preview);
  mappingSection.hidden = false;
  resultSection.hidden = true;
}

function renderResult() {
  const reviewCount = convertedItems.filter((i) => i.needsReview).length;
  const amountSum = convertedItems.reduce((sum, i) => sum + (i.amount || 0), 0);
  resultSummaryEl.textContent = `${convertedItems.length}件を読み取りました（合計金額 ${fmt(amountSum)}円、空欄スキップ ${convertedSkipped}行）`;
  resultWarningEl.hidden = reviewCount === 0;
  resultWarningEl.textContent =
    reviewCount > 0 ? `⚠️ ${reviewCount}件は数値変換等に問題があるため「要確認」としてマークされます。保存後に一覧で内容を確認してください。` : "";

  const headHtml = `<tr><th>行</th><th>工種</th><th>項目</th><th>仕様</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th><th></th></tr>`;
  const bodyHtml = convertedItems
    .map(
      (item) => `<tr class="${item.needsReview ? "estimate-row-warning" : ""}">
        <td>${item.sourceRow}</td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.itemName)}</td>
        <td>${escapeHtml(item.spec)}</td>
        <td class="num">${fmt(item.quantity)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td class="num">${fmt(item.unitPrice)}</td>
        <td class="num">${fmt(item.amount)}</td>
        <td>${item.needsReview ? `<span class="status-badge status-warning" title="${escapeHtml(item.reviewReasons.join(" / "))}">要確認</span>` : ""}</td>
      </tr>`
    )
    .join("");
  resultTableEl.innerHTML = `<thead>${headHtml}</thead><tbody>${bodyHtml}</tbody>`;
  resultSection.hidden = false;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  resetImportState();
  try {
    workbook = await readEstimateFile(file);
  } catch (err) {
    showMessage(err.message || "ファイルの読み込みに失敗しました。", true);
    fileInput.value = "";
    resetImportState();
    return;
  }

  currentSourceFileType = workbook.sourceFileType;
  sheetSelect.innerHTML = workbook.sheetNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  sheetSection.hidden = workbook.sheetNames.length <= 1;
  try {
    await loadSheet(workbook.sheetNames[0]);
  } catch (err) {
    showMessage(err.message || "このページの読み込みに失敗しました。別のページを選択してください。", true);
  }
});

sheetSelect.addEventListener("change", async () => {
  try {
    await loadSheet(sheetSelect.value);
  } catch (err) {
    showMessage(err.message || "このページの読み込みに失敗しました。別のページを選択してください。", true);
  }
});

convertBtn.addEventListener("click", () => {
  const mapping = readMappingFromForm();
  if (!mapping.itemName) {
    showMessage("「項目」に対応する列を指定してください。", true);
    return;
  }
  const startRow = Number(dataStartRowInput.value) || 1;
  const { items, skippedEmptyRows } = extractEstimateRows(currentLayout, mapping, startRow);
  convertedItems = items;
  convertedSkipped = skippedEmptyRows;
  if (items.length === 0) {
    showMessage("指定した条件では取り込める行がありませんでした。データ開始行や列の指定を確認してください。", true);
    resultSection.hidden = true;
    return;
  }
  renderResult();
});

commitBtn.addEventListener("click", async () => {
  if (!convertedItems || convertedItems.length === 0) {
    showMessage("保存する項目がありません。", true);
    return;
  }
  commitBtn.disabled = true;
  try {
    const mapping = readMappingFromForm();
    const sourceFileName = fileInput.files[0]?.name || "";
    const batch = await createEstimateBatch({
      siteId: currentSite.id,
      sourceFileName,
      sourceFileType: currentSourceFileType,
      sheetName: currentSheetName,
      columnMapping: mapping,
      headerRow: Number(dataStartRowInput.value) || 1,
      itemCount: convertedItems.length
    });
    await createEstimateItems({
      siteId: currentSite.id,
      estimateBatchId: batch.id,
      sourceFileName,
      sourceSheet: currentSheetName,
      rows: convertedItems
    });
    showMessage(`積算項目 ${convertedItems.length}件を取り込みました。`);
    navigate(`/sites/${currentSite.id}/estimates`);
  } catch (err) {
    showMessage(err.message || "取込の保存に失敗しました。", true);
  } finally {
    commitBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates`));
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates`));

export async function initEstimateImportView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site) || !hasPermission("editReports")) {
    showMessage("この操作を行う権限がありません。", true);
    navigate(`/sites/${params.id}/estimates`);
    return;
  }
  currentSite = site;
  fileInput.value = "";
  resetImportState();
  showView("view-estimate-import");
}
