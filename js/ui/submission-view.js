/* ==========================================================
   提出金額内訳書の画面
   会社様式テンプレートの登録・出力設定・区分グループ・積算項目の割当・
   確認プレビュー・Excel出力までを1画面で扱う。積算項目（estimateItems）
   は表示・参照するだけで、変更しない。割当・設定は出力専用の別ストア
   （js/submission/）に保存する。
   ========================================================== */

import { getSite } from "../sites.js";
import { listEstimateItemsBySite } from "../estimate/index.js";
import { listReportTemplates, deleteReportTemplate } from "../report-output/reportTemplates.js";
import {
  getSubmissionPlan,
  saveSubmissionPlan,
  newSubmissionGroup,
  SUBMISSION_GROUP_KIND_LABELS,
  listSubmissionAssignments,
  assignItems,
  unassignItems,
  setAssignmentNote,
  previewSubmissionOutput,
  generateSubmissionOutput,
  registerSubmissionTemplate
} from "../submission-output/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { hasPermission, canAccessSite } from "../auth.js";

const $ = (id) => document.getElementById(id);
const els = {
  siteName: $("submissionSiteName"),
  back: $("backToSiteFromSubmissionBtn"),
  templateSelect: $("submissionTemplateSelect"),
  templateFile: $("submissionTemplateFile"),
  templateRegister: $("submissionTemplateRegisterBtn"),
  templateDelete: $("submissionTemplateDeleteBtn"),
  templateInfo: $("submissionTemplateInfo"),
  projectTitle: $("submissionProjectTitle"),
  companyName: $("submissionCompanyName"),
  printMode: $("submissionPrintMode"),
  allowUnassigned: $("submissionAllowUnassigned"),
  saveSettings: $("submissionSaveSettingsBtn"),
  groupList: $("submissionGroupList"),
  newGroupName: $("submissionNewGroupName"),
  newGroupKind: $("submissionNewGroupKind"),
  addGroup: $("submissionAddGroupBtn"),
  assignGroup: $("submissionAssignGroup"),
  assignWorkType: $("submissionAssignWorkType"),
  assignSubType: $("submissionAssignSubType"),
  workTypeList: $("submissionWorkTypeList"),
  subTypeList: $("submissionSubTypeList"),
  assignBtn: $("submissionAssignBtn"),
  unassignBtn: $("submissionUnassignBtn"),
  onlyUnassigned: $("submissionOnlyUnassigned"),
  assignSummary: $("submissionAssignSummary"),
  selectAll: $("submissionSelectAll"),
  itemBody: $("submissionItemTableBody"),
  preview: $("submissionPreview"),
  issueList: $("submissionIssueList"),
  generate: $("submissionGenerateBtn")
};

let state = { site: null, plan: null, templates: [], items: [], assignments: [], preview: null };

const fmt = (n) => (n == null ? "" : Number(n).toLocaleString("ja-JP"));
const KIND_RANK = { building: 0, common_temp_itemized: 1, common_temp_general: 1, site_management: 2 };

function orderedGroups() {
  return (state.plan?.groups || [])
    .map((g, index) => ({ g, index }))
    .sort((a, b) => (KIND_RANK[a.g.kind] ?? 9) - (KIND_RANK[b.g.kind] ?? 9) || a.index - b.index)
    .map(({ g }) => g);
}

function groupLabelOf(groupId) {
  return (state.plan?.groups || []).find((g) => g.id === groupId)?.name || "（削除済みの区分）";
}

async function persistGroups(groups) {
  state.plan = await saveSubmissionPlan(state.site.id, { groups });
}

async function reload() {
  const siteId = state.site.id;
  state.plan = await getSubmissionPlan(siteId);
  state.templates = await listReportTemplates({ templateKind: "submission" });
  state.items = await listEstimateItemsBySite(siteId);
  state.assignments = await listSubmissionAssignments(siteId);
  render();
  await renderPreview();
}

function render() {
  renderTemplates();
  renderSettings();
  renderGroups();
  renderAssignControls();
  renderItemTable();
}

function renderTemplates() {
  const selectedId = state.plan?.templateId || "";
  els.templateSelect.innerHTML =
    `<option value="">（会社様式を選択）</option>` +
    state.templates.map((t) => `<option value="${t.id}" ${t.id === selectedId ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
  const t = state.templates.find((x) => x.id === selectedId);
  els.templateInfo.textContent = t
    ? `様式解析結果: 1頁${t.mapping.pageRows}行／原本の頁数${t.mapping.templatePageCount}頁／明細行位置は${t.mapping.lineParity === 1 ? "奇数" : "偶数"}行（上限${t.mapping.positions.lastLine}行目）／原本の会社名「${t.mapping.defaults.companyName}」`
    : state.templates.length === 0
      ? "会社指定の様式（例: 七里 提出金額.xlsx）を登録してください。登録した様式は複製して使い、原本は変更されません。"
      : "";
}

function renderSettings() {
  els.projectTitle.value = state.plan?.projectTitle || "";
  els.projectTitle.placeholder = `未入力の場合は現場名（${state.site.name}）`;
  els.companyName.value = state.plan?.companyNameOverride || "";
  const t = state.templates.find((x) => x.id === state.plan?.templateId);
  els.companyName.placeholder = t ? `様式のまま（${t.mapping.defaults.companyName}）` : "様式のまま";
  els.printMode.value = state.plan?.printMode || "original";
  els.allowUnassigned.checked = !!state.plan?.allowUnassigned;
}

function renderGroups() {
  const groups = orderedGroups();
  const used = new Set(state.assignments.map((a) => a.groupId));
  let symbolIndex = 0;
  els.groupList.innerHTML = groups
    .map((g) => {
      const symbol = used.has(g.id) ? String.fromCharCode(0xff21 + symbolIndex++) : "－";
      const count = state.assignments.filter((a) => a.groupId === g.id).length;
      return `<li data-group-id="${g.id}">
        <span class="group-symbol">${symbol}</span>
        <span class="group-name">${escapeHtml(g.name)}</span>
        <span class="status-badge status-default">${SUBMISSION_GROUP_KIND_LABELS[g.kind]}</span>
        <span>${count}項目</span>
        <label class="checkbox-label"><input type="checkbox" class="groupExpand" ${g.expand !== false ? "checked" : ""}> 内訳頁を作る</label>
        <button type="button" class="secondary-btn groupUp">↑</button>
        <button type="button" class="secondary-btn groupDown">↓</button>
        <button type="button" class="secondary-btn groupDelete">削除</button>
      </li>`;
    })
    .join("");
  if (groups.length === 0) els.groupList.innerHTML = `<li>区分グループがまだありません。下から追加してください。</li>`;
}

function renderAssignControls() {
  els.newGroupKind.innerHTML = Object.entries(SUBMISSION_GROUP_KIND_LABELS).map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  const previous = els.assignGroup.value;
  els.assignGroup.innerHTML =
    `<option value="">（区分グループを選択）</option>` + orderedGroups().map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  if (previous) els.assignGroup.value = previous;
  const workTypes = new Set(state.assignments.map((a) => a.workType).filter(Boolean));
  const subTypes = new Set(state.assignments.map((a) => a.subType).filter(Boolean));
  els.workTypeList.innerHTML = [...workTypes].map((w) => `<option value="${escapeHtml(w)}">`).join("");
  els.subTypeList.innerHTML = [...subTypes].map((s) => `<option value="${escapeHtml(s)}">`).join("");
}

function assignmentLabel(a) {
  if (!a) return "";
  return [groupLabelOf(a.groupId), a.workType, a.subType].filter(Boolean).join(" ／ ");
}

function renderItemTable() {
  const assignmentByItem = new Map(state.assignments.map((a) => [a.estimateItemId, a]));
  const rows = state.items.filter((item) => !els.onlyUnassigned.checked || !assignmentByItem.has(item.id));
  const unassigned = state.items.filter((item) => !assignmentByItem.has(item.id)).length;
  els.assignSummary.textContent = `積算項目 ${state.items.length}件 ／ 割当済み ${state.items.length - unassigned}件 ／ 未割当 ${unassigned}件`;
  els.itemBody.innerHTML = rows
    .map((item) => {
      const a = assignmentByItem.get(item.id);
      return `<tr data-item-id="${item.id}" class="${a ? "" : "submission-unassigned"}">
        <td><input type="checkbox" class="itemCheck" aria-label="選択"></td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.itemName)}</td>
        <td>${escapeHtml(item.spec)}</td>
        <td class="num">${fmt(item.quantity)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td class="num">${fmt(item.unitPrice)}</td>
        <td class="num">${fmt(item.amount)}</td>
        <td>${a ? escapeHtml(assignmentLabel(a)) : '<span class="status-badge status-warning">未割当</span>'}</td>
        <td>${a ? `<input type="text" class="itemNote" value="${escapeHtml(a.note || "")}">` : ""}</td>
      </tr>`;
    })
    .join("");
  els.selectAll.checked = false;
}

async function renderPreview() {
  const templateId = state.plan?.templateId || null;
  let result;
  try {
    result = await previewSubmissionOutput({ siteId: state.site.id, templateId });
  } catch (err) {
    els.preview.innerHTML = `<p class="empty-message">${escapeHtml(err.message)}</p>`;
    els.generate.disabled = true;
    return;
  }
  state.preview = result;
  const { model, pageInfo, template } = result;
  const t = model.totals;
  els.preview.innerHTML = `
    <table>
      <tr><th>直接工事費 計</th><td class="num">${fmt(t.directTotal)} 円</td></tr>
      <tr><th>共通仮設費（積上＋一般）</th><td class="num">${fmt(t.commonTotal)} 円</td></tr>
      <tr><th>純工事費</th><td class="num">${fmt(t.netTotal)} 円</td></tr>
      <tr><th>現場管理費</th><td class="num">${fmt(t.managementTotal)} 円</td></tr>
      <tr><th>工事原価</th><td class="num">${fmt(t.costTotal)} 円</td></tr>
      <tr><th>出力頁数</th><td class="num">${pageInfo ? `${pageInfo.pageCount}頁（うち継続頁 ${pageInfo.continuationPageCount}頁）` : template ? "（エラーがあるため未計算）" : "（様式未選択）"}</td></tr>
      <tr><th>出力する明細行</th><td class="num">${model.stats.detailCount}件／積算項目${model.stats.itemCount}件</td></tr>
    </table>`;
  const issues = [
    ...model.errors.map((e) => `<li class="issue-error">⛔ ${escapeHtml(e.message)}</li>`),
    ...model.warnings.map((w) => `<li class="issue-warn">⚠ ${escapeHtml(w.message)}</li>`)
  ];
  if (pageInfo && pageInfo.continuationPageCount > 0) {
    const names = pageInfo.continuedSchedules.map((s) => `「${s.name}」（${s.pages}頁）`).join("、");
    issues.push(`<li class="issue-warn">⚠ 1頁に収まらないため継続頁が${pageInfo.continuationPageCount}頁できます: ${escapeHtml(names)}。元の様式には前例が無い体裁です（小計は最終頁のみ）。項目の割当を分けるか、このまま出力してよいか確認してください。</li>`);
  }
  if (!template) issues.unshift(`<li class="issue-error">⛔ 会社様式（テンプレート）が選択されていません。</li>`);
  els.issueList.innerHTML = issues.join("");
  els.generate.disabled = !template || model.errors.length > 0 || !hasPermission("output");
}

// ---- イベント ----

els.back.addEventListener("click", () => navigate(`/sites/${state.site.id}`));
$("submissionGoToImportBtn").addEventListener("click", () => navigate(`/sites/${state.site.id}/submission/import`));

els.templateSelect.addEventListener("change", async () => {
  state.plan = await saveSubmissionPlan(state.site.id, { templateId: els.templateSelect.value || null });
  render();
  await renderPreview();
});

els.templateRegister.addEventListener("click", async () => {
  const file = els.templateFile.files[0];
  if (!file) return showMessage("登録する会社様式（.xlsx）を選択してください。", true);
  try {
    const result = await registerSubmissionTemplate({ file });
    if (!result.ok) return showMessage(`この様式は登録できません: ${result.errors.join(" ")}`, true);
    state.plan = await saveSubmissionPlan(state.site.id, { templateId: result.template.id });
    els.templateFile.value = "";
    showMessage(`会社様式「${result.template.name}」を登録しました。`);
    await reload();
  } catch (err) {
    showMessage(`様式の登録に失敗しました: ${err.message}`, true);
  }
});

els.templateDelete.addEventListener("click", async () => {
  const t = state.templates.find((x) => x.id === state.plan?.templateId);
  if (!t) return showMessage("削除する会社様式を選択してください。", true);
  if (!confirm(`会社様式「${t.name}」を削除しますか？（この様式で作成済みのExcelは影響を受けません）`)) return;
  await deleteReportTemplate(t.id);
  state.plan = await saveSubmissionPlan(state.site.id, { templateId: null });
  showMessage("会社様式を削除しました。");
  await reload();
});

els.saveSettings.addEventListener("click", async () => {
  state.plan = await saveSubmissionPlan(state.site.id, {
    projectTitle: els.projectTitle.value.trim(),
    companyNameOverride: els.companyName.value.trim(),
    printMode: els.printMode.value,
    allowUnassigned: els.allowUnassigned.checked
  });
  showMessage("出力設定を保存しました。");
  await renderPreview();
});

els.addGroup.addEventListener("click", async () => {
  try {
    const group = newSubmissionGroup({ name: els.newGroupName.value, kind: els.newGroupKind.value });
    await persistGroups([...(state.plan?.groups || []), group]);
    els.newGroupName.value = "";
    await reload();
  } catch (err) {
    showMessage(err.message, true);
  }
});

els.groupList.addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-group-id]");
  if (!li) return;
  const id = li.dataset.groupId;
  const groups = [...state.plan.groups];
  const index = groups.findIndex((g) => g.id === id);
  if (e.target.closest(".groupDelete")) {
    const assigned = state.assignments.filter((a) => a.groupId === id);
    if (!confirm(`区分グループ「${groups[index].name}」を削除しますか？${assigned.length ? `割当済みの${assigned.length}項目は未割当に戻ります。` : ""}`)) return;
    if (assigned.length) await unassignItems(state.site.id, assigned.map((a) => a.estimateItemId));
    groups.splice(index, 1);
    await persistGroups(groups);
    await reload();
  } else if (e.target.closest(".groupUp") || e.target.closest(".groupDown")) {
    const to = e.target.closest(".groupUp") ? index - 1 : index + 1;
    if (to < 0 || to >= groups.length) return;
    [groups[index], groups[to]] = [groups[to], groups[index]];
    await persistGroups(groups);
    await reload();
  }
});

els.groupList.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("groupExpand")) return;
  const id = e.target.closest("li").dataset.groupId;
  await persistGroups(state.plan.groups.map((g) => (g.id === id ? { ...g, expand: e.target.checked } : g)));
  await renderPreview();
});

function selectedItems() {
  const ids = [...els.itemBody.querySelectorAll("tr")]
    .filter((tr) => tr.querySelector(".itemCheck")?.checked)
    .map((tr) => tr.dataset.itemId);
  return state.items.filter((item) => ids.includes(item.id));
}

els.selectAll.addEventListener("change", () => {
  els.itemBody.querySelectorAll(".itemCheck").forEach((cb) => (cb.checked = els.selectAll.checked));
});

els.onlyUnassigned.addEventListener("change", renderItemTable);

els.assignBtn.addEventListener("click", async () => {
  const items = selectedItems();
  if (items.length === 0) return showMessage("割り当てる項目にチェックを入れてください。", true);
  try {
    await assignItems(state.site.id, items, { groupId: els.assignGroup.value, workType: els.assignWorkType.value, subType: els.assignSubType.value });
    showMessage(`${items.length}件を割り当てました。`);
    await reload();
  } catch (err) {
    showMessage(err.message, true);
  }
});

els.unassignBtn.addEventListener("click", async () => {
  const items = selectedItems();
  if (items.length === 0) return showMessage("解除する項目にチェックを入れてください。", true);
  await unassignItems(state.site.id, items.map((i) => i.id));
  await reload();
});

els.itemBody.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("itemNote")) return;
  await setAssignmentNote(e.target.closest("tr").dataset.itemId, e.target.value);
  await renderPreview();
});

els.generate.addEventListener("click", async () => {
  const warnings = state.preview?.model.warnings || [];
  const needsConfirm = warnings.filter((w) => w.code === "missing_amount" || w.code === "lump_sum").map((w) => w.message);
  const pageInfo = state.preview?.pageInfo;
  if (pageInfo?.continuationPageCount > 0) {
    needsConfirm.push(`1頁に収まらないため継続頁が${pageInfo.continuationPageCount}頁できます（${pageInfo.continuedSchedules.map((s) => `「${s.name}」`).join("、")}）。元の様式に前例のない体裁です。`);
  }
  if (needsConfirm.length > 0 && !confirm(`次の点を確認のうえ出力しますか？\n\n${needsConfirm.map((m) => `・${m}`).join("\n")}`)) return;
  els.generate.disabled = true;
  try {
    const { blob, filename, meta } = await generateSubmissionOutput({ siteId: state.site.id });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showMessage(`「${filename}」を出力しました（${meta.pageCount}頁）。`);
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    await renderPreview();
  }
});

export async function initSubmissionView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site)) {
    showMessage("この現場を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  state = { site, plan: null, templates: [], items: [], assignments: [], preview: null };
  els.siteName.textContent = `：${site.name}`;
  showView("view-submission");
  await reload();
}
