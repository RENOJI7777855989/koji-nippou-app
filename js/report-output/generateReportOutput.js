/* ==========================================================
   帳票出力オーケストレーター（将来のUI層がここだけを呼ぶ）
   日報データ層（sites.js/reports.js/photos.js/signatures.js）→
   アダプター（reportDataAdapter.js）→ テンプレート解決 →
   レンダラー実行、という一連の流れをまとめる。
   会社様式が未登録の場合は組み込みの汎用テンプレートにフォール
   バックするため、テンプレート未整備の段階でも動作確認できる。
   ========================================================== */

import "./renderers/index.js";
import { getSite } from "../sites.js";
import { getReport } from "../reports.js";
import { listPhotosByReport } from "../photos.js";
import { listSignaturesByReport } from "../signatures.js";
import { getCompanyProfile } from "./companyProfiles.js";
import { getReportTemplate, getDefaultTemplateForCompany } from "./reportTemplates.js";
import { buildReportOutputModel } from "./reportDataAdapter.js";
import { getExcelRenderer, getPdfRenderer } from "./rendererRegistry.js";
import { DEFAULT_EXCEL_MAPPING } from "./renderers/excelDefault.js";
import { DEFAULT_PDF_MAPPING } from "./renderers/pdfDefault.js";

const FALLBACK_TEMPLATE = {
  excel: { rendererId: "default-csv", mapping: DEFAULT_EXCEL_MAPPING },
  pdf: { rendererId: "default-print-html", mapping: DEFAULT_PDF_MAPPING }
};

async function resolveTemplate({ format, companyProfileId, templateId }) {
  if (templateId) {
    const template = await getReportTemplate(templateId);
    if (!template) throw new Error("帳票テンプレートが見つかりません");
    return template;
  }
  if (companyProfileId) {
    const template = await getDefaultTemplateForCompany(companyProfileId, format);
    if (template) return template;
  }
  return FALLBACK_TEMPLATE[format];
}

/**
 * @param {Object} params
 * @param {string} params.reportId
 * @param {"excel"|"pdf"} params.format
 * @param {string} [params.companyProfileId] 指定した会社プロファイルの既定テンプレートを使う
 * @param {string} [params.templateId] テンプレートを直接指定する（companyProfileIdより優先）
 * @param {"company"|"original"} [params.pdfVariant] format="pdf"の場合のみ有効。
 *   "company"＝会社指定Excel様式をレイアウトそのままPDF化（Excelテンプレートを流用）。
 *   "original"（既定）＝アプリ独自の見やすいレイアウトのPDF。
 */
export async function generateReportOutput({ reportId, format, companyProfileId, templateId, pdfVariant = "original" }) {
  if (format !== "excel" && format !== "pdf") throw new Error(`未対応の出力形式です: ${format}`);
  const isCompanyPdf = format === "pdf" && pdfVariant === "company";

  const report = await getReport(reportId);
  if (!report) throw new Error("日報が見つかりません");

  // 会社指定PDFは、Excel出力と同じ「excel」形式のテンプレート（.xlsx原本）をそのまま流用する
  // （同じファイルをPDF用に別途登録し直す必要をなくすため）。
  const lookupFormat = isCompanyPdf ? "excel" : format;

  const [site, photos, signatures, companyProfile, template] = await Promise.all([
    getSite(report.siteId),
    listPhotosByReport(reportId),
    listSignaturesByReport(reportId),
    companyProfileId ? getCompanyProfile(companyProfileId) : Promise.resolve(null),
    resolveTemplate({ format: lookupFormat, companyProfileId, templateId })
  ]);

  const model = buildReportOutputModel({ site, report, photos, signatures, companyProfile });

  if (format === "excel") {
    const renderer = getExcelRenderer(template.rendererId);
    return renderer(model, template.mapping, companyProfile, template);
  }
  const rendererId = isCompanyPdf ? "xlsx-template-print-html" : template.rendererId;
  const renderer = getPdfRenderer(rendererId);
  return renderer(model, template.mapping, companyProfile, template);
}
