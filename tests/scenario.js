const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = "http://localhost:8934/index.html";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
}

async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("dialog", (dialog) => dialog.accept());
  return { context, page, consoleErrors, pageErrors };
}

async function runMigrationScenario(browser, photoPath) {
  const { context, page, consoleErrors, pageErrors } = await newPage(browser);
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("constructionReportsDB");
    const oldReports = [
      {
        id: "old-1",
        date: "2026-01-10",
        siteName: "旧データ現場A",
        weather: "晴れ",
        companies: [{ companyName: "旧建設", workerCount: "3", workContent: "基礎工事", safetyNotes: "" }],
        tomorrowPlan: "型枠工事",
        savedAt: "2026-01-10T00:00:00.000Z"
      },
      {
        id: "old-2",
        date: "2026-01-11",
        siteName: "旧データ現場A",
        weather: "曇り",
        companies: [],
        tomorrowPlan: "",
        savedAt: "2026-01-11T00:00:00.000Z"
      }
    ];
    localStorage.setItem("dailyReports", JSON.stringify(oldReports));
  });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);

  const siteCount = await page.locator("#siteList .site-card").count();
  record("旧localStorageデータから現場が自動生成される（データ移行）", siteCount === 1, `count=${siteCount}`);

  const siteName = await page.locator("#siteList .site-card-name").first().textContent();
  record("移行後の現場名が旧日報のsiteNameになる", siteName.trim() === "旧データ現場A", siteName.trim());

  await page.locator(".site-card").first().click();
  await page.waitForTimeout(200);
  const reportCount = await page.locator("#reportList .report-card").count();
  record("移行後、現場配下に旧日報2件が引き継がれる", reportCount === 2, `count=${reportCount}`);

  const backupExists = await page.evaluate(() => localStorage.getItem("dailyReports_migrated_backup") !== null);
  record("移行元データがバックアップキーへ退避される", backupExists === true);

  record("移行フローでpageerrorが発生しない", pageErrors.length === 0, JSON.stringify(pageErrors));
  record("移行フローでconsole.errorが発生しない", consoleErrors.length === 0, JSON.stringify(consoleErrors));

  await context.close();
}

async function runMainScenario(browser, photoPath) {
  const { context, page, consoleErrors, pageErrors } = await newPage(browser);
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.evaluate(() => indexedDB.deleteDatabase("constructionReportsDB"));
  await page.reload();
  await page.waitForLoadState("networkidle");

  // 初期表示
  record("初期表示は現場一覧で空メッセージが出る", await page.isVisible("#siteListEmpty"));

  // 現場作成
  await page.click("#newSiteBtn");
  await page.fill("#siteFormName", "テスト現場A");
  await page.fill("#siteFormClientName", "元請テスト株式会社");
  await page.fill("#siteFormAddress", "東京都テスト区1-2-3");
  await page.fill("#siteFormMemo", "テスト用メモ<script>alert(1)</script>");
  await page.click("#siteFormSaveBtn");
  await page.waitForTimeout(200);
  record("現場詳細画面へ遷移する（作成成功）", await page.isVisible("#view-site-detail"));
  const detailName = await page.textContent("#siteDetailName");
  record("現場詳細に現場名が表示される", detailName === "テスト現場A", detailName);

  // XSSエスケープ確認（メモはtextContentで挿入しているため元々安全だが、一覧側innerHTML経路も確認）
  await page.click("#backToSiteListBtn");
  await page.waitForTimeout(200);
  const hasScriptTag = (await page.locator("#siteList script").count()) > 0;
  record("現場一覧でXSS（scriptタグ挿入）が発生しない", hasScriptTag === false);

  // 検索
  await page.fill("#siteSearchInput", "テスト現場A");
  await page.waitForTimeout(150);
  record("検索で該当現場が絞り込まれる", (await page.locator("#siteList .site-card").count()) === 1);
  await page.fill("#siteSearchInput", "存在しない現場名XYZ");
  await page.waitForTimeout(150);
  record("該当なし検索で0件になる", (await page.locator("#siteList .site-card").count()) === 0);
  await page.fill("#siteSearchInput", "");
  await page.waitForTimeout(150);

  // 現場詳細に戻って日報作成
  await page.locator(".site-card").first().click();
  await page.waitForTimeout(200);
  await page.click("#newReportBtn");
  await page.waitForTimeout(150);
  record("日報フォーム画面へ遷移する", await page.isVisible("#view-report-form"));

  await page.fill("#temperature", "28");
  await page.selectOption("#weather", "雨");
  await page.fill(".company-row >> nth=0 >> .companyName", "第一建設");
  await page.fill(".company-row >> nth=0 >> .plannedWorkerCount", "6");
  await page.fill(".company-row >> nth=0 >> .actualWorkerCount", "5");
  record("実績人数を入力すると作業人数（合計）が自動計算される", (await page.inputValue("#workerCountTotal")) === "5");
  await page.fill(".company-row >> nth=0 >> .machinery", "バックホウ");
  await page.fill(".company-row >> nth=0 >> .workContent", "掘削工事");
  await page.fill(".company-row >> nth=0 >> .safetyNotes", "重機周辺立入禁止");
  await page.fill("#remarks", "特記事項なし");
  await page.fill("#tomorrowPlan", "配筋検査");

  // 写真添付
  await page.setInputFiles("#photoInput", photoPath);
  await page.waitForTimeout(300);
  record("写真添付で写真タイルが表示される", (await page.locator(".photo-tile").count()) === 1);

  // 署名（実際のマウス操作でPointer Eventsを発火させる。業者行ごとに1本ずつ持つため先頭行を対象にする）
  const signatureCanvasLocator = page.locator(".company-row").first().locator(".signatureCanvas");
  await signatureCanvasLocator.scrollIntoViewIfNeeded();
  const canvasBox = await signatureCanvasLocator.boundingBox();
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 80, canvasBox.y + 60, { steps: 5 });
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  await page.click("#reportSaveBtn");
  await page.waitForTimeout(300);
  record("日報保存後、現場詳細に戻る", await page.isVisible("#view-site-detail"));
  record("日報一覧に1件表示される", (await page.locator("#reportList .report-card").count()) === 1);

  // 日報編集画面で保存内容・写真・署名が復元されるか確認
  await page.locator(".report-card").first().click();
  await page.waitForTimeout(200);
  record("編集画面で気温が復元される", (await page.inputValue("#temperature")) === "28");
  record("編集画面でも作業人数（合計）が実績人数の合計として再計算される", (await page.inputValue("#workerCountTotal")) === "5");
  record("編集画面で使用機械が復元される", (await page.inputValue(".company-row >> nth=0 >> .machinery")) === "バックホウ");
  record("編集画面で写真が復元される", (await page.locator(".photo-tile").count()) === 1);
  const signedAtText = await page.locator(".company-row").first().locator(".signatureSignedAt").textContent();
  record("編集画面で署名日時が復元される（署名保存の確認）", signedAtText.includes("署名日時"), signedAtText);

  // 署名の書き直し
  await page.locator(".company-row").first().locator(".clearSignatureBtn").click();
  await page.waitForTimeout(100);
  const signedAtAfterClear = await page.locator(".company-row").first().locator(".signatureSignedAt").textContent();
  record("書き直しボタンで署名日時表示がクリアされる", signedAtAfterClear.trim() === "");

  // 写真削除
  await page.click(".removePhotoBtn");
  await page.waitForTimeout(200);
  record("写真削除ボタンで写真が削除される", (await page.locator(".photo-tile").count()) === 0);

  await page.click("#backToSiteDetailBtn");
  await page.waitForTimeout(200);

  // 日報は通常操作では削除できない（紙を紛失しても再出力できるよう日報データを残す仕様。
  // 以前は「日報削除後、一覧から消える」を確認していたが、仕様変更によりこの確認に置き換えた）
  await page.locator(".report-card").first().click();
  await page.waitForTimeout(200);
  const deleteVisible = await page.isVisible("#deleteReportBtn");
  await page.click("#backToSiteDetailBtn");
  await page.waitForTimeout(200);
  record("日報は削除できない（削除ボタン非表示・一覧に残る）", !deleteVisible && (await page.locator("#reportList .report-card").count()) === 1);

  // 現場コピー（文字情報のみ、日報コピーなし）
  await page.click("#copySiteBtn");
  await page.fill("#copySiteNewName", "テスト現場A（コピー）");
  await page.click("#copySiteConfirmBtn");
  await page.waitForTimeout(300);
  const copiedName = await page.textContent("#siteDetailName");
  record("現場コピーで新しい現場詳細に遷移する", copiedName === "テスト現場A（コピー）", copiedName);
  record("コピー先に日報がコピーされない（チェックなし）", (await page.locator("#reportList .report-card").count()) === 0);
  // 以前は日報削除後の現場で確認していた。日報は削除できない仕様になったため、日報0件のコピー先現場で確認する
  record("日報0件で空メッセージが表示される", await page.isVisible("#reportListEmpty"));

  // アーカイブ
  await page.click("#toggleArchiveBtn");
  await page.waitForTimeout(200);
  const badge = await page.textContent("#siteDetailStatusBadge");
  record("アーカイブ操作でステータスが切り替わる", badge === "アーカイブ済み", badge);

  await page.click("#backToSiteListBtn");
  await page.waitForTimeout(200);
  const visibleCountDefault = await page.locator("#siteList .site-card").count();
  record("アーカイブ済み現場はデフォルト非表示", visibleCountDefault === 1, `count=${visibleCountDefault}`);

  await page.check("#showArchivedCheckbox");
  await page.waitForTimeout(200);
  const visibleCountWithArchived = await page.locator("#siteList .site-card").count();
  record("アーカイブ済みを表示トグルで全件表示される", visibleCountWithArchived === 2, `count=${visibleCountWithArchived}`);
  await page.uncheck("#showArchivedCheckbox");
  await page.waitForTimeout(100);

  // 現場コピー（日報あり、日報コピーする）
  await page.locator(".site-card", { hasText: "テスト現場A" }).first().click();
  await page.waitForTimeout(200);
  // このテスト現場Aには日報が1件ある（日報は削除できない仕様のため、以前のように削除・再作成はしない）

  await page.click("#copySiteBtn");
  await page.check("#copySiteReportsCheckbox");
  await page.click("#copySiteConfirmBtn");
  await page.waitForTimeout(300);
  const copiedReportCount = await page.locator("#reportList .report-card").count();
  record("日報コピーONで日報が複製される", copiedReportCount === 1, `count=${copiedReportCount}`);
  await page.locator(".report-card").first().click();
  await page.waitForTimeout(200);
  const copiedPhotoCount = await page.locator(".photo-tile").count();
  record("コピーされた日報に写真は複製されない", copiedPhotoCount === 0, `count=${copiedPhotoCount}`);

  // データ永続性: リロード後も現場・日報が残る
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(200);
  await page.goto(BASE_URL + "#/sites");
  await page.waitForTimeout(200);
  const sitesAfterReload = await page.locator("#siteList .site-card").count();
  record("リロード後も現場データが保持される（IndexedDB永続性）", sitesAfterReload >= 1, `count=${sitesAfterReload}`);

  record("一連の操作でpageerrorが発生しない", pageErrors.length === 0, JSON.stringify(pageErrors));
  record("一連の操作でconsole.errorが発生しない", consoleErrors.length === 0, JSON.stringify(consoleErrors));

  await context.close();
}

async function runResponsiveScenario(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.evaluate(() => indexedDB.deleteDatabase("constructionReportsDB"));
  await page.reload();
  await page.waitForLoadState("networkidle");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(100);
  record("モバイル幅(375px)で新規現場ボタンが操作可能", await page.isVisible("#newSiteBtn"));

  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(100);
  record("iPad幅(820px)で新規現場ボタンが操作可能", await page.isVisible("#newSiteBtn"));

  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  const photoPath = process.argv[2] || path.join(__dirname, "test-photo.png");

  await runMigrationScenario(browser, photoPath);
  await runMainScenario(browser, photoPath);
  await runResponsiveScenario(browser);

  await browser.close();

  console.log("\n===== まとめ =====");
  const failCount = results.filter((r) => !r.pass).length;
  console.log(`合計 ${results.length} 件 / 成功 ${results.length - failCount} 件 / 失敗 ${failCount} 件`);
  if (failCount > 0) {
    console.log("\n失敗項目:");
    results.filter((r) => !r.pass).forEach((r) => console.log(`- ${r.name} (${r.detail})`));
  }
  process.exit(failCount > 0 ? 1 : 0);
})();
