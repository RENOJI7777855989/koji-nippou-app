/* ==========================================================
   現場フォーム画面（新規作成／編集）
   ========================================================== */

import { createSite, updateSite, getSite } from "../sites.js";
import { listUsers, ROLES } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

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
const cancelBtn = document.getElementById("siteFormCancelBtn");

let editingSiteId = null;

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

export async function initSiteFormViewNew() {
  showView("view-site-form");
  editingSiteId = null;
  titleEl.textContent = "新しい現場";
  form.reset();
  await populateAssignedSelect();
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
    assignedUserIds: Array.from(assignedSelect.selectedOptions).map((opt) => opt.value)
  };

  if (editingSiteId) {
    await updateSite(editingSiteId, fields);
    showMessage("現場情報を更新しました。");
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
