/* ==========================================================
   エントリーポイント: DB初期化(移行含む)→ルーター登録→起動

   ログイン機能・ユーザー管理・権限管理は今回のリリースでは
   無効化している（誰でも同じデータを閲覧・編集できる構成）。
   関連コード（js/auth.js・js/currentUser.js・js/ui/login-view.js・
   js/ui/user-management-view.js・js/ui/app-shell.js、および
   index.html内の#view-login・#view-users・#userBar等）は削除せず
   温存してあるため、将来ログインを再度必須にする場合は、
   下記のルート登録をrequireLogin/requirePermissionで包み直し、
   bootstrap内でrefreshUserBar()を呼ぶよう戻すだけでよい。
   ========================================================== */

import { runMigration } from "./migrate.js";
import { seedBundledTemplatesOnFreshInstall, extractSetupKey, runBundledSetup } from "./report-output/bundledTemplates.js";
import { pinUnpinnedSites } from "./report-output/templateResolver.js";
import { registerServiceWorker } from "./pwaRegister.js";
import { registerRoute, startRouter } from "./router.js";
import { initSiteListView } from "./ui/site-list-view.js";
import { initSiteFormViewNew, initSiteFormViewEdit } from "./ui/site-form-view.js";
import { initSiteDetailView } from "./ui/site-detail-view.js";
import { initReportFormViewNew, initReportFormViewEdit } from "./ui/report-form-view.js";
import { initReportTemplateListView } from "./ui/report-template-view.js";
import { initAuditLogView } from "./ui/audit-log-view.js";
import { initBackupView } from "./ui/backup-view.js";
import { initReportOutputView } from "./ui/report-output-view.js";
import { initEstimateListView } from "./ui/estimate-list-view.js";
import { initEstimateImportView } from "./ui/estimate-import-view.js";
import { initEstimateAskView } from "./ui/estimate-ask-view.js";
import { initVendorQuoteListView } from "./ui/vendor-quote-list-view.js";
import { initVendorQuoteImportView } from "./ui/vendor-quote-import-view.js";
import { initComparisonView } from "./ui/comparison-view.js";
import { initMasterItemListView } from "./ui/master-item-list-view.js";
import { initSubmissionView } from "./ui/submission-view.js";
import { initSubmissionImportView } from "./ui/submission-import-view.js";
import { initVendorManagementView } from "./ui/vendor-management-view.js";

/**
 * セットアップリンク（index.html#setup=鍵）で開かれたら、鍵をURLから取り除いてから処理する
 * （画面のアドレス・戻る履歴に鍵を残さない。# 以降はもともとサーバーへ送られない）。
 */
function takeSetupKeyFromUrl() {
  const key = extractSetupKey(window.location.hash);
  if (!key) return null;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/sites`);
  return key;
}

async function runSetupLink(key) {
  const { showMessage } = await import("./ui/common.js");
  showMessage("標準テンプレートを登録しています…");
  try {
    const r = await runBundledSetup(key);
    const text = r.installed.length
      ? `標準テンプレート（03-2）をこの端末に登録しました${r.madeStandard ? "（標準に設定）" : "（標準は変更していません。必要ならテンプレート管理で標準にしてください）"}。以後は鍵の入力なしで使えます。`
      : "この端末には登録済みです。鍵を保存しました（新しい版があればテンプレート管理から更新できます）。";
    showMessage(text);
    window.dispatchEvent(new CustomEvent("bundled-template-setup", { detail: r }));
  } catch (err) {
    showMessage(`セットアップできませんでした: ${err?.message || "原因不明のエラー"}`, true);
  }
}

async function bootstrap() {
  const setupKey = takeSetupKeyFromUrl();
  // アプリを開いたままセットアップリンクを開いた場合（再読み込みされず # 以降だけ変わる）も受け取る。
  // ルーターより先に登録し、鍵をURLから取り除いてから（ルーターは置き換え後の #/sites を表示する）処理する
  window.addEventListener("hashchange", () => {
    const key = takeSetupKeyFromUrl();
    if (key) runSetupLink(key).then(() => pinUnpinnedSites()).catch(() => {});
  });
  registerServiceWorker();
  await runMigration();

  // 具体的なパターンを先に、汎用的な":id"パターンを後に登録する
  registerRoute("/sites", () => initSiteListView());
  registerRoute("/report-templates", () => initReportTemplateListView());
  registerRoute("/master-items", () => initMasterItemListView());
  registerRoute("/report-output", (params, query) => initReportOutputView(query));
  registerRoute("/history", () => initAuditLogView());
  registerRoute("/backup", () => initBackupView());
  registerRoute("/sites/new", () => initSiteFormViewNew());
  registerRoute("/sites/:id/edit", (params) => initSiteFormViewEdit(params));
  registerRoute("/sites/:id/report/new", (params, query) => initReportFormViewNew({ ...params, date: query?.date }));
  registerRoute("/sites/:id/report/:reportId", (params) => initReportFormViewEdit(params));
  registerRoute("/sites/:id/estimates/import", (params) => initEstimateImportView(params));
  registerRoute("/sites/:id/estimates/ask", (params) => initEstimateAskView(params));
  registerRoute("/sites/:id/estimates", (params) => initEstimateListView(params));
  registerRoute("/sites/:id/submission/import", (params) => initSubmissionImportView(params));
  registerRoute("/sites/:id/submission", (params) => initSubmissionView(params));
  registerRoute("/sites/:id/vendor-quotes/import", (params) => initVendorQuoteImportView(params));
  registerRoute("/sites/:id/vendor-quotes/compare", (params) => initComparisonView(params));
  registerRoute("/sites/:id/vendor-quotes", (params) => initVendorQuoteListView(params));
  registerRoute("/sites/:id/vendors", (params) => initVendorManagementView(params));
  registerRoute("/sites/:id", (params) => initSiteDetailView(params));

  startRouter();

  // 画面を表示してから（待たせないよう）バックグラウンドで行う:
  //  ・新規インストールの初回起動だけ、同梱の標準テンプレート（クリーンな03-2）を自動登録する。
  //    既存の端末・既存のデータには何もしない。失敗してもアプリは使える（次回の起動で再試行）
  //  ・様式の版を固定していない既存の現場を、今使っている版に固定する（現場・日報の内容は変えない）
  (setupKey ? runSetupLink(setupKey) : Promise.resolve())
    .then(() => seedBundledTemplatesOnFreshInstall())
    .catch((err) => console.warn("同梱テンプレートの初回登録をスキップしました", err))
    .then(() => pinUnpinnedSites())
    .catch((err) => console.warn("様式の版の記録をスキップしました", err));
}

bootstrap().catch((err) => {
  console.error("アプリの初期化に失敗しました", err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="color:#b02b2b;padding:16px;">アプリの初期化に失敗しました。ブラウザの設定（プライベートブラウジング等）をご確認のうえ、再読み込みしてください。</p>`
  );
});
