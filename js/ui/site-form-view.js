/* ==========================================================
   現場フォーム画面（新規作成／編集）
   ========================================================== */

import { createSite, updateSite, getSite } from "../sites.js";
import { listUsers, ROLES } from "../auth.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { listReportTemplates, getAppDefaultReportTemplate, repinSite, resolveReportTemplateForSite } from "../report-output/index.js";

const titleEl = document.getElementById("siteFormTitle");
const form = document.getElementById("siteForm");
const nameInput = document.getElementById("siteFormName");
const clientNameInput = document.getElementById("siteFormClientName");
const addressInput = document.getElementById("siteFormAddress");
const startDateInput = document.getElementById("siteFormStartDate");
const endDateInput = document.getElementById("siteFormEndDate");
const constructionNumberInput = document.getElementById("siteFormConstructionNumber");
const progressNote = document.getElementById("siteFormProgressNote");
const PROGRESS_NOTE = "進捗率は日誌ごとに入力します（日誌の入力画面の「進捗率（％）」）。";
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

let templateChoices = []; // 選択肢のテンプレート（説明文に版を出すため）
let standardTemplate = null;
let currentUse = null; // 編集中の現場が今使っている様式（resolveReportTemplateForSite の結果）
let editingCompleted = false;
let missingSelection = false;

/**
 * 日報のExcel様式の選択肢。先頭の「標準テンプレートに従う」（値は空）が既定で、新規現場は原則これ。
 * 現場は作成時（または様式を切り替えたとき）の様式・版に固定されるので、「標準に従う」の現場でも、
 * 後から標準を変えただけでは切り替わらない。別の様式にするときは、下の一覧から様式を直接選ぶ
 * （選び直して保存したときだけ、その様式の現在の版に固定し直す）。
 */
async function populateTemplateSelect(selectedId = "") {
  const [templates, standard] = await Promise.all([listReportTemplates({ format: "excel", templateKind: "report" }), getAppDefaultReportTemplate()]);
  templateChoices = templates;
  standardTemplate = standard;
  const standardLabel = standard ? `標準テンプレートに従う（今の標準: ${standard.name}）` : "標準テンプレートに従う（標準は未設定。元請名と同じ会社の様式、無ければ汎用フォーマット）";
  templateSelect.innerHTML =
    `<option value="">${escapeHtml(standardLabel)}</option>` +
    templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(choiceName(t))} ― この現場をこの様式に固定</option>`).join("");
  templateSelect.value = selectedId && templates.some((t) => t.id === selectedId) ? selectedId : "";
  missingSelection = !!selectedId && templateSelect.value === "";
  updateTemplateHint();
}

/** 選択肢の様式名（標準には「（標準）」。名前に既に付いていれば重ねない） */
const choiceName = (t) => (t.isAppDefault && !String(t.name).endsWith("（標準）") ? `${t.name}（標準）` : t.name);

/** 選択欄の下の説明: 今使っている様式と、保存するとどうなるか */
function updateTemplateHint() {
  const lines = [];
  if (missingSelection) lines.push("この現場で指定していた様式が見つからないため、標準に従う設定になっています。");
  if (currentUse) lines.push(`この現場が今使っている様式: ${currentUse.templateName} 第${currentUse.revision || "?"}版`);
  if (editingCompleted) {
    lines.push("工事完了の現場は、日報のExcel様式を切り替えられません（工事完了を解除すると切り替えられます）。");
  } else if (editingSiteId && (templateSelect.value !== originalTemplateSelection || (templateSelect.value && currentUse && templateSelect.value !== currentUse.baseTemplateId))) {
    const t = templateChoices.find((x) => x.id === templateSelect.value);
    if (t) lines.push(`保存すると、この現場の日報（過去の日の分も含む）のExcel・PDF・印刷・台帳は「${t.name}」第${t.revision || 1}版で出力されます（出力済みのファイルは変わりません。現場詳細の「前の様式に戻す」で戻せます）。`);
    else lines.push("保存すると、標準テンプレート（無ければ元請名と同じ会社の様式）の現在の版に切り替わります。");
  } else if (editingSiteId && templateSelect.value === "" && currentUse && standardTemplate && currentUse.baseTemplateId !== standardTemplate.id) {
    lines.push(`標準（${standardTemplate.name}）に切り替えるには、一覧から「${choiceName(standardTemplate)} ― この現場をこの様式に固定」を選んで保存してください（「標準テンプレートに従う」のままでは、今の様式から切り替わりません）。`);
  }
  templateHint.textContent = lines.join("\n");
}
templateSelect.addEventListener("change", updateTemplateHint);

export async function initSiteFormViewNew() {
  showView("view-site-form");
  editingSiteId = null;
  titleEl.textContent = "新しい現場";
  form.reset();
  progressNote.textContent = PROGRESS_NOTE;
  originalTemplateSelection = "";
  currentUse = null;
  editingCompleted = false;
  templateSelect.disabled = false;
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
  constructionNumberInput.value = site.constructionNumber || "";
  // 以前この画面で入力した進捗率（site.progressPercent）は、消さずに残す（画面からは入力しない・保存でも上書きしない）
  progressNote.textContent = site.progressPercent != null ? `${PROGRESS_NOTE}以前この画面で入力した値（${site.progressPercent}%）は消さずに残しています。` : PROGRESS_NOTE;
  memoInput.value = site.memo || "";
  await populateAssignedSelect(site.assignedUserIds || []);
  originalTemplateSelection = site.reportTemplateId || "";
  editingCompleted = !!site.completedAt;
  currentUse = await resolveReportTemplateForSite(site).catch(() => null);
  await populateTemplateSelect(site.reportTemplateId || "");
  originalTemplateSelection = templateSelect.value;
  // 工事完了の現場は様式を切り替えない（日報は確定済み。再出力は固定した様式・版で行う）
  templateSelect.disabled = editingCompleted;
  updateTemplateHint();
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
    constructionNumber: constructionNumberInput.value.trim(),
    memo: memoInput.value.trim(),
    assignedUserIds: Array.from(assignedSelect.selectedOptions).map((opt) => opt.value),
    // 工事完了の現場は様式の指定を変えない（選択欄は操作できないが、念のため元の指定を保つ）
    reportTemplateId: (editingCompleted ? originalTemplateSelection : templateSelect.value) || null
  };

  if (editingSiteId) {
    await updateSite(editingSiteId, fields);
    let pinNote = "";
    // 様式の指定を変えたとき、または選んだ様式が今実際に使っている様式と違うときに、選んだ様式の現在の版に
    // 固定し直す（元に戻せるよう前の固定は履歴に残す）。同じ様式・同じ版なら repinSite は何もしない。
    // 「標準テンプレートに従う」のままの場合は、従来どおり指定を変えたときだけ切り替える。
    const pickedDiffersFromUse = !!templateSelect.value && !!currentUse && templateSelect.value !== currentUse.baseTemplateId;
    if (!editingCompleted && (templateSelect.value !== originalTemplateSelection || pickedDiffersFromUse)) {
      try {
        const repinned = await repinSite(editingSiteId, { templateId: templateSelect.value || undefined, reason: "form" });
        const now = await resolveReportTemplateForSite(repinned).catch(() => null);
        pinNote = now
          ? ` 日報のExcel様式を「${now.templateName}」第${now.revision || "?"}版に切り替えました。この現場の今後のExcel・PDF・印刷・台帳出力ではこの様式を使います。出力済みのファイルは変わりません（現場詳細の「前の様式に戻す」で戻せます）。`
          : " 日報のExcel様式を切り替えました（現場詳細の「前の様式に戻す」で戻せます）。";
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
