/* ==========================================================
   帳票出力サブシステムの公開API
   将来のUI層（設定画面・出力ボタン等）はこのファイル経由で
   report-output/配下の機能を利用する。内部モジュール構成が
   変わっても、ここのエクスポート名が変わらなければUI層は無修正で済む。
   ========================================================== */

export { generateReportOutput } from "./generateReportOutput.js";
export {
  listCompanyProfiles,
  getCompanyProfile,
  createCompanyProfile,
  updateCompanyProfile,
  setCompanyLogo,
  setCompanyHanko,
  deleteCompanyProfile
} from "./companyProfiles.js";
export {
  listReportTemplates,
  getReportTemplate,
  createReportTemplate,
  updateReportTemplate,
  deleteReportTemplate,
  getDefaultTemplateForCompany,
  setDefaultReportTemplate,
  getAppDefaultReportTemplate,
  setAppDefaultReportTemplate,
  clearAppDefaultReportTemplate,
  listTemplateVersions,
  replaceReportTemplateFile,
  restoreReportTemplateVersion,
  sha256OfBlob,
  normalizeAppDefaultReportTemplate
} from "./reportTemplates.js";
export {
  getBundledTemplateStatuses,
  installBundledTemplate,
  prepareBundledUpdate,
  applyBundledUpdate,
  seedBundledTemplatesOnFreshInstall,
  runBundledSetup,
  extractSetupKey,
  getStoredKeyId
} from "./bundledTemplates.js";
export {
  resolveReportTemplateForSite,
  ensureSitePinned,
  pinUnpinnedSites,
  repinSite,
  previewSiteTemplateUpgrade,
  upgradeSiteTemplate,
  revertSiteTemplate,
  listSitesUsingTemplate,
  listSitesPinnedToVersion,
  findTemplateVersion
} from "./templateResolver.js";
export { inspectTemplate, compareTemplateVersions } from "./templateInspector.js";
export { listLayoutProfiles, getLayoutProfile } from "./layoutProfiles.js";
import "./layouts/index.js";
export { registerExcelRenderer, registerPdfRenderer, listExcelRendererIds, listPdfRendererIds } from "./rendererRegistry.js";
