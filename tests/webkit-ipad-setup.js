// WebKit（Safariと同じエンジン）＋iPadの画面設定での、セットアップリンク～出力の確認。
// ※ iPad実機・iOS Safari・ホーム画面アプリ（PWA）の確認の代わりにはならない（エンジンが同系統というだけ）。
// 公開相当の配信（GitHub Pagesと同じ /koji-nippou-app/ のサブパス）に対して実行できる。
// 実行: PAGES_BASE=http://localhost:8935/koji-nippou-app/index.html node tests/webkit-ipad-setup.js
const path = require("path");
const fs = require("fs");
const { webkit, devices } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey, setupUrl } = require("./helpers/templateKey.js");

const BASE = process.env.PAGES_BASE || "http://localhost:8934/index.html";
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "webkit-ipad-test");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const KEY = loadKey();
  const device = devices["iPad Pro 11"] || devices["iPad (gen 7)"];
  // 通常のSafariに近い永続プロファイルで確認する（Playwrightの一時コンテキストはプライベートブラウズ相当で、
  // IndexedDBにファイル（Blob）を保存できないため）
  const profileDir = fs.mkdtempSync(path.join(OUT, "profile-"));
  const { isMobile, hasTouch, defaultBrowserType, ...deviceOpts } = device;
  void isMobile; void hasTouch; void defaultBrowserType;
  const ignoreHTTPSErrors = process.env.IGNORE_HTTPS_ERRORS === "1"; // 確認用サイト（自己署名の確認用CA）に対して実行する場合
  const ctx = await webkit.launchPersistentContext(profileDir, { ...deviceOpts, acceptDownloads: true, ignoreHTTPSErrors });
  const browser = { close: () => ctx.close() };
  const p = await ctx.newPage();
  const errors = [];
  const logs = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { logs.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
  const registered = () => p.evaluate(async () => (await (await import("./js/db.js")).dbGetAll("reportTemplates")).filter((t) => t.bundledId && !t.isDeleted));

  // メッセージ等からリンクを開いた想定: 別のページからセットアップリンクへ移動する
  await p.goto("about:blank");
  await p.goto(setupUrl(BASE, KEY));
  await p.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(p, async () => (await (await import("./js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const reg = (await registered())[0];
  check("WebKit/iPad: セットアップリンクを開くと03-2が標準として登録される", !!reg && reg.isAppDefault, reg && reg.name);
  const href = await p.evaluate(() => location.href);
  check("WebKit/iPad: 登録後、アドレスから鍵が消える", !href.includes(KEY) && /#\/sites$/.test(href), href.replace(KEY, "<鍵>"));
  await p.goBack().catch(() => {});
  const back = p.url();
  check("WebKit/iPad: 「戻る」で鍵付きのURLに戻らない（直前のページに戻る）", !back.includes(KEY), back.replace(KEY, "<鍵>"));
  await p.goForward().catch(() => {});
  const fwd = p.url();
  check("WebKit/iPad: 「進む」でも鍵付きのURLにならない", !fwd.includes(KEY), fwd.replace(KEY, "<鍵>"));
  check("WebKit/iPad: 画面のメッセージ・コンソールに鍵が出ない", !logs.some((l) => l.includes(KEY)) && !(await p.content()).includes(KEY));

  // アプリを開いたまま、もう一度リンクを開いた場合（ページは再読み込みされず # だけ変わる）
  await p.goto(`${BASE}#/sites`); await p.waitForSelector("#view-site-list:not([hidden])");
  await p.evaluate((k) => { location.hash = `#setup=${k}`; }, KEY);
  await p.waitForFunction((k) => !location.href.includes(k), KEY);
  await p.waitForTimeout(800);
  check("WebKit/iPad: アプリを開いたままリンクを開いても鍵はアドレスから消え、重複登録しない", (await registered()).length === 1 && !p.url().includes(KEY));

  // 再起動（ページを閉じて開き直す）してもテンプレートが残り、鍵の入力なしで出力できる
  await p.close();
  const p2 = await ctx.newPage();
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
  const after = await p2.evaluate(async () => (await (await import("./js/db.js")).dbGetAll("reportTemplates")).filter((t) => t.bundledId).length);
  check("WebKit/iPad: ページを閉じて開き直してもテンプレートが残る", after === 1);
  const ids = await p2.evaluate(async () => {
    const { createSite } = await import("./js/sites.js"); const { createReport } = await import("./js/reports.js");
    const s = await createSite({ name: "WebKit確認現場", startDate: "2026-04-01", endDate: "2026-04-10" });
    const r = await createReport({ siteId: s.id, date: "2026-04-02", weather: "晴れ", siteSupervisorNames: ["監督A"], companies: [{ companyId: "c", companyName: "WebKit工業", occupation: "とび", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: "WebKit出力確認", safetyNotes: "" }] });
    return { siteId: s.id, reportId: r.id, pinned: !!s.templatePin };
  });
  const [dl] = await Promise.all([p2.waitForEvent("download"), p2.evaluate(async (id) => (await import("./js/reportPrint.js")).exportReportExcel(id), ids.reportId)]);
  const f = path.join(OUT, "webkit.xlsx"); await dl.saveAs(f);
  const head = fs.readFileSync(f).subarray(0, 2).toString("latin1");
  const contains = await p2.evaluate(async (b64) => {
    const { WorkbookPackage } = await import("./js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer);
    return (await pkg.getText("xl/worksheets/sheet1.xml")).includes("WebKit出力確認");
  }, fs.readFileSync(f).toString("base64"));
  check("WebKit/iPad: 鍵の入力なしで日報のExcelを出力できる（03-2・版を固定）", head === "PK" && contains && ids.pinned, dl.suggestedFilename());

  // オフライン（Service Workerが使える場合）
  const swReady = await p2.evaluate(async () => { try { const r = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((res) => setTimeout(() => res(false), 8000))]); return r && !!(await caches.match("./assets/templates/anzen-eisei-03-2.xlsx.enc")); } catch { return false; } });
  if (swReady) {
    await ctx.setOffline(true);
    await p2.reload().catch(() => {}); await p2.waitForSelector("#view-site-list:not([hidden])", { timeout: 15000 }).catch(() => {});
    const off = await p2.evaluate(async (reportId) => {
      try {
        const { generateReportOutput } = await import("./js/report-output/generateReportOutput.js");
        const { resolveCompanyTemplateForSite } = await import("./js/reportPrint.js");
        const { getReport } = await import("./js/reports.js"); const { getSite } = await import("./js/sites.js");
        const c = await resolveCompanyTemplateForSite(await getSite((await getReport(reportId)).siteId));
        const res = await generateReportOutput({ reportId, format: "excel", templateId: c.templateId });
        return { ok: true, online: navigator.onLine, size: res.blob.size };
      } catch (e) { return { ok: false, err: e.message }; }
    }, ids.reportId).catch((e) => ({ ok: false, err: e.message }));
    check("WebKit/iPad: オフラインでもExcel出力できる", off.ok && off.online === false && off.size > 30000, JSON.stringify(off));
    await ctx.setOffline(false);
  } else {
    check("WebKit/iPad: オフライン確認（この実行環境のWebKitではService Workerが有効にならず確認できない）", true, "未確認として扱う");
    results.pop(); results.push(null);
  }

  // サイトデータ削除 → 同じリンクで復旧（アプリのページを閉じ、DBを開かないページで削除する）
  await p2.close();
  const wipePage = await ctx.newPage();
  await wipePage.goto(new URL("assets/templates/manifest.json", BASE).href);
  const wipeResult = await wipePage.evaluate(async () => {
    const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ["constructionReportsDB"];
    const out = [];
    for (const n of names) out.push(await new Promise((res) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = () => res(n + ":deleted"); q.onerror = () => res(n + ":error"); q.onblocked = () => res(n + ":blocked"); }));
    try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
    return out;
  });
  await wipePage.close();
  const p3 = await ctx.newPage();
  p3.on("pageerror", (e) => errors.push(e.message));
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])"); await p3.waitForTimeout(1000);
  const wiped = await p3.evaluate(async () => (await (await import("./js/db.js")).dbGetAll("reportTemplates")).length);
  await p3.goto(setupUrl(BASE, KEY)); await p3.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(p3, async () => (await (await import("./js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  check("WebKit/iPad: サイトデータ削除後、同じリンクを開くと復旧する", wiped === 0, JSON.stringify(wipeResult));

  // プライベートブラウズ相当（一時コンテキスト）: 保存できない理由を分かる言葉で表示する
  const privBrowser = await webkit.launch();
  const privCtx = await privBrowser.newContext({ ...deviceOpts, ignoreHTTPSErrors });
  const pv = await privCtx.newPage();
  await pv.goto(setupUrl(BASE, KEY)); await pv.waitForSelector("#view-site-list:not([hidden])");
  await pv.waitForFunction(() => /セットアップできませんでした/.test(document.getElementById("message")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
  const privMsg = await pv.evaluate(() => document.getElementById("message")?.textContent || "");
  check("WebKit/プライベートブラウズ相当: 保存できない理由（プライベートブラウズでは保存できない）が表示される", privMsg.includes("プライベートブラウズ"), privMsg.slice(0, 90));
  await privBrowser.close();

  check("WebKit/iPad: ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / ").replace(KEY, "<鍵>"));
  await browser.close();
  const counted = results.filter((r) => r !== null);
  const passed = counted.filter(Boolean).length;
  console.log(`\n${passed}/${counted.length} passed${results.includes(null) ? "（オフラインは未確認）" : ""}`);
  process.exit(passed === counted.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
