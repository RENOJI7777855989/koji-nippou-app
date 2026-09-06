/* ==========================================================
   見積書帳票出力オーケストレーター
   js/report-output/generateReportOutput.jsと対になる存在。
   比較・許容差設定・マスター解決は行わない（呼び出し側の比較画面が
   既に計算済みのestimateItems/vendorItems/resultsをそのまま渡す
   前提）。会社指定の見積テンプレートが未登録の場合は、組み込みの
   CSVフォールバックへ自動的に切り替える（会社様式整備前でも動作
   確認できるようにする、既存のreport-output側と同じ考え方）。

   実際の会社指定見積書Excelは実ファイル未受領のため、このモジュール
   は基盤（アダプター・セルプラン・CSVフォールバック・オーケスト
   レーター）のみを提供する。実ファイル受領後は
   js/report-output/renderers/excelXlsxTemplate.jsと同じ技法で
   本実装のレンダラー・実マッピングを追加する。
   ========================================================== */

import "./renderers/quoteCsvDefault.js";
import { buildQuoteOutputModel } from "./quoteDataAdapter.js";
import { getReportTemplate, getDefaultTemplateForCompany } from "../report-output/reportTemplates.js";
import { getExcelRenderer } from "../report-output/rendererRegistry.js";
import { DEFAULT_QUOTE_MAPPING } from "./renderers/quoteCsvDefault.js";

const FALLBACK_TEMPLATE = { rendererId: "quote-default-csv", mapping: DEFAULT_QUOTE_MAPPING };

async function resolveTemplate({ companyProfileId, templateId }) {
  if (templateId) {
    const template = await getReportTemplate(templateId);
    if (!template) throw new Error("見積書テンプレートが見つかりません");
    return template;
  }
  if (companyProfileId) {
    const template = await getDefaultTemplateForCompany(companyProfileId, "excel", "quote");
    if (template) return template;
  }
  return FALLBACK_TEMPLATE;
}

/**
 * @param {object} params.site js/sites.jsのレコード
 * @param {object} params.vendorBatch js/vendorQuote/vendorQuoteBatches.jsのレコード
 * @param {object[]} params.estimateItems 現場の積算項目全件
 * @param {object[]} params.vendorItems 業者見積バッチの全項目
 * @param {object[]} params.results compareEstimateToQuote()の戻り値（呼び出し側で計算済み）
 * @param {string} [params.companyProfileId] 指定した会社プロファイルの既定見積テンプレートを使う
 * @param {string} [params.templateId] テンプレートを直接指定する（companyProfileIdより優先）
 */
export async function generateQuoteOutput({ site, vendorBatch, estimateItems = [], vendorItems = [], results = [], companyProfileId, templateId }) {
  const template = await resolveTemplate({ companyProfileId, templateId });
  const model = buildQuoteOutputModel({ site, vendorBatch, estimateItems, vendorItems, results });
  const renderer = getExcelRenderer(template.rendererId);
  return renderer(model, template.mapping, null, template);
}
