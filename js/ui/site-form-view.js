/* ==========================================================
   現場フォーム画面（新規作成／編集）
   ========================================================== */

import { createSite, updateSite, getSite } from "../sites.js";
import { listUsers, ROLES } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { listReportTemplates, getAppDefaultReportTemplate, repinSite } from "../report-output/index.js";

const titleEl = document.getElementById("siteFormTitle");
const form = document.getElementById("siteForm");
const nameInput = document.getElementById("siteFormName");
const clientNameInput = document.getElementById("siteFormClientName");
const addressInput = document.getElementById("siteFormAddress");
const startDateInput = document.getElementById("siteFormStartDate");
const endDateInput = document.getElementById("siteFormEndDate");
const memoInput = document.getElementById("siteFormMemo");
const assignedWrap = document.getElementById("siteFormAssignedWrap");
const assignedSelect = document.getElementById("siteFormAssignedUsers");
const templateSelect = document.getElementById("siteFormReportTemplate");
const templateHint = document.getElementById("siteFormReportTemplateHint");
const cancelBtn = document.getElementById("siteFormCancelBtn");

let editingSiteId = null;
let originalTemplateSelection = ""; // 編集開始時の様式の指定（変えたときだけ版を付け替える）

async function populateAssignedSelect(assignedUserIds = []) {
  const users = await listUsers();
  const supervisors = users.filter((u) => u.role === ROLES.SUPERVISOR);
  assignedSelect.innerHTML = supervisors
    .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.displayName)}</option>`)
    .join("");
  Array.from(assignedSelect.options).forEach((opt) => {
    opt.selected = assignedUserIds.includes(opt.value);
  });
  assignedWrap.hidden = supervisors.length === 0;
}

/**
 * 日報のExcel様式の選択肢。先頭の「標準に従う」（値は空）が既定で、新規現場は原則これ
 * （標準テンプレートを最新版へ差し替えると自動的に追従する）。現場ごとに別の様式を
 * 使う場合だけ、下の一覧から選ぶ。
 */
async function populateTemplateSelect(selectedId = "") {
  const [templates, standard] = await Promise.all([listReportTemplates({ format: "excel", templateKind: "report" }), getAppDefaultReportTemplate()]);
  const standardLabel = standard ? `標準テンプレートに従う（現在: ${standard.name}）` : "標準テンプレートに従う（標準は未設定。元請名と同じ会社の様式、無ければ汎用フォーマット）";
  templateSelect.innerHTML =
    `<option value="">${escapeHtml(standardLabel)}</option>` +
    templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.isAppDefault ? "（標準）" : ""}</option>`).join("");
  templateSelect.value = selectedId && templates.some((t) => t.id === selectedId) ? selectedId : "";
  templateHint.textContent = selectedId && templateSelect.value === "" ? "この現場で指定していた様式が見つからないため、標準に従う設定になっています。" : "";
}

export async function initSiteFormViewNew() {
  showView("view-site-form");
  editingSiteId = null;
  titleEl.textContent = "新しい現場";
  form.reset();
  originalTemplateSelection = "";
  await populateAssignedSelect();
  await populateTemplateSelect();
  nameInput.focus();
}

export async function initSiteFormViewEdit(params) {
  showView("view-site-form");
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  editingSiteId = site.id;
  titleEl.textContent = "現場情報を編集";
  nameInput.value = site.name;
  clientNameInput.value = site.clientName || "";
  addressInput.value = site.address || "";
  startDateInput.value = site.startDate || "";
  endDateInput.value = site.endDate || "";
  memoInput.value = site.memo || "";
  await populateAssignedSelect(site.assignedUserIds || []);
  await populateTemplateSelect(site.reportTemplateId || "");
  originalTemplateSelection = templateSelect.value;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!nameInput.value.trim()) {
    showMessage("現場名を入力してください。", true);
    nameInput.focus();
    return;
  }

  const fields = {
    name: nameInput.value.trim(),
    clientName: clientNameInput.value.trim(),
    address: addressInput.value.trim(),
    startDate: startDateInput.value,
    endDate: endDateInput.value,
    memo: memoInput.value.trim(),
    assignedUserIds: Array.from(assignedSelect.selectedOptions).map((opt) => opt.value),
    reportTemplateId: templateSelect.value || null
  };

  if (editingSiteId) {
    await updateSite(editingSiteId, fields);
    let pinNote = "";
    if (templateSelect.value !== originalTemplateSelection) {
      // 様式の指定を変えたときだけ、選んだ様式の現在の版に固定し直す（元に戻せるよう前の固定は履歴に残す）
      try {
        await repinSite(editingSiteId, { templateId: templateSelect.value || undefined, reason: "form" });
        pinNote = " 日報のExcel様式を切り替えました（現場詳細の「前の版に戻す」で戻せます）。";
      } catch (err) {
        pinNote = ` 様式は切り替えられませんでした: ${err.message}`;
      }
    }
    showMessage(`現場情報を更新しました。${pinNote}`);
    navigate(`/sites/${editingSiteId}`);
  } else {
    const site = await createSite(fields);
    showMessage(`現場「${site.name}」を作成しました。`);
    navigate(`/sites/${site.id}`);
  }
});

cancelBtn.addEventListener("click", () => {
  navigate(editingSiteId ? `/sites/${editingSiteId}` : "/sites");
});
