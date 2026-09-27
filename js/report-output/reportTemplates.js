/* ==========================================================
   帳票テンプレート定義のデータ層
   1レコード = 「どの会社プロファイル向けに」「どの形式(excel/pdf)を」
   「どのレンダラー(rendererId)で」「どんなマッピングで」出力するか、
   を表す。マッピングをデータとして持たせることで、セル対応や
   レイアウト項目を後から画面（将来実装）経由で変更できる。

   templateKind（"report"|"quote"）で、日報用テンプレートと見積書用
   テンプレートを同じストア・同じCRUD関数で管理する（新規ストアを
   増やさない）。既存レコードにはtemplateKindが無いため、未設定は
   "report"として扱う（後方互換。既存の日報帳票機能への影響なし）。

   標準テンプレート・版管理（すべて任意の追加フィールド。DBスキーマ変更なし）:
     isAppDefault … アプリ全体の標準テンプレート（日報用Excelで1件だけ）。
                    現場で別の様式を指定していなければ、この様式で出力する。
     layoutId … どの様式か（layoutProfiles.jsのid）。様式固有のマッピングはここから引く。
     revision / sourceFileSha256 / replacedAt … 差し替えの版番号と、現在のファイルの指紋。
     過去の版は templateKind:"report_archive"・archivedOf:元のid の別レコードに退避する
     （一覧・出力の候補には出ない。Blobを最上位フィールドに持つのでバックアップにも含まれる）。
     テンプレートのidは差し替えても変わらないため、それを参照する現場は新しい版に追従する。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";

export async function listReportTemplates({ companyProfileId, format, templateKind } = {}) {
  let all;
  if (companyProfileId) {
    all = await dbGetAll("reportTemplates", "by_companyProfileId", companyProfileId);
  } else if (format) {
    all = await dbGetAll("reportTemplates", "by_format", format);
  } else {
    all = await dbGetAll("reportTemplates");
  }
  return all.filter(
    (t) => !t.isDeleted && (!format || t.format === format) && (!templateKind || (t.templateKind || "report") === templateKind)
  );
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
  sourceFileMimeType = "",
  templateKind = "report",
  layoutId = null,
  isAppDefault = false,
  sourceFileSha256 = "",
  id = null,
  bundledId = null,
  bundledSha256 = "",
  bundledVersion = null
}) {
  if (format !== "excel" && format !== "pdf") throw new Error(`未対応の出力形式です: ${format}`);
  // 同じ会社・同じ形式・同じ種別(report/quote)のテンプレートがまだ無ければ、
  // 1件目を自動的に既定にする
  const siblings = companyProfileId ? await listReportTemplates({ companyProfileId, format, templateKind }) : [];
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
    sourceFileMimeType,
    templateKind,
    layoutId,
    isAppDefault: false,
    sourceFileSha256,
    revision: 1,
    ...(bundledId ? { bundledId, bundledSha256, bundledVersion } : {})
  });
  if (id) template.id = id; // アプリ同梱の様式は固定id（二重登録を防ぐ）
  await dbPut("reportTemplates", template);
  if (isAppDefault) return setAppDefaultReportTemplate(template.id);
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

/** 現場が固定している（または元に戻す用に記録している）版の一覧: [{templateId, sha256, siteName}] */
async function pinsInUse() {
  const sites = (await dbGetAll("sites")).filter((s) => !s.isDeleted);
  const out = [];
  for (const site of sites) {
    for (const p of [site.templatePin, ...(site.templatePinHistory || [])]) {
      if (p?.templateId) out.push({ templateId: p.templateId, sha256: p.sha256, siteName: site.name, current: p === site.templatePin });
    }
  }
  return out;
}

/**
 * テンプレートを削除する。現場で使用中（どの版であれ固定している、または元に戻す用に
 * 記録している）のテンプレートは削除できない。
 */
export async function deleteReportTemplate(id) {
  const inUse = (await pinsInUse()).filter((p) => p.templateId === id);
  if (inUse.length > 0) {
    const names = [...new Set(inUse.map((p) => p.siteName))];
    throw new Error(`このテンプレートは現場で使用中のため削除できません（${names.length}現場: ${names.slice(0, 5).join("、")}${names.length > 5 ? " ほか" : ""}）。現場の様式を別のテンプレートへ切り替えてから削除してください。`);
  }
  return updateReportTemplate(id, { isDeleted: true });
}

/** 会社プロファイルに紐づく既定テンプレートを1件返す（isDefault優先、なければ先頭）。 */
export async function getDefaultTemplateForCompany(companyProfileId, format, templateKind = "report") {
  const candidates = await listReportTemplates({ companyProfileId, format, templateKind });
  return candidates.find((t) => t.isDefault) || candidates[0] || null;
}

/** 指定テンプレートを、同じ会社・同じ形式・同じ種別の中で唯一の既定テンプレートにする。 */
export async function setDefaultReportTemplate(id) {
  const target = await dbGet("reportTemplates", id);
  if (!target) throw new Error("帳票テンプレートが見つかりません");

  const siblings = await listReportTemplates({
    companyProfileId: target.companyProfileId,
    format: target.format,
    templateKind: target.templateKind || "report"
  });
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

/* ---------- 標準テンプレート（アプリ全体） ---------- */

/** 日報用Excelの標準テンプレートを返す（無ければnull）。 */
export async function getAppDefaultReportTemplate() {
  const all = (await listReportTemplates({ format: "excel", templateKind: "report" })).filter((t) => t.isAppDefault);
  // 標準が複数ある場合（バックアップの復元でマージされた等）は、最後に更新されたものを標準とみなす
  all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return all[0] || null;
}

/** 指定テンプレートを、日報用Excelの唯一の標準テンプレートにする。 */
export async function setAppDefaultReportTemplate(id) {
  const target = await dbGet("reportTemplates", id);
  if (!target || target.isDeleted) throw new Error("帳票テンプレートが見つかりません");
  if ((target.templateKind || "report") !== "report" || target.format !== "excel") {
    throw new Error("標準にできるのは、日報用のExcelテンプレートだけです");
  }
  for (const t of await listReportTemplates({ format: "excel", templateKind: "report" })) {
    if (t.id !== id && t.isAppDefault) await dbPut("reportTemplates", stampUpdate(t, { isAppDefault: false }));
  }
  const updated = target.isAppDefault ? target : stampUpdate(target, { isAppDefault: true });
  if (updated !== target) await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: id, action: "update", summary: `帳票テンプレート「${updated.name}」を標準テンプレートに設定` });
  return updated;
}

/** 標準が2件以上あれば、最新の1件だけを残して古い方の標準フラグを外す。 */
export async function normalizeAppDefaultReportTemplate() {
  const flagged = (await listReportTemplates({ format: "excel", templateKind: "report" })).filter((t) => t.isAppDefault);
  if (flagged.length <= 1) return;
  const keep = await getAppDefaultReportTemplate();
  for (const t of flagged) if (t.id !== keep.id) await dbPut("reportTemplates", stampUpdate(t, { isAppDefault: false }));
}

export async function clearAppDefaultReportTemplate() {
  const current = await getAppDefaultReportTemplate();
  if (!current) return null;
  const updated = stampUpdate(current, { isAppDefault: false });
  await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: current.id, action: "update", summary: `帳票テンプレート「${current.name}」の標準設定を解除` });
  return updated;
}

/* ---------- 版管理（差し替え・以前の版に戻す） ---------- */

const MAX_ARCHIVED_VERSIONS = 10;

export async function sha256OfBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** テンプレートの過去の版（新しい順）。 */
export async function listTemplateVersions(templateId) {
  const all = await dbGetAll("reportTemplates");
  return all
    .filter((t) => !t.isDeleted && t.templateKind === "report_archive" && t.archivedOf === templateId)
    .sort((a, b) => (b.revision || 0) - (a.revision || 0));
}

async function archiveCurrentVersion(current) {
  const archived = stampNew({
    companyProfileId: current.companyProfileId,
    format: current.format,
    name: current.name,
    rendererId: current.rendererId,
    mapping: current.mapping,
    isDefault: false,
    isAppDefault: false,
    sourceFileBlob: current.sourceFileBlob,
    sourceFileName: current.sourceFileName,
    sourceFileMimeType: current.sourceFileMimeType,
    sourceFileSha256: current.sourceFileSha256 || (current.sourceFileBlob ? await sha256OfBlob(current.sourceFileBlob) : ""),
    layoutId: current.layoutId || null,
    templateKind: "report_archive",
    archivedOf: current.id,
    revision: current.revision || 1,
    archivedAt: new Date().toISOString()
  });
  await dbPut("reportTemplates", archived);
  // 古い版は上限を超えた分だけ論理削除する。ただし現場で使用中の版は上限に関係なく残す
  const inUse = new Set((await pinsInUse()).filter((p) => p.templateId === current.id).map((p) => p.sha256));
  const versions = await listTemplateVersions(current.id);
  const removable = versions.filter((v) => !inUse.has(v.sourceFileSha256));
  for (const old of removable.slice(MAX_ARCHIVED_VERSIONS)) await dbPut("reportTemplates", stampUpdate(old, { isDeleted: true }));
  return archived;
}

/**
 * テンプレートのファイルを新しい版へ差し替える。現在の版は退避してから上書きする
 * （テンプレートのid・標準の設定・現場からの参照はそのまま。原本ファイルそのものは
 * 利用者のPCにあるまま、アプリには複製を保存している）。
 */
export async function replaceReportTemplateFile(id, { blob, fileName, mimeType, layoutId = undefined }) {
  const current = await dbGet("reportTemplates", id);
  if (!current || current.isDeleted) throw new Error("帳票テンプレートが見つかりません");
  const sha = await sha256OfBlob(blob);
  if (current.sourceFileBlob && current.sourceFileSha256 && current.sourceFileSha256 === sha) {
    throw new Error("現在登録されているファイルと同じ内容です（差し替えの必要はありません）");
  }
  if (current.sourceFileBlob) await archiveCurrentVersion(current);
  const updated = stampUpdate(current, {
    sourceFileBlob: blob,
    sourceFileName: fileName,
    sourceFileMimeType: mimeType || current.sourceFileMimeType || "",
    sourceFileSha256: sha,
    revision: (current.revision || 1) + 1,
    replacedAt: new Date().toISOString(),
    ...(layoutId !== undefined ? { layoutId } : {})
  });
  await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: id, action: "update", summary: `帳票テンプレート「${updated.name}」のファイルを第${updated.revision}版へ差し替え` });
  return updated;
}

/** 過去の版を現在の版に戻す（戻す前の現在の版も退避するので、何度でも往復できる）。 */
export async function restoreReportTemplateVersion(id, archiveId) {
  const current = await dbGet("reportTemplates", id);
  const archived = await dbGet("reportTemplates", archiveId);
  if (!current || !archived || archived.archivedOf !== id || archived.isDeleted) throw new Error("戻す版が見つかりません");
  await archiveCurrentVersion(current);
  const updated = stampUpdate(current, {
    sourceFileBlob: archived.sourceFileBlob,
    sourceFileName: archived.sourceFileName,
    sourceFileMimeType: archived.sourceFileMimeType,
    sourceFileSha256: archived.sourceFileSha256 || (await sha256OfBlob(archived.sourceFileBlob)),
    layoutId: archived.layoutId || null,
    revision: (current.revision || 1) + 1,
    replacedAt: new Date().toISOString(),
    restoredFromRevision: archived.revision || 1
  });
  await dbPut("reportTemplates", updated);
  await recordChange({ entityType: "reportTemplate", entityId: id, action: "update", summary: `帳票テンプレート「${updated.name}」を第${archived.revision || 1}版の内容に戻しました` });
  return updated;
}
