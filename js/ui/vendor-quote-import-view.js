/* ==========================================================
   業者見積の取込画面
   js/ui/estimate-import-view.jsと同型（ファイル選択→シート/ページ
   選択→列の対応付け→変換プレビュー→保存確定）。積算との差分は、
   業者名・見積番号・見積日の入力欄と、.csvファイルにも対応する点。
   ========================================================== */

import { getSite } from "../sites.js";
import {
  readVendorQuoteFile,
  MAPPING_FIELDS,
  buildPreviewRows,
  extractEstimateRows,
  createVendorQuoteBatch,
  createVendorQuoteItems,
  findDuplicateVendorQuoteBatch,
  findPreviousVersionCandidate,
  carryOverConfirmations,
  sha256Hex,
  detectLumpSum,
  LUMP_SUM_LABEL
} from "../vendorQuote/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite, hasPermission } from "../auth.js";

const backBtn = document.getElementById("backToVendorQuoteListBtn");
const vendorNameInput = document.getElementById("vendorQuoteVendorName");
const quoteNumberInput = document.getElementById("vendorQuoteNumber");
const quoteDateInput = document.getElementById("vendorQuoteDate");
const fileInput = document.getElementById("vendorQuoteFileInput");
const sheetSection = document.getElementById("vendorQuoteImportSheetSection");
const sheetSelect = document.getElementById("vendorQuoteSheetSelect");
const mappingSection = document.getElementById("vendorQuoteImportMappingSection");
const mappingFieldsEl = document.getElementById("vendorQuoteMappingFields");
const dataStartRowInput = document.getElementById("vendorQuoteDataStartRow");
const previewTableEl = document.getElementById("vendorQuotePreviewTable");
const convertBtn = document.getElementById("vendorQuoteConvertBtn");
const resultSection = document.getElementById("vendorQuoteImportResultSection");
const resultSummaryEl = document.getElementById("vendorQuoteResultSummary");
const resultWarningEl = document.getElementById("vendorQuoteResultWarning");
const resultTableEl = document.getElementById("vendorQuoteResultTable");
const commitBtn = document.getElementById("vendorQuoteCommitBtn");
const cancelBtn = document.getElementById("vendorQuoteImportCancelBtn");

let currentSite = null;
let workbook = null;
let currentSourceFileType = "excel";
let currentFileSha256 = null;
let currentSheetName = "";
let currentLayout = null;
let lastMapping = {};
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
      <select data-field="${key}" class="vendorQuoteMappingSelect">${options}</select>
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
  mappingFieldsEl.querySelectorAll(".vendorQuoteMappingSelect").forEach((select) => {
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

/** 一式の可能性の目印（確定ではない。数量×単価などの計算はしない） */
function lumpBadge(item) {
  const lump = detectLumpSum(item);
  return lump.isLumpSum ? `<span class="status-badge status-warning" title="${escapeHtml(lump.reasons.join(" / "))}">${LUMP_SUM_LABEL}</span>` : "";
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
        <td>${item.needsReview ? `<span class="status-badge status-warning" title="${escapeHtml(item.reviewReasons.join(" / "))}">要確認</span>` : ""}${lumpBadge(item)}</td>
      </tr>`
    )
    .join("");
  resultTableEl.innerHTML = `<thead>${headHtml}</thead><tbody>${bodyHtml}</tbody>`;
  resultSection.hidden = false;
}

// ファイルのドラッグ＆ドロップ（Windows PCでのマウス操作向け）。選択と同じ経路（change）を通す
const dropZone = document.getElementById("view-vendor-quote-import");
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
["dragenter", "dragover"].forEach((type) =>
  dropZone.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
dropZone.addEventListener("dragleave", (e) => {
  if (e.target === dropZone) dropZone.classList.remove("drag-over");
});
dropZone.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event("change"));
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  resetImportState();
  try {
    currentFileSha256 = await sha256Hex(await file.arrayBuffer());
    workbook = await readVendorQuoteFile(file);
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
    showMessage(err.message || "このシート／ページの読み込みに失敗しました。別のものを選択してください。", true);
  }
});

sheetSelect.addEventListener("change", async () => {
  try {
    await loadSheet(sheetSelect.value);
  } catch (err) {
    showMessage(err.message || "このシート／ページの読み込みに失敗しました。別のものを選択してください。", true);
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
    const selectedFile = fileInput.files[0] || null;
    const sourceFileName = selectedFile?.name || "";
    // 同一ファイル・同一シートの重複取込を防ぐ（SHA-256が一致する取込が既にあれば保存しない）
    const duplicate = await findDuplicateVendorQuoteBatch({ siteId: currentSite.id, sourceFileSha256: currentFileSha256, sheetName: currentSheetName });
    if (duplicate) {
      showMessage(`同じファイル・同じシートは取込済みです（${duplicate.vendorName || "業者名未入力"}／${new Date(duplicate.importedAt).toLocaleString("ja-JP")}）。重複取込はしません。`, true);
      return;
    }
    // 同じ業者の別の版（内容が変わった見積）があれば、前の版として扱い、変更のない行の確認結果を引き継ぐか確認する
    const previous = await findPreviousVersionCandidate({ siteId: currentSite.id, vendorName: vendorNameInput.value, sourceFileSha256: currentFileSha256 });
    const asRevision = !!previous && confirm(`同じ業者名の前回の取込（${previous.sourceFileName}／${new Date(previous.importedAt).toLocaleString("ja-JP")}）があります。\n\n前の版として扱い、変更のない行の確認結果（見積落とし確認）を引き継ぎますか？\n変更・追加された行は引き継がず、再確認になります。「キャンセル」で引き継がずに取り込みます。`);
    const batch = await createVendorQuoteBatch({
      siteId: currentSite.id,
      vendorName: vendorNameInput.value.trim(),
      quoteNumber: quoteNumberInput.value.trim(),
      quoteDate: quoteDateInput.value,
      sourceFileName,
      sourceFileType: currentSourceFileType,
      sourceFileBlob: selectedFile,
      sourceFileMimeType: selectedFile?.type || "",
      sourceFileSha256: currentFileSha256,
      revisionOf: asRevision ? previous.id : null,
      sheetName: currentSheetName,
      columnMapping: mapping,
      headerRow: Number(dataStartRowInput.value) || 1,
      itemCount: convertedItems.length
    });
    await createVendorQuoteItems({
      siteId: currentSite.id,
      vendorQuoteBatchId: batch.id,
      sourceFileName,
      sourceSheet: currentSheetName,
      rows: convertedItems,
      columnMapping: mapping,
      sourceFileSha256: currentFileSha256,
      sourceFileType: currentSourceFileType
    });
    let carryNote = "";
    if (asRevision) {
      const r = await carryOverConfirmations({ siteId: currentSite.id, fromBatchId: previous.id, toBatchId: batch.id });
      carryNote = `（前の版との差分: 追加${r.diff.added}・削除${r.diff.removed}・変更${r.diff.changed}・変更なし${r.diff.unchanged}／確認結果を${r.carried}件引き継ぎ）`;
    }
    showMessage(`業者見積項目 ${convertedItems.length}件を取り込みました。${carryNote}`);
    navigate(`/sites/${currentSite.id}/vendor-quotes`);
  } catch (err) {
    showMessage(err.message || "取込の保存に失敗しました。", true);
  } finally {
    commitBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes`));
backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/vendor-quotes`));

export async function initVendorQuoteImportView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site) || !hasPermission("editReports")) {
    showMessage("この操作を行う権限がありません。", true);
    navigate(`/sites/${params.id}/vendor-quotes`);
    return;
  }
  currentSite = site;
  vendorNameInput.value = "";
  quoteNumberInput.value = "";
  quoteDateInput.value = "";
  fileInput.value = "";
  currentFileSha256 = null;
  resetImportState();
  showView("view-vendor-quote-import");
}
