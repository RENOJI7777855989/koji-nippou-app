/* ==========================================================
   現場に使う帳票テンプレート（日報用Excel）の決め方と「版の固定」

   ■ 版の固定（site.templatePin）
     現場は作成した時点で「どのテンプレートの、どの版か」を記録し、以後は
     その版で出力する（再出力・再印刷・台帳も同じ）。テンプレートを新しい版へ
     差し替えても、既存の現場は自動では切り替わらない。新しく作る現場だけが
     その時点の最新版を使う。現場から手動で最新版へ切り替え・元に戻すことができる。
       templatePin = { templateId, sha256, revision, source, pinnedAt }
         templateId … テンプレートのid（差し替えても変わらないid）
         sha256     … 版の中身の指紋（「前の版に戻す」で版番号が変わっても同じ版を指せる）
         revision   … 固定した時点の版番号（表示用）
         source     … 固定した時点の選ばれ方（site/default/company）
       templatePinHistory … 手動で切り替える前の固定（元に戻す用、新しい順）
     版の中身は、テンプレートの現在の版か、退避した過去の版（templateKind:"report_archive"）
     のどちらか。使用中の版は削除・自動整理の対象にしない（reportTemplates.js）。

   ■ 固定していない現場（テンプレートが1件も無い時期に作った現場など）の決め方
     1. 現場ごとの指定（site.reportTemplateId）
     2. アプリの標準テンプレート（isAppDefault）
     3. 元請名と同じ名前の会社プロファイルの既定テンプレート（従来方式）
     見つかった時点（作成時・起動時の移行・最初の出力時）でその版に固定する。
   どれも無ければnull（汎用フォーマットで出力）。
   ========================================================== */

import { dbGet, dbGetAll, dbPut } from "../db.js";
import { recordChange } from "../auditLog.js";
import {
  getReportTemplate,
  getAppDefaultReportTemplate,
  listReportTemplates,
  sha256OfBlob
} from "./reportTemplates.js";
import { listCompanyProfiles } from "./companyProfiles.js";
import { compareTemplateVersions } from "./templateInspector.js";

const SOURCE_LABEL = { site: "この現場で指定した様式", default: "標準テンプレート", company: "元請名と同じ会社の様式" };

/** 版の中身の指紋。古いレコードで未記録なら計算して記録しておく（中身は変えない） */
export async function versionSha(record) {
  if (record.sourceFileSha256) return record.sourceFileSha256;
  if (!record.sourceFileBlob) return "";
  const sha = await sha256OfBlob(record.sourceFileBlob);
  await dbPut("reportTemplates", { ...record, sourceFileSha256: sha });
  return sha;
}

/** テンプレートの特定の版（現在の版、または退避した過去の版）のレコードを探す */
export async function findTemplateVersion(templateId, sha256) {
  const current = await getReportTemplate(templateId);
  if (current && !current.isDeleted && (await versionSha(current)) === sha256) return current;
  const all = await dbGetAll("reportTemplates");
  for (const t of all) {
    if (t.isDeleted || t.templateKind !== "report_archive" || t.archivedOf !== templateId) continue;
    if ((await versionSha(t)) === sha256) return t;
  }
  return null;
}

async function companyNameOf(template) {
  if (!template?.companyProfileId) return "";
  const company = (await listCompanyProfiles()).find((c) => c.id === template.companyProfileId);
  return company?.name || "";
}

/** 固定していない現場に使うテンプレート（現在の版）と、その選ばれ方 */
async function resolveUnpinned(site) {
  let notice = "";
  if (site?.reportTemplateId) {
    const own = await getReportTemplate(site.reportTemplateId);
    if (own && !own.isDeleted && (own.templateKind || "report") === "report" && own.format === "excel") return { template: own, source: "site", notice };
    notice = "この現場で指定した様式が見つからない（削除された）ため、標準の様式を使います。";
  }
  const standard = await getAppDefaultReportTemplate();
  if (standard) return { template: standard, source: "default", notice };
  const name = (site?.clientName || "").trim();
  if (name) {
    const company = (await listCompanyProfiles()).find((c) => (c.name || "").trim() === name);
    if (company) {
      const templates = await listReportTemplates({ companyProfileId: company.id, format: "excel", templateKind: "report" });
      const template = templates.find((t) => t.isDefault) || templates[0];
      if (template) return { template, source: "company", notice };
    }
  }
  return null;
}

/**
 * @returns {Promise<null|{
 *   templateId: string,        出力に使うレコードのid（固定した版が過去の版なら、その退避レコードのid）
 *   baseTemplateId: string,    テンプレートのid（差し替えても変わらないid）
 *   templateName, companyProfileId, companyName, layoutId,
 *   revision: number, sha256: string, source, sourceLabel, notice,
 *   pinned: boolean, latestRevision: number|null, isLatest: boolean, missing?: boolean
 * }>}
 */
export async function resolveReportTemplateForSite(site) {
  const pin = site?.templatePin;
  if (pin?.templateId) {
    const base = await getReportTemplate(pin.templateId);
    const version = await findTemplateVersion(pin.templateId, pin.sha256);
    const latest = base && !base.isDeleted ? base : null;
    if (!version) {
      // 固定した版が見つからない（通常は削除できないが、バックアップの部分復元などで起こりうる）。
      // 勝手に別の版で出力しないよう、呼び出し側でエラーにする
      return {
        templateId: null,
        baseTemplateId: pin.templateId,
        templateName: base?.name || "（見つかりません）",
        companyProfileId: base?.companyProfileId || null,
        companyName: await companyNameOf(base),
        layoutId: null,
        revision: pin.revision || null,
        sha256: pin.sha256,
        source: pin.source || "default",
        sourceLabel: SOURCE_LABEL[pin.source] || "",
        notice: `この現場に固定した版（第${pin.revision || "?"}版）が見つかりません。`,
        pinned: true,
        latestRevision: latest?.revision || null,
        isLatest: false,
        missing: true
      };
    }
    return {
      templateId: version.id,
      baseTemplateId: pin.templateId,
      templateName: version.name,
      companyProfileId: version.companyProfileId || null,
      companyName: await companyNameOf(version),
      layoutId: version.layoutId || null,
      revision: version.revision || 1,
      sha256: pin.sha256,
      source: pin.source || "default",
      sourceLabel: SOURCE_LABEL[pin.source] || "",
      notice: "",
      pinned: true,
      latestRevision: latest?.revision || null,
      isLatest: !!latest && version.id === latest.id
    };
  }
  const found = await resolveUnpinned(site);
  if (!found) return null;
  const { template, source, notice } = found;
  return {
    templateId: template.id,
    baseTemplateId: template.id,
    templateName: template.name,
    companyProfileId: template.companyProfileId || null,
    companyName: await companyNameOf(template),
    layoutId: template.layoutId || null,
    revision: template.revision || 1,
    sha256: await versionSha(template),
    source,
    sourceLabel: SOURCE_LABEL[source],
    notice,
    pinned: false,
    latestRevision: template.revision || 1,
    isLatest: true
  };
}

function pinOf(template, sha256, source) {
  return { templateId: template.id, sha256, revision: template.revision || 1, source, pinnedAt: new Date().toISOString() };
}

/**
 * 現場の記録に版の固定だけを書き込む（現場の他の内容・更新日時は変えない）。
 * 画面での編集と同時に動いても上書きしないよう、書き込む直前に読み直す。
 */
async function writePin(site, pin, history) {
  const fresh = (await dbGet("sites", site.id)) || site;
  const next = { ...fresh, templatePin: pin };
  if (history !== undefined) next.templatePinHistory = history;
  await dbPut("sites", next);
  return next;
}

/**
 * 固定していない現場を、今使うテンプレートの現在の版に固定する（作成時・起動時の移行・出力前）。
 * 既に固定済み、または使うテンプレートが無い場合は何もしない。
 */
export async function ensureSitePinned(siteOrId) {
  const site = typeof siteOrId === "string" ? await dbGet("sites", siteOrId) : siteOrId;
  if (!site || site.templatePin?.templateId) return site;
  const found = await resolveUnpinned(site);
  if (!found) return site;
  const sha = await versionSha(found.template);
  if (!sha) return site;
  return writePin(site, pinOf(found.template, sha, found.source));
}

/** 起動時: 固定していない既存の現場を、今使っているテンプレートの現在の版に固定する（1回ごとに未固定分だけ） */
export async function pinUnpinnedSites() {
  const sites = (await dbGetAll("sites")).filter((s) => !s.isDeleted && !s.templatePin?.templateId);
  let pinned = 0;
  for (const site of sites) {
    const after = await ensureSitePinned(site);
    if (after?.templatePin) pinned += 1;
  }
  if (pinned > 0) {
    await recordChange({ entityType: "site", entityId: "template-pin-migration", action: "update", summary: `既存の現場${pinned}件に、使用中の日報Excel様式の版を記録しました（様式は変わりません）` });
  }
  return pinned;
}

/** 工事完了の現場は、日報が確定済みのため様式を切り替えない（再出力は固定した様式・版で行う）。工事完了を解除すれば切り替えられる */
export const COMPLETED_SITE_MESSAGE = "工事完了の現場は、日報のExcel様式を切り替えられません（工事完了を解除すると切り替えられます）。";

/** この現場の固定を、指定したテンプレート（または現場の指定／標準）の現在の版へ付け替える（手動）。工事完了の現場は拒否する */
export async function repinSite(siteId, { templateId = undefined, reason = "manual" } = {}) {
  const site = await dbGet("sites", siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error(COMPLETED_SITE_MESSAGE);
  let target;
  let source;
  if (templateId) {
    target = await getReportTemplate(templateId);
    source = site.reportTemplateId === templateId ? "site" : site.templatePin?.source || "default";
  } else {
    const found = await resolveUnpinned(site);
    target = found?.template;
    source = found?.source;
  }
  if (!target || target.isDeleted) throw new Error("切り替え先のテンプレートが見つかりません");
  const sha = await versionSha(target);
  if (site.templatePin?.templateId === target.id && site.templatePin.sha256 === sha) return site;
  const history = site.templatePin ? [{ ...site.templatePin, replacedAt: new Date().toISOString(), reason }, ...(site.templatePinHistory || [])].slice(0, 20) : site.templatePinHistory || [];
  const next = await writePin(site, pinOf(target, sha, source), history);
  await recordChange({ entityType: "site", entityId: siteId, action: "update", summary: `現場「${site.name}」の日報Excel様式を「${target.name}」第${target.revision || 1}版に切り替え` });
  return next;
}

/** この現場の固定しているテンプレートの最新版へ切り替える前の確認材料（固定文言の違い） */
export async function previewSiteTemplateUpgrade(siteId) {
  const site = await dbGet("sites", siteId);
  const resolved = await resolveReportTemplateForSite(site);
  if (!resolved?.pinned) throw new Error("この現場はまだ様式の版を固定していません");
  const latest = await getReportTemplate(resolved.baseTemplateId);
  if (!latest || latest.isDeleted) throw new Error("最新版が見つかりません");
  if (resolved.isLatest) return { resolved, latest, diffs: [], warnings: [], same: true };
  const current = resolved.missing ? null : await getReportTemplate(resolved.templateId);
  const compare = current?.sourceFileBlob && latest.layoutId
    ? await compareTemplateVersions(await current.sourceFileBlob.arrayBuffer(), await latest.sourceFileBlob.arrayBuffer(), latest.layoutId)
    : { diffs: [], warnings: [], errors: [] };
  return { resolved, latest, diffs: compare.diffs, warnings: [...compare.errors, ...compare.warnings], same: false };
}

/** 手動: 固定しているテンプレートの最新版へ切り替える */
export async function upgradeSiteTemplate(siteId) {
  const site = await dbGet("sites", siteId);
  if (!site?.templatePin?.templateId) throw new Error("この現場はまだ様式の版を固定していません");
  return repinSite(siteId, { templateId: site.templatePin.templateId, reason: "upgrade" });
}

/** 手動: 直前の固定（切り替える前の版）に戻す。その版が残っていなければ戻さない */
export async function revertSiteTemplate(siteId) {
  const site = await dbGet("sites", siteId);
  if (site?.completedAt) throw new Error(COMPLETED_SITE_MESSAGE);
  const [previous, ...rest] = site?.templatePinHistory || [];
  if (!previous) throw new Error("戻せる前の版がありません");
  const version = await findTemplateVersion(previous.templateId, previous.sha256);
  if (!version) throw new Error(`前の版（第${previous.revision || "?"}版）が見つからないため戻せません`);
  const { replacedAt, reason, ...pin } = previous;
  void replacedAt;
  void reason;
  const next = await writePin(site, { ...pin, pinnedAt: new Date().toISOString() }, rest);
  await recordChange({ entityType: "site", entityId: siteId, action: "update", summary: `現場「${site.name}」の日報Excel様式を第${version.revision || 1}版に戻しました` });
  return next;
}

/** テンプレート（またはその特定の版）を固定している現場 */
export async function listSitesUsingTemplate(templateId, sha256 = null) {
  const sites = (await dbGetAll("sites")).filter((s) => !s.isDeleted);
  return sites.filter((s) => {
    const pins = [s.templatePin, ...(s.templatePinHistory || [])].filter(Boolean);
    return pins.some((p) => p.templateId === templateId && (!sha256 || p.sha256 === sha256));
  });
}

/** 現在の固定で使っている版（元に戻す用の履歴は含まない） */
export async function listSitesPinnedToVersion(templateId, sha256) {
  const sites = (await dbGetAll("sites")).filter((s) => !s.isDeleted);
  return sites.filter((s) => s.templatePin?.templateId === templateId && (!sha256 || s.templatePin.sha256 === sha256));
}
