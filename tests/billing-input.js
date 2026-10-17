// 請求人工入力（💴。業者管理・現場ダッシュボードから開く、日ごとに業者の行の請求人工を続けて入れる画面）を確かめる（架空データ・Chromium）。
//   ・保存先は既存の日報の請求人工（companies[].billingManDays）だけ。月の合計は既存の buildMonthlyBilling が日報から計算する
//   ・整数・小数・0・未入力（空欄）を区別。実績人数・作業時間などは変えない。稼働人数から計算しない
//   ・請求状況は既存の site.billingMonths（請求人工とは別）。過去の月の値は変わらない
//   ・現場掲示・A3・PDF・日報の印刷には出ない。バックアップ・復元・朝礼入力・業者管理は従来どおり
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-input-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  let dialogAnswer = true;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); dialogAnswer ? d.accept() : d.dismiss(); });
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "人工入力の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const other = await createSite({ name: "別の現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const c = (id, companyName, occupation, actual, billing, extra = {}) => ({ companyId: id, companyName, occupation, plannedWorkerCount: "4", actualWorkerCount: actual, workHours: "08:00～17:00", workContent: `${companyName}の作業`, billingManDays: billing, ...extra });
    const mk = async (siteId, date, dayStatus, companies) => { const r = stampNew({ siteId, date, dayStatus, siteSupervisorNames: [], companies }); await dbPut("reports", r); await new Promise((x) => setTimeout(x, 15)); return r.id; };
    return {
      siteId: site.id, otherSiteId: other.id,
      d28: await mk(site.id, "2026-09-28", "work", [c("a", "ナダカ工業", "外壁下地補修", "3", ""), c("a2", "ナダカ工業", "防水", "2", ""), c("b", "野本建装工業", "塗装", "2", "1.5"), c("c", "協栄工業", "足場", "4", "")]),
      d29: await mk(site.id, "2026-09-29", "work", [c("a", "ナダカ工業", "外壁下地補修", "3", "")]),
      d30: await mk(site.id, "2026-09-30", "rain", [c("b", "野本建装工業", "塗装", "", "")]),
      o01a: await mk(site.id, "2026-10-01", "work", [c("a", "ナダカ工業", "外壁下地補修", "2", "")]),
      o01b: await mk(site.id, "2026-10-01", "work", [c("x", "同日別日報工業", "内装", "1", "")]),
      otherSite: await mk(other.id, "2026-09-28", "work", [c("z", "別現場工業", "塗装", "5", "9")])
    };
  });
  const get = (id) => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), id);
  const nonBilling = (r) => JSON.stringify((r.companies || []).map(({ billingManDays, ...rest }) => rest));
  const before28 = await get(ids.d28);
  const otherBefore = JSON.stringify(await get(ids.otherSite));

  // ===== 1 業者管理から開く =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])"); await page.waitForTimeout(300);
  await page.selectOption("#vendorMgmtMonth", "2026-09"); await page.waitForTimeout(300);
  check("1 業者管理に「💴 請求人工入力」ボタン（押しやすい大きさ）", (await page.isVisible("#vendorMgmtBillingInputBtn")) && (await page.$eval("#vendorMgmtBillingInputBtn", (b) => b.getBoundingClientRect().height)) >= 44);
  await page.click("#vendorMgmtBillingInputBtn"); await page.waitForFunction(() => document.getElementById("billingDialog").open);
  check("1・2 開くと、表示している月（2026年9月・過去の月なので月末 9/30）の日が選ばれ、その月の集計が出る", (await page.inputValue("#billingDate")) === "2026-09-30" && (await page.textContent("#billingMonth")).includes("2026年9月の請求人工"));
  // 9/30 は雨天作業不可日でも入力できる
  check("雨天作業不可日（9/30）でも、業者から請求があれば入力できる（稼働に数えない日の表示つき）", (await page.textContent("#billingDay")).includes("雨天作業不可日") && (await page.locator("#billingDay .billing-value").count()) === 1);

  // ===== 2 日付を選ぶ（9/28）=====
  await page.fill("#billingDate", "2026-09-28"); await page.dispatchEvent("#billingDate", "change"); await page.waitForTimeout(300);
  const rows28 = await page.$$eval("#billingDay .billing-row", (rs) => rs.map((r) => `${r.querySelector(".chorei-vendor").textContent}/${r.querySelector(".chorei-trade").textContent}/${r.querySelector(".billing-value").value}/${r.querySelector(".billing-state").textContent}`));
  check("2・10 日付を選ぶとその日の業者の行（業者＋工種）が出る・保存済み（1.5）と未入力を区別して表示", rows28.join("|") === "ナダカ工業/外壁下地補修//未入力|ナダカ工業/防水//未入力|野本建装工業/塗装/1.5/1.5人工・保存済み|協栄工業/足場//未入力", rows28.join("|"));
  check("参考として稼働人数・稼働人工を出す（請求人工の計算には使わない）", (await page.textContent("#billingDay")).includes("稼働人数 3人・稼働人工 3"));

  // ===== 3・4・9 整数・小数を続けて入力（Enterで次の行へ）=====
  const inputs = page.locator("#billingDay .billing-value");
  await inputs.nth(0).click(); await page.keyboard.type("3"); await page.keyboard.press("Enter");
  await page.keyboard.type("0"); await page.keyboard.press("Enter");
  await page.keyboard.type("3.75"); await page.keyboard.press("Enter");
  const focused = await page.evaluate(() => [...document.querySelectorAll("#billingDay .billing-value")].indexOf(document.activeElement));
  check("9 Enter で次の業者の行へ移り、続けて入力できる", focused === 3);
  // 協栄工業は空欄のまま（未入力）
  check("未保存の変更がわかる（入力済み 3／4行・未保存の変更あり）", (await page.textContent("#billingProgress")).includes("入力済み 3／4行") && (await page.textContent("#billingProgress")).includes("未保存"));
  // 不正な値は保存しない
  await inputs.nth(3).fill("-1");
  await page.click("#billingSaveBtn"); await page.waitForTimeout(300);
  check("0以上の数でない値（-1）は保存しない", (await get(ids.d28)).companies[3].billingManDays === "");
  await inputs.nth(3).fill("");
  await page.click("#billingSaveBtn"); await page.waitForTimeout(500);
  let r28 = await get(ids.d28);
  check("3・4・5・7 保存: 整数3・0・小数3.75（既存の1.5を編集）が日報の請求人工に入る", r28.companies.map((c) => c.billingManDays).join(",") === "3,0,3.75,", r28.companies.map((c) => c.billingManDays).join(","));
  check("8 未入力（空欄）と0を区別して保存（協栄工業は空のまま・ナダカ工業の防水は「0」）", r28.companies[1].billingManDays === "0" && r28.companies[3].billingManDays === "");
  check("14 実績人数・予定人数・作業時間・作業内容など請求人工以外は変わらない", nonBilling(r28) === nonBilling(before28));
  const month = await page.textContent("#billingMonth");
  check("保存すると同じ画面の月の集計が更新される（ナダカ工業 3（3+0）・野本建装工業 3.75。協栄工業は未入力なので出ない）", /ナダカ工業\s*3\s*1日/.test(month) && /野本建装工業\s*3\.75\s*1日/.test(month) && !month.includes("協栄工業") && dialogs.length === 0, month.replace(/\s+/g, " ").slice(0, 160));
  // 小数2桁まで
  await inputs.nth(3).fill("1.255");
  check("小数は2桁まで（1.255 は誤りとして表示）", (await page.textContent("#billingDay .billing-row:nth-child(4) .billing-state")).includes("2桁"));
  await inputs.nth(3).fill("");

  // ===== 未入力の日へ移る =====
  const missingDays = await page.$$eval("#billingMonth [data-billing-date]", (bs) => bs.map((b) => b.dataset.billingDate));
  check("その月で請求人工が未入力の行がある日を出す（9/28 協栄工業・9/29・9/30）", missingDays.join() === "2026-09-28,2026-09-29,2026-09-30", missingDays.join());
  await page.click('#billingMonth [data-billing-date="2026-09-29"]'); await page.waitForTimeout(300);
  check("未入力の日を押すとその日へ移る", (await page.inputValue("#billingDate")) === "2026-09-29");
  // 未保存の変更があるときの確認
  await page.locator("#billingDay .billing-value").first().fill("2");
  dialogs.length = 0; dialogAnswer = false;
  await page.click('[data-billing-shift="-1"]'); await page.waitForTimeout(300); dialogAnswer = true;
  check("未保存の変更があると、日付を変える前に確認する（キャンセルでその日のまま）", dialogs.some((m) => m.includes("保存していない")) && (await page.inputValue("#billingDate")) === "2026-09-29");
  await page.click("#billingSaveBtn"); await page.waitForTimeout(400);

  // ===== 11 請求状況は請求人工と別 =====
  await page.selectOption('#billingMonth .billing-month-status[data-vendor="野本建装工業"]', "none"); await page.waitForTimeout(400);
  const siteAfter = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("sites", id), ids.siteId);
  r28 = await get(ids.d28);
  check("11 請求状況（野本建装工業＝請求なし）を保存しても、請求人工（3.75）は0にならない", siteAfter.billingMonths["2026-09"].vendors["野本建装工業"].status === "none" && r28.companies[2].billingManDays === "3.75");

  // ===== 12・13 翌月（10/1。同じ日に日報2件）=====
  await page.click('[data-billing-shift="1"]'); await page.waitForTimeout(200);
  await page.click('[data-billing-shift="1"]'); await page.waitForTimeout(300);
  check("同じ日に日報が2件ある日（10/1）は、入力する日報を選べる", (await page.inputValue("#billingDate")) === "2026-10-01" && (await page.locator("#billingDay .billing-report-select option").count()) === 2 && (await page.textContent("#billingMonth")).includes("2026年10月"));
  await page.selectOption("#billingDay .billing-report-select", ids.o01a); await page.waitForTimeout(200);
  await page.locator("#billingDay .billing-value").first().fill("5");
  await page.click("#billingSaveBtn"); await page.waitForTimeout(400);
  const sep = await page.evaluate(async (sid) => { const { buildMonthlyBilling } = await import("/js/billing/billingMonthly.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js"); return buildMonthlyBilling({ reports: await listReportsBySite(sid), site: await dbGet("sites", sid), month: "2026-09", today: "2026-10-17" }).rows.map((r) => `${r.vendor}:${r.manDays}:${r.status}`).join(","); }, ids.siteId);
  check("12・13 翌月（10/1）に入力しても、9月の請求人工・請求状況は変わらない", sep === "ナダカ工業:5:unconfirmed,野本建装工業:3.75:none", sep);
  const oct = await page.textContent("#billingMonth");
  check("10月の集計には10月の値だけ（月をまたいで足さない）", /ナダカ工業\s*5\s*1日/.test(oct) && !oct.includes("野本建装工業"), oct.replace(/\s+/g, " ").slice(0, 120));
  await page.click("#billingCloseBtn");
  await page.waitForTimeout(300);
  check("業者管理の請求人工管理に同じ値が出る（既存の集計とつながる）", await (async () => { await page.click('[data-vm-tab="billing"]'); await page.waitForTimeout(300); await page.selectOption("#vendorMgmtMonth", "2026-09"); await page.waitForTimeout(300); const t = await page.textContent("#vendorMgmtBody"); return t.includes("ナダカ工業") && t.includes("3.75"); })());

  // ===== 6 もう一度開くと保存した値が出る（ダッシュボードから）=====
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.evaluate((sid) => { window.__dashboardDate = { siteId: sid, date: "2026-09-28" }; }, ids.siteId);
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])"); await page.waitForTimeout(500);
  await page.click('#siteDashboard [data-action="billing"]'); await page.waitForFunction(() => document.getElementById("billingDialog").open);
  const again = await page.$$eval("#billingDay .billing-value", (xs) => xs.map((x) => x.value).join(","));
  check("1・6 現場ダッシュボードの「💴 請求人工入力」から、表示している日（9/28）で開き、保存した値が出る", (await page.inputValue("#billingDate")) === "2026-09-28" && again === "3,0,3.75,", again);
  await page.click("#billingCloseBtn");

  // ===== 15 現場掲示・A3・PDF・日報の印刷に請求人工は出ない =====
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
  const board = await page.textContent('#siteDashboard [data-panel="board"]');
  await page.click('#siteDashboard [data-action="print"]');
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const a3 = await page.$eval("#reportPrintFrame", (f) => f.srcdoc); await page.click("#reportPrintCloseBtn");
  const printHtml = await page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, ids.d28);
  const sheetText = a3.replace(/<script[\s\S]*?<\/script>/g, "");
  check("15 現場掲示（画面）・A3（PDF保存も同じHTML）・日報の印刷に「請求」と請求人工（3.75）が出ない", !board.includes("請求") && !board.includes("3.75") && !sheetText.includes("請求") && !sheetText.includes("3.75") && !String(printHtml).includes("請求") && !String(printHtml).includes("3.75"));

  // ===== 17 朝礼入力は従来どおり（請求人工は変えない）=====
  await page.click('#siteDashboard [data-action="chorei"]'); await page.waitForFunction(() => document.getElementById("choreiDialog").open);
  await page.locator("#choreiBody .chorei-count").first().fill("4");
  await page.click("#choreiSaveBtn"); await page.waitForTimeout(500);
  r28 = await get(ids.d28);
  check("17 朝礼入力で実績人数を変えても請求人工は変わらない（請求人工入力でも実績人数は変えない）", r28.companies[0].actualWorkerCount === "4" && r28.companies.map((c) => c.billingManDays).join(",") === "3,0,3.75,");
  check("別の現場の日報は変わらない", JSON.stringify(await get(ids.otherSite)) === otherBefore);

  // ===== 16 バックアップ・復元 =====
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await dl.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "billing-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("pageerror", (e) => errors.push(e.message)); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async (id) => !!(await (await import("/js/db.js")).dbGet("reports", id)), ids.o01a, { timeout: 20000 });
  const restored = await p3.evaluate(async ([a, b, s]) => { const { dbGet } = await import("/js/db.js"); return { a: (await dbGet("reports", a)).companies.map((c) => c.billingManDays).join(","), b: (await dbGet("reports", b)).companies[0].billingManDays, st: (await dbGet("sites", s)).billingMonths["2026-09"].vendors["野本建装工業"].status }; }, [ids.d28, ids.o01a, ids.siteId]);
  check("16 バックアップから別の端末に復元しても、請求人工（9月・10月）と請求状況はそのまま", restored.a === "3,0,3.75," && restored.b === "5" && restored.st === "none", JSON.stringify(restored));
  await ctx2.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
