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
  setDefaultReportTemplate,
  getAppDefaultReportTemplate,
  setAppDefaultReportTemplate,
  clearAppDefaultReportTemplate,
  listTemplateVersions,
  replaceReportTemplateFile,
  restoreReportTemplateVersion,
  sha256OfBlob,
  inspectTemplate,
  compareTemplateVersions,
  getLayoutProfile,
  listSitesPinnedToVersion,
  normalizeAppDefaultReportTemplate,
  getBundledTemplateStatuses,
  installBundledTemplate,
  prepareBundledUpdate,
  applyBundledUpdate,
  runBundledSetup
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
const inspectListEl = document.getElementById("reportTemplateInspectList");
const asStandardInput = document.getElementById("reportTemplateAsStandard");
const standardSummaryEl = document.getElementById("reportTemplateStandardSummary");
const bundledSectionEl = document.getElementById("bundledTemplateSection");

let editingId = null;
let editingExistingFile = null; // { name, mimeType } 編集時、ファイル未選択なら保持する
let editingExistingBlob = null; // 編集時の現在のファイル（差し替え前後の比較用）
let fileCheck = null; // 選択中ファイルの検査結果 { inspect, compare, errors, warnings }

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
  companySelect.innerHTML = `<option value="">共通（会社に紐づけない）</option>` + options + `<option value="__new__">＋ 新しい会社を追加</option>`;
  companySelect.value = selectedId && companies.some((c) => c.id === selectedId) ? selectedId : "";
  toggleNewCompanyWrap();
}

function toggleNewCompanyWrap() {
  newCompanyWrap.style.display = companySelect.value === "__new__" ? "block" : "none";
}

/** アプリに同梱した標準テンプレート（クリーンな03-2）の登録・更新 */
async function renderBundledSection() {
  const statuses = await getBundledTemplateStatuses();
  bundledSectionEl.hidden = statuses.length === 0;
  bundledSectionEl.innerHTML = statuses
    .map(({ entry, status, record, customized }) => {
      const state = {
        not_registered: "この端末には未登録です。",
        up_to_date: `登録済み（同梱の第${entry.bundleVersion || 1}版と同じ内容）。${customized ? "ただし、現在使っているファイルは差し替え済みです。" : ""}`,
        update_available: `同梱の新しい版（第${entry.bundleVersion || 1}版）があります。現在は第${record?.bundledVersion || 1}版のもとで登録されています。${customized ? "（現在使っているファイルは差し替え済みです）" : ""}`,
        needs_key: "この端末には未登録です。社内で配布している「セットアップリンク」を開くか、下にリンク（または鍵）を貼り付けて登録してください（初回の1回だけ）。",
        update_needs_key: `同梱の新しい版（第${entry.bundleVersion || 1}版）がありますが、別の鍵で暗号化されています。新しいセットアップリンクを開くか、下に貼り付けてください。`
      }[status];
      const button = status === "not_registered" ? `登録して標準にする` : status === "update_available" ? `同梱の新しい版へ更新` : "";
      const keyForm = status === "needs_key" || status === "update_needs_key"
        ? `<div class="toolbar"><input type="password" class="bundledSetupInput" autocomplete="off" placeholder="セットアップリンク（…#setup=…）または鍵" aria-label="セットアップリンクまたは鍵"><button type="button" class="secondary-btn bundledSetupBtn">登録</button></div>`
        : "";
      return `<div class="bundled-template-item" data-entry-id="${escapeHtml(entry.id)}" data-status="${status}"><p class="report-template-name">アプリ同梱: ${escapeHtml(entry.name)}</p><p class="report-template-meta">${escapeHtml(state)}（他工事・個人の情報を除き、暗号化した複製です）</p>${button ? `<button type="button" class="secondary-btn bundledTemplateActionBtn">${button}</button>` : ""}${keyForm}</div>`;
    })
    .join("");
}

bundledSectionEl.addEventListener("click", async (e) => {
  const setupBtn = e.target.closest(".bundledSetupBtn");
  if (setupBtn) {
    const input = setupBtn.closest(".bundled-template-item").querySelector(".bundledSetupInput");
    setupBtn.disabled = true;
    try {
      const r = await runBundledSetup(input.value);
      input.value = "";
      showMessage(r.installed.length ? "同梱の標準テンプレートを登録しました。以後は鍵の入力なしで使えます。" : "鍵を保存しました。");
    } catch (err) {
      showMessage(`登録できませんでした: ${err.message}`, true);
    } finally {
      setupBtn.disabled = false;
    }
    await renderList();
    return;
  }
  const btn = e.target.closest(".bundledTemplateActionBtn");
  if (!btn) return;
  const item = btn.closest(".bundled-template-item");
  const statuses = await getBundledTemplateStatuses();
  const found = statuses.find((s) => s.entry.id === item.dataset.entryId);
  if (!found) return;
  btn.disabled = true;
  try {
    if (found.status === "not_registered") {
      if (!confirm(`同梱の「${found.entry.name}」をこの端末に登録し、標準テンプレートにします。\n\n標準にすると、これから作成する現場はこの様式を使います（元請名と同じ会社の様式よりも優先されます）。既に作成した現場は、それぞれ作成時に固定した様式・版のまま変わりません。よろしいですか？`)) return;
      await installBundledTemplate(found.entry, { asStandard: true });
      showMessage("同梱の標準テンプレートを登録しました。");
    } else if (found.status === "update_available") {
      const prepared = await prepareBundledUpdate(found.entry);
      if (prepared.errors.length > 0) {
        showMessage(`更新できません: ${prepared.errors[0]}`, true);
        return;
      }
      const warn = prepared.warnings.length ? `\n\n確認してください:\n・${prepared.warnings.join("\n・")}` : "";
      if (!confirm(`同梱の新しい版へ更新します（今の版は前の版として残り、いつでも戻せます）。既に作成した現場は、それぞれ固定した版のまま変わりません（現場ごとに現場詳細から切り替えられます）。これから作成する現場は新しい版を使います。${warn}\n\n更新しますか？`)) return;
      await applyBundledUpdate(found.entry, prepared);
      showMessage("同梱の新しい版へ更新しました。");
    }
  } catch (err) {
    showMessage(`処理できませんでした: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
  await renderList();
});

async function renderList() {
  await normalizeAppDefaultReportTemplate();
  await renderBundledSection();
  const [templates, companies] = await Promise.all([listReportTemplates({ templateKind: "report" }), listCompanyProfiles()]);
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const standard = templates.find((t) => t.isAppDefault);
  standardSummaryEl.textContent = standard
    ? `標準テンプレート: 「${standard.name}」（第${standard.revision || 1}版・${standard.sourceFileName || "ファイル名不明"}）。これから作成する現場はこの様式・この版で出力します（既存の現場は作成時に固定した版のまま）。`
    : "標準テンプレートは未設定です（Excelテンプレートを登録し「標準にする」を押してください。未設定の間は、従来どおり元請名と同じ会社の様式を使います）。";

  templates.sort((a, b) => (companyNameById.get(a.companyProfileId) || "").localeCompare(companyNameById.get(b.companyProfileId) || "", "ja") || a.name.localeCompare(b.name, "ja"));

  listEl.innerHTML = "";
  emptyEl.style.display = templates.length === 0 ? "block" : "none";

  const usage = new Map();
  for (const tpl of templates) usage.set(tpl.id, (await listSitesPinnedToVersion(tpl.id, null)).length);

  templates.forEach((tpl) => {
    const li = document.createElement("li");
    li.className = "report-template-item";
    li.dataset.templateId = tpl.id;
    li.innerHTML = `
      <div class="report-template-info">
        <p class="report-template-name">${escapeHtml(tpl.name)}${tpl.isAppDefault ? ` <span class="status-badge status-default">標準</span>` : ""}${tpl.isDefault ? ` <span class="status-badge">会社の既定</span>` : ""}</p>
        <p class="report-template-meta">${escapeHtml(companyNameById.get(tpl.companyProfileId) || "会社未設定")}
          <span class="status-badge">${escapeHtml(FORMAT_LABEL[tpl.format] || tpl.format)}</span>
        </p>
        <p class="report-template-meta">第${tpl.revision || 1}版${tpl.replacedAt ? `（差し替え ${formatDate(tpl.replacedAt)}）` : ""} / 登録日: ${formatDate(tpl.createdAt)}${tpl.sourceFileName ? ` / ${escapeHtml(tpl.sourceFileName)}` : ""}${tpl.layoutId ? ` / 様式: ${escapeHtml(getLayoutProfile(tpl.layoutId)?.label || tpl.layoutId)}` : ""}</p>
        <p class="report-template-meta">使用中の現場: ${usage.get(tpl.id) || 0}件（どの版かは「前の版」で確認できます）</p>
        <div class="report-template-versions" hidden></div>
      </div>
      <div class="report-template-actions">
        ${tpl.format === "excel" ? (tpl.isAppDefault ? `<button type="button" class="secondary-btn clearStandardTemplateBtn">標準を解除</button>` : `<button type="button" class="secondary-btn setStandardTemplateBtn">標準にする</button>`) : ""}
        ${tpl.isDefault || !tpl.companyProfileId ? "" : `<button type="button" class="secondary-btn setDefaultReportTemplateBtn">会社の既定に設定</button>`}
        <button type="button" class="secondary-btn showTemplateVersionsBtn">前の版</button>
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
  editingExistingBlob = null;
  fileCheck = null;
  inspectListEl.innerHTML = "";
  form.reset();
  fileRequiredMark.style.display = "inline";
  fileInfoEl.textContent = "";
}

async function openCreateDialog() {
  resetForm();
  formTitle.textContent = "テンプレートを追加";
  await populateCompanySelect();
  asStandardInput.checked = !(await getAppDefaultReportTemplate()); // 標準が未設定なら、最初の1件を標準にする
  dialog.showModal();
}

async function openEditDialog(tpl) {
  resetForm();
  editingId = tpl.id;
  editingExistingFile = { name: tpl.sourceFileName, mimeType: tpl.sourceFileMimeType, layoutId: tpl.layoutId || null };
  editingExistingBlob = tpl.sourceFileBlob || null;
  asStandardInput.checked = !!tpl.isAppDefault;
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

/** 選択したファイルを検査し（様式の種類・台帳シート・前の版との違い）、結果を画面に出す */
async function checkSelectedFile(file, format) {
  const items = [];
  const result = { inspect: null, compare: null, errors: [], warnings: [] };
  if (format === "excel") {
    const buffer = await file.arrayBuffer();
    result.inspect = await inspectTemplate(buffer);
    result.errors.push(...result.inspect.errors);
    result.warnings.push(...result.inspect.warnings);
    if (result.inspect.layoutLabel) items.push({ kind: "ok", text: `様式の種類: ${result.inspect.layoutLabel}${result.inspect.hasLedger ? `（台帳シートあり: 最大${result.inspect.ledger.days}日分。超えると自動で追加します）` : ""}` });
    if (editingId && editingExistingBlob && result.inspect.layoutId) {
      result.compare = await compareTemplateVersions(await editingExistingBlob.arrayBuffer(), buffer, result.inspect.layoutId);
      result.errors.push(...result.compare.errors);
      result.warnings.push(...result.compare.warnings);
      for (const d of result.compare.diffs.slice(0, 8)) items.push({ kind: "diff", text: `${d.cell}: 「${d.before || "（空）"}」→「${d.after || "（空）"}」` });
      if (result.compare.diffs.length > 8) items.push({ kind: "diff", text: `…ほか${result.compare.diffs.length - 8}か所` });
    }
  }
  for (const e of result.errors) items.unshift({ kind: "error", text: e });
  for (const w of result.warnings) items.push({ kind: "warn", text: w });
  inspectListEl.innerHTML = items.map((i) => `<li class="template-inspect-${i.kind}">${escapeHtml(i.text)}</li>`).join("");
  return result;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileCheck = null;
  inspectListEl.innerHTML = "";
  if (!file) {
    fileInfoEl.textContent = editingExistingFile?.name ? `現在のファイル: ${editingExistingFile.name}（変更する場合のみ選択してください）` : "";
    return;
  }
  const format = detectFormatFromFile(file);
  fileInfoEl.textContent = format
    ? `選択中: ${file.name}（${FORMAT_LABEL[format]}として登録されます）`
    : `選択中: ${file.name}（.xlsxまたは.pdfのみ登録できます）`;
  if (format) fileCheck = await checkSelectedFile(file, format);
});

async function toggleVersions(li, templateId) {
  const box = li.querySelector(".report-template-versions");
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const versions = await listTemplateVersions(templateId);
  const counts = new Map();
  for (const v of versions) counts.set(v.id, (await listSitesPinnedToVersion(templateId, v.sourceFileSha256)).length);
  box.innerHTML = versions.length === 0
    ? `<p class="report-template-meta">前の版はありません（ファイルを差し替えると、前の版がここに残ります）。</p>`
    : versions.map((v) => `<p class="report-template-meta" data-archive-id="${escapeHtml(v.id)}" data-revision="${v.revision || 1}">第${v.revision || 1}版 / ${escapeHtml(v.sourceFileName || "")} / 差し替え前に保存 ${formatDate(v.archivedAt)} / この版を使用中の現場: ${counts.get(v.id) || 0}件 <button type="button" class="secondary-btn restoreTemplateVersionBtn">この版に戻す</button></p>`).join("");
  box.hidden = false;
}

listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".report-template-item");
  if (!li) return;
  const templateId = li.dataset.templateId;

  if (e.target.closest(".editReportTemplateBtn")) {
    const templates = await listReportTemplates({ templateKind: "report" });
    const tpl = templates.find((t) => t.id === templateId);
    if (tpl) await openEditDialog(tpl);
    return;
  }

  if (e.target.closest(".setStandardTemplateBtn")) {
    await setAppDefaultReportTemplate(templateId);
    showMessage("標準テンプレートに設定しました。標準に従う現場はこの様式で出力します。");
    await renderList();
    return;
  }

  if (e.target.closest(".clearStandardTemplateBtn")) {
    if (!confirm("標準テンプレートの設定を解除しますか？（標準が無い間は、元請名と同じ会社の様式、無ければ汎用フォーマットで出力します）")) return;
    await clearAppDefaultReportTemplate();
    showMessage("標準テンプレートを解除しました。");
    await renderList();
    return;
  }

  if (e.target.closest(".showTemplateVersionsBtn")) {
    await toggleVersions(li, templateId);
    return;
  }

  if (e.target.closest(".restoreTemplateVersionBtn")) {
    const archiveId = e.target.closest("[data-archive-id]").dataset.archiveId;
    const rev = e.target.closest("[data-archive-id]").dataset.revision;
    if (!confirm(`第${rev}版の内容に戻しますか？（今の版も前の版として残るので、あとで元に戻せます）`)) return;
    await restoreReportTemplateVersion(templateId, archiveId);
    showMessage(`第${rev}版の内容に戻しました。`);
    await renderList();
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
    const isStandard = !!li.querySelector(".status-default");
    if (!confirm(`「${nameEl.textContent}」を削除しますか？${isStandard ? "\n\n標準テンプレートです。削除すると標準が未設定になります。" : ""}`)) return;
    try {
      await deleteReportTemplate(templateId);
    } catch (err) {
      showMessage(err.message, true);
      return;
    }
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

  const file = fileInput.files[0];
  if (!file && !editingId) {
    showMessage("ファイル（.xlsxまたは.pdf）を選択してください。", true);
    return;
  }

  let format, rendererId;
  if (file) {
    format = detectFormatFromFile(file);
    if (!format) {
      showMessage("対応していないファイル形式です。.xlsxまたは.pdfを選択してください。", true);
      return;
    }
    rendererId = DEFAULT_RENDERER_ID_BY_FORMAT[format] ?? null;
    // 検査がまだ終わっていなければ待つ（ファイル選択直後に保存した場合）
    if (!fileCheck) fileCheck = await checkSelectedFile(file, format);
    if (fileCheck.errors.length > 0) {
      showMessage(`このファイルは登録できません: ${fileCheck.errors[0]}`, true);
      return;
    }
    // 前の版と様式の固定文言が違う等の警告は、確認してから差し替える（勝手に進めない）
    if (fileCheck.warnings.length > 0 && !confirm(`確認してください:\n\n・${fileCheck.warnings.join("\n・")}\n\nこのまま${editingId ? "差し替え" : "登録"}しますか？`)) return;
  }

  let companyProfileId = companySelect.value || null;
  if (companyProfileId === "__new__") {
    const newName = newCompanyNameInput.value.trim();
    if (!newName) {
      showMessage("新しい会社名を入力してください。", true);
      return;
    }
    const company = await createCompanyProfile({ name: newName });
    companyProfileId = company.id;
  }

  const layoutId = fileCheck?.inspect?.layoutId ?? null;
  const wantsStandard = asStandardInput.checked;
  let savedId = editingId;
  let message;

  try {
  if (editingId) {
    if (file) {
      // 差し替え: 今の版を前の版として退避してから、新しいファイルへ（idは変わらない）
      const updated = await replaceReportTemplateFile(editingId, { blob: file, fileName: file.name, mimeType: file.type, layoutId });
      if (rendererId) await updateReportTemplate(editingId, { rendererId });
      await updateReportTemplate(editingId, { name, companyProfileId });
      message = `テンプレートを第${updated.revision}版へ差し替えました（前の版は「前の版」から戻せます）。`;
    } else {
      await updateReportTemplate(editingId, { name, companyProfileId });
      message = "テンプレートを更新しました。";
    }
  } else {
    const created = await createReportTemplate({
      companyProfileId, format, name, sourceFileBlob: file, sourceFileName: file.name, sourceFileMimeType: file.type, rendererId,
      layoutId, sourceFileSha256: await sha256OfBlob(file)
    });
    savedId = created.id;
    message = "テンプレートを追加しました。";
  }

  const current = await listReportTemplates({ templateKind: "report" }).then((all) => all.find((t) => t.id === savedId));
  if (current?.format === "excel") {
    if (wantsStandard && !current.isAppDefault) {
      await setAppDefaultReportTemplate(savedId);
      message += " 標準テンプレートに設定しました。";
    } else if (!wantsStandard && current.isAppDefault) {
      await clearAppDefaultReportTemplate();
      message += " 標準テンプレートの設定を解除しました。";
    }
  }
  showMessage(message);
  } catch (err) {
    // 例: 現在と同じ内容のファイルへの差し替え。理由を表示し、入力内容は残したままにする
    showMessage(`保存できませんでした: ${err.message}`, true);
    return;
  }

  dialog.close();
  await renderList();
});

export async function initReportTemplateListView() {
  showView("view-report-templates");
  await renderList();
}
