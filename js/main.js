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

async function bootstrap() {
  registerServiceWorker();
  await runMigration();

  // 具体的なパターンを先に、汎用的な":id"パターンを後に登録する
  registerRoute("/sites", () => initSiteListView());
  registerRoute("/report-templates", () => initReportTemplateListView());
  registerRoute("/report-output", (params, query) => initReportOutputView(query));
  registerRoute("/history", () => initAuditLogView());
  registerRoute("/backup", () => initBackupView());
  registerRoute("/sites/new", () => initSiteFormViewNew());
  registerRoute("/sites/:id/edit", (params) => initSiteFormViewEdit(params));
  registerRoute("/sites/:id/report/new", (params) => initReportFormViewNew(params));
  registerRoute("/sites/:id/report/:reportId", (params) => initReportFormViewEdit(params));
  registerRoute("/sites/:id/estimates/import", (params) => initEstimateImportView(params));
  registerRoute("/sites/:id/estimates/ask", (params) => initEstimateAskView(params));
  registerRoute("/sites/:id/estimates", (params) => initEstimateListView(params));
  registerRoute("/sites/:id", (params) => initSiteDetailView(params));

  startRouter();
}

bootstrap().catch((err) => {
  console.error("アプリの初期化に失敗しました", err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="color:#b02b2b;padding:16px;">アプリの初期化に失敗しました。ブラウザの設定（プライベートブラウジング等）をご確認のうえ、再読み込みしてください。</p>`
  );
});
