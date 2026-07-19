/* ==========================================================
   帳票テンプレート定義のデータ層
   1レコード = 「どの会社プロファイル向けに」「どの形式(excel/pdf)を」
   「どのレンダラー(rendererId)で」「どんなマッピングで」出力するか、
   を表す。マッピングをデータとして持たせることで、セル対応や
   レイアウト項目を後から画面（将来実装）経由で変更できる。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";

export async function listReportTemplates({ companyProfileId, format } = {}) {
  let all;
  if (companyProfileId) {
    all = await dbGetAll("reportTemplates", "by_companyProfileId", companyProfileId);
  } else if (format) {
    all = await dbGetAll("reportTemplates", "by_format", format);
  } else {
    all = await dbGetAll("reportTemplates");
  }
  return all.filter((t) => !t.isDeleted && (!format || t.format === format));
}

export async function getReportTemplate(id) {
  return dbGet("reportTemplates", id);
}

export async function createReportTemplate({
  companyProfileId = null,
  format,
  name,
  rendererId = null,
  mapping = null,
  isDefault = false,
  sourceFileBlob = null,
  sourceFileName = "",
  sourceFileMimeType = ""
}) {
  if (format !== "excel" && format !== "pdf") throw new Error(`未対応の出力形式です: ${format}`);
  // 同じ会社・同じ形式のテンプレートがまだ無ければ、1件目を自動的に既定にする
  const siblings = companyProfileId ? await listReportTemplates({ companyProfileId, format }) : [];
  const template = stampNew({
    companyProfileId,
    format,
    name,
    rendererId,
    mapping,
    isDefault: isDefault || siblings.length === 0,
    // アップロードされたExcel/PDFファイルの実体。データ差し込み(mapping)は将来対応。
    sourceFileBlob,
    sourceFileName,
    sourceFileMimeType
  });
  await dbPut("reportTemplates", template);
  await recordChange({ entityType: "reportTemplate", entityId: template.id, action: "create", summary: `帳票テンプレート「${template.name}」を作成` });
  return template;
}

export async function updateReportTemplate(id, patch) {
  const existing = await dbGet("reportTemplates", id);
  if (!existing) throw new Error("帳票テンプレートが見つかりません");
  const updated = stampUpdate(existing, patch);
  await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: id, action: "update", summary: `帳票テンプレート「${updated.name}」を更新` });
  return updated;
}

export async function deleteReportTemplate(id) {
  return updateReportTemplate(id, { isDeleted: true });
}

/** 会社プロファイルに紐づく既定テンプレートを1件返す（isDefault優先、なければ先頭）。 */
export async function getDefaultTemplateForCompany(companyProfileId, format) {
  const candidates = await listReportTemplates({ companyProfileId, format });
  return candidates.find((t) => t.isDefault) || candidates[0] || null;
}

/** 指定テンプレートを、同じ会社・同じ形式の中で唯一の既定テンプレートにする。 */
export async function setDefaultReportTemplate(id) {
  const target = await dbGet("reportTemplates", id);
  if (!target) throw new Error("帳票テンプレートが見つかりません");

  const siblings = await listReportTemplates({ companyProfileId: target.companyProfileId, format: target.format });
  for (const sibling of siblings) {
    if (sibling.id !== id && sibling.isDefault) {
      await dbPut("reportTemplates", stampUpdate(sibling, { isDefault: false }));
    }
  }

  const updated = stampUpdate(target, { isDefault: true });
  await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: id, action: "update", summary: `帳票テンプレート「${updated.name}」を既定に設定` });
  return updated;
}
