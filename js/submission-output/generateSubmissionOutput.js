/* ==========================================================
   提出金額内訳書の出力オーケストレーター（唯一の公開入口）
   流れ: 積算（estimateItems）→ 区分割当 → 階層モデル → 小計・合計
        → 頁生成 → 会社様式テンプレートの複製へ書き込み → .xlsx
   業者見積を直接使わない（共通データ＝積算項目のみ）。会社様式テンプレートは
   js/report-output/reportTemplates.js のtemplateKind="submission"で管理し、
   レンダラーは他の帳票と同じrendererRegistryに登録する。
   ========================================================== */

import { getSite } from "../sites.js";
import { listEstimateItemsBySite } from "../estimate/estimateItems.js";
import { getSubmissionPlan } from "../submission/submissionPlans.js";
import { listSubmissionAssignments } from "../submission/submissionAssignments.js";
import { getReportTemplate, createReportTemplate } from "../report-output/reportTemplates.js";
import { registerExcelRenderer, getExcelRenderer } from "../report-output/rendererRegistry.js";
import { buildSubmissionModel } from "./submissionModel.js";
import { buildSubmissionPages } from "./pageBuilder.js";
import { analyzeSubmissionTemplateFile, renderSubmissionWorkbook } from "./renderSubmissionWorkbook.js";

export const SUBMISSION_RENDERER_ID = "submission-breakdown-xlsx";

registerExcelRenderer(SUBMISSION_RENDERER_ID, async (input, mapping, _companyProfile, template) => {
  if (!template?.sourceFileBlob) throw new Error("会社様式のExcelファイルが登録されていません");
  const templateBuffer = await template.sourceFileBlob.arrayBuffer();
  const result = await renderSubmissionWorkbook({
    templateBuffer,
    profile: mapping,
    model: input.model,
    projectTitle: input.projectTitle,
    companyName: input.companyName,
    printMode: input.printMode
  });
  return { blob: result.blob, filename: input.filename, meta: result };
});

function safeFileName(text) {
  return String(text || "提出金額内訳書").replace(/[\\/:*?"<>|\r\n]/g, "_");
}

/** 会社様式.xlsxを解析し、成功すれば提出内訳書テンプレートとして登録する */
export async function registerSubmissionTemplate({ file, name }) {
  const buffer = await file.arrayBuffer();
  const { profile, errors, warnings } = await analyzeSubmissionTemplateFile(buffer);
  if (!profile) return { ok: false, errors, warnings };
  const template = await createReportTemplate({
    companyProfileId: null,
    format: "excel",
    name: name || file.name,
    rendererId: SUBMISSION_RENDERER_ID,
    mapping: profile,
    sourceFileBlob: file,
    sourceFileName: file.name,
    sourceFileMimeType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    templateKind: "submission"
  });
  return { ok: true, template, profile, warnings };
}

/** 出力前の確認用: モデル・頁数・警告をまとめて返す（ファイルは作らない） */
export async function previewSubmissionOutput({ siteId, templateId }) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  const plan = await getSubmissionPlan(siteId);
  const items = await listEstimateItemsBySite(siteId);
  const assignments = await listSubmissionAssignments(siteId);
  const model = buildSubmissionModel({ items, assignments, groups: plan?.groups || [], allowUnassigned: !!plan?.allowUnassigned });
  let pageInfo = null;
  const template = templateId || plan?.templateId ? await getReportTemplate(templateId || plan.templateId) : null;
  if (template && template.templateKind === "submission" && template.mapping && model.errors.length === 0) {
    try {
      const built = buildSubmissionPages(model, template.mapping);
      // 1頁に収まらず継続頁になるスケジュール（工種・種別など）の一覧。黙って分割せず、画面で警告するために返す
      const continued = new Map();
      for (const page of built.pages) {
        const entry = continued.get(page.scheduleIndex) || { pages: 0, hasContinuation: false, name: [page.crumb?.symbol, page.crumb?.name, page.crumb?.spec].filter(Boolean).join(" ") || "表紙" };
        entry.pages++;
        if (page.continuation) entry.hasContinuation = true;
        continued.set(page.scheduleIndex, entry);
      }
      pageInfo = {
        pageCount: built.pages.length,
        scheduleCount: built.scheduleCount,
        continuationPageCount: built.continuationPageCount,
        continuedSchedules: [...continued.values()].filter((e) => e.hasContinuation).map((e) => ({ name: e.name, pages: e.pages }))
      };
    } catch (err) {
      model.errors.push({ code: "pagination", message: err.message });
    }
  }
  return { site, plan, template, model, pageInfo };
}

/**
 * @param {object} params
 * @param {string} params.siteId
 * @param {string} [params.templateId] 省略時は出力設定(plan.templateId)
 * @returns {Promise<{ blob: Blob, filename: string, meta: object, model: object }>}
 * @throws 出力を止めるべきエラー（区分未割当・種別混在等）がある場合はErrorを投げる（error.details=[...]）
 */
export async function generateSubmissionOutput({ siteId, templateId }) {
  const { site, plan, template, model } = await previewSubmissionOutput({ siteId, templateId });
  if (!template || template.templateKind !== "submission") throw new Error("会社様式（提出内訳書テンプレート）が選択されていません");
  if (model.errors.length > 0) {
    const error = new Error(`出力できません: ${model.errors.map((e) => e.message).join(" / ")}`);
    error.details = model.errors;
    throw error;
  }
  const projectTitle = (plan?.projectTitle || "").trim() || site.name;
  const companyName = (plan?.companyNameOverride || "").trim() || undefined;
  const renderer = getExcelRenderer(template.rendererId);
  const output = await renderer(
    { model, projectTitle, companyName, printMode: plan?.printMode || "original", filename: `${safeFileName(projectTitle)}_提出金額内訳書.xlsx` },
    template.mapping,
    null,
    template
  );
  return { ...output, model };
}
