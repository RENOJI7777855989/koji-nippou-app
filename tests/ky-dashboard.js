// 危険予知活動表（DB v10）と、現場ダッシュボードの「現場掲示」「監督管理」の分離を確認する（架空データ・Chromium）。
//   ・DB v9 → v10 の移行（既存データが変わらない・新しい保存場所ができる）
//   ・日報が無い日でも登録できる・前の作業日の業者は候補として出るだけ（押した業者だけ対象）・日報に無い業者も登録できる
//   ・提出済／未提出／対象外の切り替え、提出済にした時刻の自動記録（未提出・対象外で消える）
//   ・日報を後から作っても危険予知活動表は変わらない（日報の提出＝KYの提出、とは扱わない）
//   ・現場掲示・A3に提出状況（時刻なし）、A3に日誌状況などの監督向け情報・請求人工が無い
//   ・監督管理の今日の確認事項に「危険予知活動表 未提出」、日報カレンダーは「日報なし」のまま
//   ・バックアップ・復元に含まれる、工事完了の現場は変更できない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ky-dashboard-"));
  // Service Worker を止める（移行の確認で、ページの db.js を v9 のものに差し替えるため）
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 }, serviceWorkers: "block" });
  const errors = [];

  // ---- 1・2 DB v9 → v10 の移行 ----
  const dbV9 = fs.readFileSync(path.join(__dirname, "..", "js", "db.js"), "utf8")
    .replace("const DB_VERSION = 10;", "const DB_VERSION = 9;")
    .replace(/\n\s*\/\/ DB v10:[\s\S]*?if \(!db\.objectStoreNames\.contains\("kySubmissions"\)\) \{[\s\S]*?\n\s*\}\n/, "\n");
  if (dbV9.includes("kySubmissions") || !dbV9.includes("DB_VERSION = 9")) throw new Error("v9 の db.js を作れませんでした");
  const old = await ctx.newPage();
  old.on("pageerror", (e) => errors.push(e.message));
  await old.route("**/js/db.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: dbV9 }));
  await old.goto(BASE); await old.waitForSelector("#view-site-list:not([hidden])");
  const ids = await old.evaluate(async () => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { createSite } = await import("/js/sites.js");
    const site = await createSite({ name: "KY確認現場", startDate: "2026-09-20", endDate: "2026-10-31" });
    const r = stampNew({ siteId: site.id, date: "2026-09-28", dayStatus: "work", progressPercent: 20,
      companies: [{ companyId: "a", companyName: "サンプル工業", occupation: "とび", actualWorkerCount: "3", workHours: "08:00～17:00", billingManDays: "2.5" }, { companyId: "b", companyName: "サンプル設備", occupation: "配管工", actualWorkerCount: "2", workHours: "08:00～17:00" }] });
    await dbPut("reports", r);
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 40; c.height = 20; c.toBlob(res, "image/png"); });
    await dbPut("photos", stampNew({ reportId: r.id, siteId: site.id, blob: png, mimeType: "image/png", order: 0, caption: "" }));
    await dbPut("signatures", stampNew({ reportId: r.id, companyId: "a", role: "foreman", imageBlob: png }));
    const db = await (await import("/js/db.js")).openDb();
    return { siteId: site.id, prevReportId: r.id, version: db.version, stores: [...db.objectStoreNames] };
  });
  const dump = (p) => p.evaluate(async () => {
    const { dbGetAll } = await import("/js/db.js"); const o = {};
    for (const s of ["sites", "reports", "photos", "signatures", "reportTemplates"]) o[s] = (await dbGetAll(s)).map((r) => JSON.stringify(r, (k, v) => (v instanceof Blob ? `blob:${v.size}` : v))).sort();
    return JSON.stringify(o);
  });
  const beforeMigrate = await dump(old);
  await old.close();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const migrated = await page.evaluate(async () => { const db = await (await import("/js/db.js")).openDb(); return { version: db.version, ky: db.objectStoreNames.contains("kySubmissions") }; });
  check("1 DB v9 → v10 の移行: 版が10になり、危険予知活動表の保存場所（kySubmissions）ができる", ids.version === 9 && !ids.stores.includes("kySubmissions") && migrated.version === 10 && migrated.ky, JSON.stringify(migrated));
  check("2 移行の前後で既存データ（現場・日報・写真・署名・テンプレート）が変わらない", (await dump(page)) === beforeMigrate);

  // ---- 3〜5・9 日報の無い日（9/29）に、監督管理で対象業者を選ぶ ----
  const D = "2026-09-29";
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", D); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  const chips = await page.$$eval("#siteDashboard .dash-ky-add", (els) => els.map((e) => e.dataset.kyAdd));
  const kyCount0 = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).length);
  check("4 日報が無い日: 前の作業日（9/28）の業者が候補として出る（まだ対象には入っていない）", chips.join() === "サンプル工業,サンプル設備" && kyCount0 === 0 && (await page.textContent("#siteDashboard .dash-ky")).includes("前の作業日（9/28）"), chips.join());
  await page.click("#siteDashboard .dash-ky-add[data-ky-add='サンプル工業']");
  await page.waitForSelector("#siteDashboard .dash-ky-table");
  await page.fill("#siteDashboard .dash-ky-name", "  新規塗装  "); await page.click("#siteDashboard .dash-ky-form button[type=submit]");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).length === 2);
  await page.waitForTimeout(300);
  let recs = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).sort((a, b) => a.order - b.order));
  const reportsOn = async (date) => page.evaluate(async ({ sid, date }) => (await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.siteId === sid && r.date === date).length, { sid: ids.siteId, date });
  check("3 日報が無い日でも危険予知活動表を登録できる（日報は作られない）", recs.length === 2 && recs.every((r) => r.date === D && r.siteId === ids.siteId) && (await reportsOn(D)) === 0);
  check("5 監督が押した業者だけが対象になる（押していないサンプル設備は登録されない）・未提出で登録", recs[0].vendorName === "サンプル工業" && recs[0].target === true && recs[0].submitted === false && recs[0].submittedAt === null && !recs.some((r) => r.vendorName === "サンプル設備"));
  check("9 日報に無い業者（新規塗装）も業者名で登録できる（前後の空白は除く）", recs[1].vendorName === "新規塗装");
  await page.fill("#siteDashboard .dash-ky-name", "新規塗装"); await page.click("#siteDashboard .dash-ky-form button[type=submit]"); await page.waitForTimeout(400);
  check("同じ日に同じ業者名は二重に登録しない", (await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).length)) === 2);

  // ---- 6・7 提出済／未提出／対象外、提出時刻の自動記録 ----
  const t0 = Date.now();
  await page.click(`#siteDashboard [data-ky-id="${recs[0].id}"][data-ky-state="submitted"]`);
  await waitForAsync(page, async (id) => (await (await import("/js/db.js")).dbGet("kySubmissions", id)).submitted === true, recs[0].id);
  await page.waitForTimeout(300);
  let r0 = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("kySubmissions", id), recs[0].id);
  const at = new Date(r0.submittedAt).getTime();
  const shown = await page.$eval(`#siteDashboard .dash-ky-table tr.ky-submitted td.num`, (td) => td.textContent.trim());
  const hm = (() => { const d = new Date(r0.submittedAt); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; })();
  check("7 「提出済」を押した時刻が提出時刻として自動で記録され、表に時:分で出る", r0.target === true && at >= t0 - 1000 && at <= Date.now() + 1000 && shown === hm, `${r0.submittedAt} 表示${shown}`);
  await page.click(`#siteDashboard [data-ky-id="${recs[0].id}"][data-ky-state="submitted"]`); await page.waitForTimeout(400);
  const again = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("kySubmissions", id), recs[0].id);
  check("提出済をもう一度押しても最初の提出時刻は変わらない", again.submittedAt === r0.submittedAt);
  await page.click(`#siteDashboard [data-ky-id="${recs[1].id}"][data-ky-state="excluded"]`); await page.waitForTimeout(400);
  await page.click(`#siteDashboard [data-ky-id="${recs[1].id}"][data-ky-state="not_submitted"]`); await page.waitForTimeout(400);
  let r1 = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("kySubmissions", id), recs[1].id);
  check("6 提出済／未提出／対象外を切り替えられる（対象外→未提出）・未提出は提出時刻なし", r1.target === true && r1.submitted === false && r1.submittedAt === null);
  await page.click(`#siteDashboard [data-ky-id="${recs[0].id}"][data-ky-state="not_submitted"]`); await page.waitForTimeout(400);
  r0 = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("kySubmissions", id), recs[0].id);
  check("6 提出済み→未提出に戻すと提出時刻の表示は消えるが、提出済みにした時刻は変更履歴に残る", r0.submitted === false && r0.submittedAt === null && r0.history.some((h) => h.state === "submitted" && h.at === again.submittedAt) && r0.history.at(-1).state === "not_submitted", JSON.stringify(r0.history.map((h) => h.state)));
  const shownNot = await page.$eval(`#siteDashboard .dash-ky-table tr.ky-not_submitted td.num`, (td) => td.textContent.trim());
  check("6 未提出の業者の提出時刻は「—」", shownNot === "—");
  await page.click(`#siteDashboard [data-ky-id="${recs[0].id}"][data-ky-state="submitted"]`); await page.waitForTimeout(400);

  // ---- 12・13 監督管理の今日の確認事項（日報なしの日）----
  const manage = (await page.textContent("#siteDashboard .dash-panel[data-panel=manage]")).replace(/\s+/g, " ");
  const att = await page.$$eval("#siteDashboard .dash-attention li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
  check("12 監督管理に今日の確認事項（日報 未入力）と危険予知活動表の集計（対象2・提出済み1・未提出1・対象外0）・未提出の意味の説明が出る", manage.includes("今日の確認事項") && att.includes("日報 未入力") && manage.includes("対象 2業者") && manage.includes("提出済み 1業者") && manage.includes("未提出 1業者") && manage.includes("対象外 0業者") && manage.includes("未提出: 新規塗装") && manage.includes("紙がまだ提出されていない"), att.join(" / "));
  check("13 今日の確認事項・要確認に「危険予知活動表 未提出 1業者（新規塗装）」", att.some((a) => a.startsWith("危険予知活動表 未提出 1業者（新規塗装）")), att.join(" / "));

  // ---- 14 日報カレンダー: KYだけの日は「日報なし」のまま ----
  // 日報カレンダーは監督管理タブの中（表示は今月なので、前の月へ移る）
  check("日報カレンダーが監督管理タブの中にある", await page.evaluate(() => !!document.querySelector("#siteDashboard .dash-panel[data-panel=manage] #reportCalendar")));
  for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="${D}"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  const calCls = await page.$eval(`#reportCalendar .cal-cell[data-date="${D}"]`, (b) => b.className);
  check("14 日報カレンダー: 危険予知活動表だけ登録した日は「日報なし」（作業なし・日報ありにならない）", /\bcal-none\b/.test(calCls), calCls);

  // ---- 10・11 現場掲示・A3 ----
  await page.click("#siteDashboard .dash-tab[data-tab=board]");
  const board = (await page.textContent("#siteDashboard .dash-panel[data-panel=board]")).replace(/\s+/g, " ");
  check("10 現場掲示に本日の危険予知活動表（サンプル工業 ✓ 提出済み・新規塗装 未提出）。時刻・監督向けの確認事項は出さない", board.includes("サンプル工業 ✓ 提出済み") && board.includes("新規塗装 未提出") && !/\d{1,2}:\d{2}/.test(board.split("本日の危険予知活動表")[1] || "") && !board.includes("今日の確認事項") && !board.includes("日誌状況"), board.slice(-160));
  const sheet = await page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const { dbGetAll, dbGet } = await import("/js/db.js"); const { listKySubmissions } = await import("/js/ky/kySubmissions.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    return buildTodaySheetHtml(buildDashboardModel({ site, reports, signatures: await dbGetAll("signatures"), date, kySubmissions: await listKySubmissions(sid, date) }));
  }, { sid: ids.siteId, date: D });
  check("10 A3に「本日の危険予知活動表」（サンプル工業 ✓ 提出済み・新規塗装 未提出・提出済み1／対象2）", sheet.includes("本日の危険予知活動表") && sheet.includes("サンプル工業 ✓ 提出済み") && sheet.includes("新規塗装 未提出") && sheet.includes("提出済み 1／対象 2業者"));
  check("11 A3に監督向けの日誌状況（提出予定・未提出の日数・未署名・未承認・未印刷）・請求人工が無い", !sheet.includes("日誌状況") && !sheet.includes("未承認") && !sheet.includes("未印刷") && !sheet.includes("未署名") && !sheet.includes("提出予定") && !sheet.includes("請求"));
  const sheetPrev = await page.evaluate(async ({ sid }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const { dbGetAll, dbGet } = await import("/js/db.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    const r = reports.find((x) => x.date === "2026-09-28"); r.focusInstructions = "開口部の養生確認";
    return buildTodaySheetHtml(buildDashboardModel({ site, reports, signatures: [], date: "2026-09-28", kySubmissions: [] }));
  }, { sid: ids.siteId });
  check("A3: 本日の重点指示の欄・業者ごとの人工（稼働人数3→3）があり、請求人工2.5は載らない", sheetPrev.includes("<h2>本日の重点指示</h2>") && sheetPrev.includes("開口部の養生確認") && sheetPrev.includes("<th>人工</th>") && sheetPrev.includes('<td class="c"> / 3</td><td class="c">3</td>') && !sheetPrev.includes("2.5"));
  // A3が1枚に収まる（各欄の文字が切れていない）
  const p2 = await ctx.newPage(); await p2.setContent(sheet); await p2.waitForTimeout(300);
  const fit = await p2.evaluate(() => { dispatchEvent(new Event("beforeprint")); return [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1).length; });
  const pdf = Buffer.from(await p2.pdf({ preferCSSPageSize: true })).toString("latin1"); await p2.close();
  check("A3横・1ページで、欄から文字があふれていない", fit === 0 && (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf), `あふれ${fit}`);

  // ---- 対象外: 掲示・A3には出さず、監督管理で数える ----
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  await page.fill("#siteDashboard .dash-ky-name", "対象外工業"); await page.click("#siteDashboard .dash-ky-form button[type=submit]");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).length === 3);
  await page.waitForTimeout(300);
  const exId = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).find((r) => r.vendorName === "対象外工業").id);
  await page.click(`#siteDashboard [data-ky-id="${exId}"][data-ky-state="excluded"]`); await page.waitForTimeout(400);
  const manage2 = (await page.textContent("#siteDashboard .dash-panel[data-panel=manage]")).replace(/\s+/g, " ");
  const board2 = (await page.textContent("#siteDashboard .dash-panel[data-panel=board]")).replace(/\s+/g, " ");
  const sheet2 = await page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const { dbGetAll, dbGet } = await import("/js/db.js"); const { listKySubmissions } = await import("/js/ky/kySubmissions.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    return buildTodaySheetHtml(buildDashboardModel({ site, reports, signatures: [], date, kySubmissions: await listKySubmissions(sid, date) }));
  }, { sid: ids.siteId, date: D });
  check("7 対象外: 監督管理では「対象外 1業者」と表に出て、対象の数（2）には入らない。現場掲示・A3には出さない", manage2.includes("対象外 1業者") && manage2.includes("対象 2業者") && manage2.includes("対象外工業") && !board2.includes("対象外工業") && !sheet2.includes("対象外工業"));

  // ---- 8 日報を後から作っても危険予知活動表は変わらない／日報の確認とは連動しない ----
  const kyBefore = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("kySubmissions")).sort((a, b) => a.id.localeCompare(b.id))));
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${D}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.locator(".company-row").nth(0).locator(".companyName").fill("サンプル工業");
  await page.locator(".company-row").nth(0).locator(".actualWorkerCount").fill("3");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const newReport = await page.evaluate(async ({ sid, D }) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === D), { sid: ids.siteId, D });
  const kyAfter = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("kySubmissions")).sort((a, b) => a.id.localeCompare(b.id))));
  check("8 日報を後から作成しても、先に登録した危険予知活動表は変わらない", !!newReport && kyAfter === kyBefore);
  await page.fill("#siteDashboard .dash-date-input", D); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  const att2 = await page.$$eval("#siteDashboard .dash-attention li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
  check("日報がある日も、危険予知活動表の未提出は日報とは別に要確認に出る（日報入力済み＝KY提出済みとしない）", att2.some((a) => a.startsWith("危険予知活動表 未提出 1業者（新規塗装）")) && !att2.includes("日報 未入力"), att2.join(" / "));

  // ---- バックアップ・復元に含まれる ----
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await dl.saveAs(zipPath);
  const zipHasKy = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const zip = loadZip(u.buffer);
    return JSON.parse((await readZipEntryText(zip, "data/kySubmissions.json")) || "[]").length;
  }, fs.readFileSync(zipPath).toString("base64"));
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ky-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("pageerror", (e) => errors.push(e.message)); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).length === 3, null, { timeout: 20000 });
  const restored = await p3.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("kySubmissions")).sort((a, b) => a.id.localeCompare(b.id))));
  check("バックアップに危険予知活動表が含まれ、別の端末に復元すると同じ内容（提出時刻・変更履歴を含む）", zipHasKy === 3 && restored === kyAfter);
  await ctx2.close();

  // ---- 工事完了の現場は変更できない ----
  await page.goto(BASE);
  const blocked = await page.evaluate(async ({ sid, id }) => {
    const { completeSite } = await import("/js/sites.js"); const { setKyState, addKyVendor } = await import("/js/ky/kySubmissions.js");
    await completeSite(sid);
    const errs = [];
    try { await setKyState(id, "excluded"); } catch (e) { errs.push(e.message); }
    try { await addKyVendor({ siteId: sid, date: "2026-09-30", vendorName: "X" }); } catch (e) { errs.push(e.message); }
    return errs;
  }, { sid: ids.siteId, id: recs[0].id });
  check("工事完了の現場では危険予知活動表を変更・追加できない", blocked.length === 2 && blocked.every((m) => m.includes("工事完了")), blocked.join(" / "));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
