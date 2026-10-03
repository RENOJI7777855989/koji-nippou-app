// 業者管理（#/sites/:id/vendors）の［業者別稼働］［請求人工管理］を確かめる（架空データ・Chromium）。
//   ・業者別稼働: 通常作業の日に稼働人数1人以上の日＝稼働日、稼働人数・実績人工（1人＝1人工）・作業時間。請求人工は使わない
//   ・請求人工管理: その月に請求人工を入力した業者だけ・入力値だけの合計・入力日数・請求状況（別管理）・請求あり・請求人工未入力
//   ・業者を押すと日別（稼働日と請求人工の入力日を区別）・日付から既存の日報へ。月を切り替えても混ざらない・過去月は残る
//   ・請求人工を変えても稼働実績・03-2・A3・日報の他の値は変わらない。現場ダッシュボードには請求を出さない。バックアップ・復元で保持
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-mgmt-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const ids = await page.evaluate(async (today) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "業者管理の確認現場", startDate: "2026-08-01", endDate: "2026-12-31" });
    const row = (id, name, trade, n, hours, billing) => ({ companyId: id, companyName: name, occupation: trade, actualWorkerCount: String(n), workHours: hours, billingManDays: billing });
    const mk = (date, companies, dayStatus = "work") => stampNew({ siteId: site.id, date, dayStatus, companies, siteSupervisorNames: [] });
    const plusDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const H = "08:00～17:00";
    const list = [
      mk("2026-08-01", [row("a1", "ナダカ工業", "塗装", 3, H, "2.0"), row("k1", "協栄工業", "足場", 3, H, "")]),
      mk("2026-08-05", [row("a2", "ナダカ工業", "外壁下地補修", 3, H, "3.5"), row("a3", "ナダカ工業", "防水", 1, "08:00～12:00", "1.0")]),
      mk("2026-08-10", [row("a4", "ナダカ工業", "塗装", 4, H, "4.0"), row("n1", "野本建装工業", "塗装", 3, H, "")]),
      mk("2026-08-12", [row("a5", "ナダカ工業", "塗装", 0, "", "")]), // 稼働人数0 → 稼働日にしない
      mk("2026-08-15", [row("a6", "ナダカ工業", "塗装", 2, "08:30～17:00", "")]), // 請求人工は未入力
      mk("2026-08-20", [row("a7", "ナダカ工業", "塗装", 2, H, "5.0")], "rain"), // 雨天作業不可日（稼働に数えない・請求人工は入力されている）
      mk("2026-08-31", [row("a8", "ナダカ工業", "塗装", 3, H, "3.0")]),
      mk("2026-09-01", [row("a9", "ナダカ工業", "塗装", 2, H, "2.0")]),
      mk("2026-09-05", [row("a10", "ナダカ工業", "塗装", 3, H, "3.0"), row("s1", "西原建設", "足場", 2, H, "")]),
      mk(`${today.slice(0, 7)}-01`, [row("a11", "ナダカ工業", "塗装", 2, H, "1.5")]),
      mk(plusDays(today, 2), [row("a12", "ナダカ工業", "塗装", 9, H, "9.0")]) // 未来の日付
    ];
    for (const r of list) await dbPut("reports", r);
    return { siteId: site.id, aug10: list[2].id, aug1: list[0].id };
  }, today);
  const reportsBefore = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.date, r.dayStatus, r.companies])));

  // ---- 入口: 現場詳細の「業者管理」----
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  const dashText = await page.textContent("#view-site-detail");
  check("23 現場ダッシュボード（現場詳細）には請求人工・請求状況を出さない", !dashText.includes("請求"));
  await page.click("#vendorMgmtBtn"); await page.waitForSelector("#view-vendor-management:not([hidden])");
  const head = await page.evaluate(() => ({ month: document.getElementById("vendorMgmtMonth").value, tabs: [...document.querySelectorAll("[data-vm-tab]")].map((b) => b.textContent.trim()), active: document.querySelector("[data-vm-tab].is-active")?.dataset.vmTab }));
  check("1 業者管理: 対象年月（今月）と［業者別稼働］［請求人工管理］、最初は業者別稼働", head.month === today.slice(0, 7) && head.tabs.join() === "業者別稼働,請求人工管理" && head.active === "activity", JSON.stringify(head));

  const selectMonth = async (m) => { await page.selectOption("#vendorMgmtMonth", m); await page.waitForTimeout(200); };
  const tab = async (t) => { await page.click(`[data-vm-tab="${t}"]`); await page.waitForTimeout(200); };
  const tableRows = (sel) => page.$$eval(`#vendorMgmtBody ${sel} tbody tr`, (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ""))));

  // ---- 2〜8 業者別稼働（8月）----
  await selectMonth("2026-08");
  const act = await tableRows(".vm-activity");
  const actMap = Object.fromEntries(act.map((r) => [r[0].replace(/(塗装|外壁下地補修|防水|足場|・)+$/, ""), r.slice(1).join("|")]));
  check("2〜6 8月の業者別稼働: ナダカ工業 5日・16人・16・48時間30分（8/1・8/5・8/10・8/15・8/31）、協栄工業 1日・3人・3・9時間、野本建装工業 1日・3人・3・9時間", actMap["ナダカ工業"] === "5日|16人|16|48時間30分" && actMap["協栄工業"] === "1日|3人|3|9時間" && actMap["野本建装工業"] === "1日|3人|3|9時間", JSON.stringify(actMap));
  check("8 稼働人数0の日（8/12）・雨天作業不可日（8/20）は稼働日にしない（ナダカ工業は5日）", actMap["ナダカ工業"]?.startsWith("5日|16人"));
  await page.click(`#vendorMgmtBody [data-vm-vendor="ナダカ工業"]`); await page.waitForTimeout(300);
  const det = await page.evaluate(() => ({ title: document.querySelector(".vm-detail-title")?.textContent, days: [...document.querySelectorAll("#vendorMgmtBody .vm-days tbody tr")].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|")), summary: document.querySelector(".vm-summary")?.textContent.replace(/\s+/g, "") }));
  check("7 業者を押すと「ナダカ工業・2026年8月」の日別の稼働（実際に稼働した5日だけ・人数・作業時間）", det.title === "ナダカ工業・2026年8月" && det.days.length === 5 && det.days[0].startsWith("8/1|通常作業|稼働3人|08:00～17:00") && det.days[1].startsWith("8/5|通常作業|稼働4人") && !det.days.some((d) => d.startsWith("8/12") || d.startsWith("8/20")) && det.summary.includes("稼働日5日") && det.summary.includes("稼働人数（延べ）16人") && !det.summary.includes("請求"), det.days.join(" / "));
  await page.click(`#vendorMgmtBody .vm-report >> nth=0`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  check("7 日付を押すと既存の日報の画面（8/1）が開く", (await page.inputValue("#date")) === "2026-08-01");
  await page.goto(`${BASE}#/sites/${ids.siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])");
  await page.click(".vm-back").catch(() => {});
  await page.waitForTimeout(200);

  // ---- 9〜16 請求人工管理（8月）----
  await selectMonth("2026-08"); await tab("billing");
  const bill = await tableRows(".billing-table");
  check("9〜11 請求人工管理（8月）: 請求人工を入力したナダカ工業だけ・入力値だけの合計 2.0+3.5+1.0+4.0+5.0+3.0＝18.5人工・入力日数5日", bill.length === 1 && bill[0][0] === "ナダカ工業" && bill[0][1] === "18.5人工" && bill[0][2] === "5日" && bill[0][3].includes("未確認"), JSON.stringify(bill));
  check("10・12・13 協栄工業・野本建装工業（稼働・作業時間はあるが請求人工未入力）は表示しない・稼働から請求人工を作らない", !bill.some((r) => /協栄|野本/.test(r[0])) && bill[0][1] !== "16人工");
  await page.click(`#vendorMgmtBody [data-vm-vendor="ナダカ工業"]`); await page.waitForTimeout(300);
  const bdet = await page.evaluate(() => ({ days: [...document.querySelectorAll("#vendorMgmtBody .vm-days tbody tr")].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|")), summary: document.querySelector(".vm-summary")?.textContent.replace(/\s+/g, "") }));
  check("14〜16 請求人工管理の詳細: 稼働日と請求人工の入力日を区別（8/15 稼働2人・請求未入力、8/20 雨天作業不可日・稼働なし・請求5）", bdet.days.some((d) => d.startsWith("8/1|通常作業|稼働3人") && d.endsWith("請求2")) && bdet.days.some((d) => d.startsWith("8/15|通常作業|稼働2人") && d.endsWith("請求未入力")) && bdet.days.some((d) => d.startsWith("8/20|雨天作業不可日|稼働なし") && d.endsWith("請求5")) && !bdet.days.some((d) => d.startsWith("8/12")), bdet.days.join(" / "));
  check("15 詳細の集計: 稼働日5日・延べ16人・実績人工16・請求人工18.5人工・請求人工の入力日5日・請求状況 未確認", bdet.summary.includes("稼働日5日") && bdet.summary.includes("稼働人数（延べ）16人") && bdet.summary.includes("実績人工16") && bdet.summary.includes("請求人工18.5人工") && bdet.summary.includes("請求人工の入力日5日") && bdet.summary.includes("請求状況未確認"), bdet.summary);
  await page.click(".vm-back"); await page.waitForTimeout(200);

  // ---- 19・20 請求状況 ----
  await page.selectOption(`#vendorMgmtBody .billing-status[data-billing-vendor="ナダカ工業"]`, "billed");
  await page.waitForFunction(() => document.querySelector(`#vendorMgmtBody .billing-status[data-billing-vendor="ナダカ工業"]`)?.value === "billed"); await page.waitForTimeout(300);
  await page.evaluate(async (sid) => { const { setBillingStatus } = await import("/js/billing/billingMonthly.js"); await setBillingStatus(sid, "2026-08", "協栄工業", "billed"); }, ids.siteId);
  await page.selectOption("#vendorMgmtMonth", "2026-09"); await page.selectOption("#vendorMgmtMonth", "2026-08"); await page.waitForTimeout(300);
  const aug2 = await page.evaluate(() => ({ text: document.getElementById("vendorMgmtBody").textContent.replace(/\s+/g, " "), st: document.querySelector(`.billing-status[data-billing-vendor="ナダカ工業"]`)?.value, rows: document.querySelectorAll("#vendorMgmtBody .billing-table tbody tr").length }));
  check("19 請求状況は請求人工と別に保存（ナダカ工業 請求あり・請求人工18.5はそのまま）", aug2.st === "billed" && aug2.text.includes("請求あり 1社") && aug2.text.includes("18.5人工"));
  check("20 請求状況だけ「請求あり」で請求人工未入力の協栄工業は一覧に出さず「請求あり・請求人工未入力：協栄工業」と表示", aug2.rows === 1 && aug2.text.includes("請求あり・請求人工未入力：協栄工業"));

  // ---- 17・18 月の切り替え ----
  await selectMonth("2026-09");
  const sep = await tableRows(".billing-table");
  check("17 9月: 9月に入力した値だけ（ナダカ工業 2.0+3.0＝5人工・8月と混ざらない）・西原建設は出ない・請求状況は未確認", sep.length === 1 && sep[0][0] === "ナダカ工業" && sep[0][1] === "5人工" && sep[0][3].includes("未確認"), JSON.stringify(sep));
  await page.click(`.vm-month-nav[data-shift="1"]`); await page.waitForTimeout(200);
  if ((await page.inputValue("#vendorMgmtMonth")) !== today.slice(0, 7)) await selectMonth(today.slice(0, 7));
  const cur = await tableRows(".billing-table");
  check("今月: 今日より後の日報（9.0）は入れない（1.5人工）", cur.length === 1 && cur[0][1] === "1.5人工", JSON.stringify(cur));
  await selectMonth("2026-08");
  const aug3 = await tableRows(".billing-table");
  check("18 8月に戻ると8月の請求人工（18.5）・請求状況（請求あり）が残っている", aug3[0][1] === "18.5人工" && (await page.$eval(`.billing-status[data-billing-vendor="ナダカ工業"]`, (s) => s.value)) === "billed");

  // ---- 21〜23 請求人工を変えても実績・03-2・A3は変わらない ----
  const sheetOf = async (id, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (rid) => (await import("/js/reportPrint.js")).exportReportExcel(rid), id)]);
    const f = path.join(dir, name); await dl.saveAs(f);
    return page.evaluate(async (b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[0];
      const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
      const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
      return JSON.stringify([...L.cells].filter(([, c]) => c.text).map(([r, c]) => [r, c.text]));
    }, fs.readFileSync(f).toString("base64"));
  };
  const a3Of = (date) => page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((r) => r.siteId === sid), signatures: [], date, kySubmissions: [] }));
  }, { sid: ids.siteId, date });
  const x0 = await sheetOf(ids.aug10, "x0.xlsx"); const a30 = await a3Of("2026-08-10");
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].billingManDays = "2.0"; await dbPut("reports", r); }, ids.aug10);
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/sites/${ids.siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])");
  await selectMonth("2026-08"); await tab("billing");
  const aug4 = await tableRows(".billing-table");
  await tab("activity");
  const act2 = await tableRows(".vm-activity");
  check("請求人工を 4.0→2.0 に変えると請求人工の合計だけ変わる（18.5→16.5）", aug4[0][1] === "16.5人工");
  check("21 請求人工を変えても業者別稼働（ナダカ工業 5日・16人・16・48時間30分）は変わらない", act2.find((r) => r[0].startsWith("ナダカ工業"))?.slice(1).join("|") === "5日|16人|16|48時間30分");
  check("22 請求人工を変えても03-2（1日分のExcel）は変わらない", (await sheetOf(ids.aug10, "x1.xlsx")) === x0);
  const a31 = await a3Of("2026-08-10");
  check("23 請求人工を変えてもA3は変わらない・A3に請求の情報は無い", a31 === a30 && !a31.includes("請求"));
  const reportsNow = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.date, r.dayStatus, r.companies])));
  const expected = JSON.stringify(JSON.parse(reportsBefore).map(([id, date, st, cs]) => [id, date, st, cs.map((c) => (id === ids.aug10 && c.companyId === "a4" ? { ...c, billingManDays: "2.0" } : c))]));
  check("24 既存の日報は変わらない（試験で直した請求人工1件だけ）・請求状況を変えても日報は変わらない", reportsNow === expected);

  // ---- 25 バックアップ・復元 ----
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "vendor-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 11, null, { timeout: 20000 });
  const restored = await p3.evaluate(async (sid) => {
    const { dbGetAll, dbGet } = await import("/js/db.js"); const { buildMonthlyBilling } = await import("/js/billing/billingMonthly.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    const pick = (m) => { const b = buildMonthlyBilling({ reports, site, month: m, today: "2026-12-31" }); return b.rows.map((r) => `${r.vendor}:${r.manDays}:${r.status}:${r.enteredDays}`).join() + `|${b.billedWithoutManDays.join()}`; };
    return { aug: pick("2026-08"), sep: pick("2026-09") };
  }, ids.siteId);
  check("25 バックアップ→復元で請求人工（8月16.5・9月5）・請求状況・入力日数が保たれる", restored.aug === "ナダカ工業:16.5:billed:5|協栄工業" && restored.sep === "ナダカ工業:5:unconfirmed:2|", JSON.stringify(restored));
  await ctx2.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
