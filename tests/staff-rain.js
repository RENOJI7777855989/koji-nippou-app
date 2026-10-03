// 日付ステータス（通常作業／現場作業なし／休工日／雨天作業不可日／事務作業日）と、現場作業員・監督/職員の稼働人数を確かめる（架空データ・Chromium）。
//   ・現場作業なし・雨天作業不可日・事務作業日: 現場作業員0人・監督/職員は入力できる。休工日: 完全休工で両方0人（入力欄を出さない）
//   ・雨天作業不可日: 中止となった予定作業（必須）・中止理由・天気（推測しない）・監督/職員の人数と作業内容を記録
//   ・監督/職員は03-2の稼動人数表の「社員」行（O50・P50）に入り、計（O51）・延労働時間（O52）に含まれる。業者の行には混ぜない
//   ・人工は1人＝1人工（請求人工ではない。請求人工を変えても03-2は変わらない）。巡回点検の斜線は雨天作業不可日にも
//   ・工期経過・着工○日目は通常どおり進む。現場掲示（A3）に雨天作業不可日と中止予定作業。バックアップ・復元で保持
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staff-rain-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 工期 9/1〜9/30・着工日 9/1（日報カレンダーで押せるよう過去の日付）。9/8 は以前のデータを想定した休工日（監督の氏名2名・人数2が保存されている）
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "稼働人数の確認現場", startDate: "2026-09-01", endDate: "2026-09-30", actualStartDate: "2026-09-01" });
    const legacy = stampNew({ siteId: site.id, date: "2026-09-08", dayStatus: "holiday", companies: [], siteSupervisorNames: ["監督A", "監督B"], staffCount: 2, weather: "晴れ" });
    await dbPut("reports", legacy);
    return { siteId: site.id, legacy: legacy.id };
  });
  // 出力すると出力日時が日報に記録される（既存の仕様）ので、内容の項目だけを比べる
  const legacyContent = (id) => page.evaluate(async (id) => { const r = await (await import("/js/db.js")).dbGet("reports", id); return JSON.stringify([r.dayStatus, r.siteSupervisorNames, r.staffCount, r.companies, r.weather]); }, id);
  const legacyBefore = await legacyContent(ids.legacy);
  const getReport = (date) => page.evaluate(async ({ sid, date }) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === date), { sid: ids.siteId, date });

  // ---- 1・11 通常作業（日報の入力画面）: 業者A 3人（請求人工1.5）・業者B 4人・監督/職員2人 ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=2026-09-01`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const opts = await page.$$eval("#dayStatus option", (os) => os.map((o) => o.textContent));
  check("1〜5 日の状態の選択肢: 通常作業・現場作業なし・休工日・雨天作業不可日・事務作業日", opts.join() === "通常作業,現場作業なし,休工日,雨天作業不可日,事務作業日", opts.join());
  for (const [i, [name, trade, n]] of [["業者A", "塗装", "3"], ["業者B", "とび", "4"]].entries()) {
    if (i) await page.click("#addCompanyBtn");
    const r = page.locator(".company-row").nth(i);
    await r.locator(".companyName").fill(name); await r.locator(".occupation").fill(trade); await r.locator(".actualWorkerCount").fill(n);
    if (i === 0) await r.locator(".billingManDays").fill("1.5");
  }
  check("通常作業では監督・職員の欄が出る（雨天作業不可日の欄は出ない）", (await page.isVisible("#staffCount")) && !(await page.isVisible("#rainCancelledWork")));
  await page.fill("#staffCount", "2"); await page.fill("#staffWork", "現場確認・業者打合せ");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const d1 = await getReport("2026-09-01");
  check("1 通常作業を保存（現場作業員 3＋4・監督/職員2人・作業内容）", d1.dayStatus === "work" && d1.staffCount === 2 && d1.staffWork === "現場確認・業者打合せ" && d1.companies.map((c) => c.actualWorkerCount).join() === "3,4");

  // ---- カレンダーからの簡易登録 ----
  const openCal = async () => {
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="2026-09-02"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const quick = async (date, status, f = {}) => {
    await page.click(`#reportCalendar .cal-cell[data-date="${date}"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
    await page.click(`#dayStatusDialog [data-day-status="${status}"]`);
    const ui = { staffShown: await page.isVisible("#dayStatusStaffCount"), rainShown: await page.isVisible("#dayStatusRainWork"), weather: await page.inputValue("#dayStatusWeather") };
    if (f.rainWork != null) await page.fill("#dayStatusRainWork", f.rainWork);
    if (f.rainReason) await page.fill("#dayStatusRainReason", f.rainReason);
    if (f.weather) await page.selectOption("#dayStatusWeather", f.weather);
    if (f.staff != null) await page.fill("#dayStatusStaffCount", f.staff);
    if (f.staffWork) await page.fill("#dayStatusStaffWork", f.staffWork);
    if (f.remarks) await page.fill("#dayStatusRemarks", f.remarks);
    await page.click("#dayStatusSaveBtn"); await page.waitForTimeout(400);
    ui.closed = !(await page.evaluate(() => document.getElementById("dayStatusDialog").open));
    return ui;
  };
  await openCal();
  const qChoices = await page.$$eval("#dayStatusDialog [data-day-status]", (bs) => bs.map((b) => b.childNodes[0].textContent.trim()));
  check("日報なしの日の選択肢に雨天作業不可日（通常作業・現場作業なし・休工日・雨天作業不可日・事務作業日）", qChoices.join() === "通常作業,現場作業なし,休工日,雨天作業不可日,事務作業日", qChoices.join());
  const q2 = await quick("2026-09-02", "nowork", { staff: "2", staffWork: "現場確認、書類整理" });
  const q3 = await quick("2026-09-03", "holiday", {});
  // 雨天作業不可日: 予定作業が空なら登録しない
  const qRainBlank = await quick("2026-09-04", "rain", { rainWork: "" });
  const blankRain = await getReport("2026-09-04");
  check("16 雨天作業不可日は「中止となった予定作業」が空だと登録しない", !qRainBlank.closed && !blankRain);
  await page.click("#dayStatusBackBtn"); await page.click("#dayStatusCancelBtn");
  const q4 = await quick("2026-09-04", "rain", { rainWork: "外壁塗装", rainReason: "朝から継続的な降雨があり、外壁塗装を中止", weather: "雨", staff: "2", staffWork: "現場確認、役所協議、翌日工程調整", remarks: "明日は晴れの予報" });
  const q5 = await quick("2026-09-05", "office", { staff: "2", staffWork: "施工計画書作成、工程調整" });
  await quick("2026-09-06", "nowork", { staff: "1", staffWork: "現場確認" });
  await quick("2026-09-07", "rain", { rainWork: "足場組立", staff: "0" });
  const r = Object.fromEntries(await Promise.all(["02", "03", "04", "05", "06", "07"].map(async (d) => [d, await getReport(`2026-09-${d}`)])));
  check("2・12〜15 現場作業なし: 業者なし（現場作業員0）・監督/職員2人・作業内容を保存（保存値は従来どおり nowork）", r["02"].dayStatus === "nowork" && r["02"].companies.length === 0 && r["02"].staffCount === 2 && r["02"].staffWork === "現場確認、書類整理" && r["06"].staffCount === 1, JSON.stringify({ st: r["02"].dayStatus, c: r["02"].staffCount }));
  check("3・11 休工日: 監督・職員の入力欄を出さない・保存は未入力（null）", q3.staffShown === false && r["03"].dayStatus === "holiday" && r["03"].staffCount === null);
  check("4・16〜21 雨天作業不可日: 予定作業・中止理由・天気（未選択から「雨」に変更）・監督/職員2人・作業内容・連絡事項を保存", q4.rainShown && q4.staffShown && q4.weather === "" && r["04"].dayStatus === "rain" && r["04"].rainCancelledWork === "外壁塗装" && r["04"].rainReason.includes("降雨") && r["04"].weather === "雨" && r["04"].staffCount === 2 && r["04"].staffWork.includes("役所協議") && r["04"].remarks === "明日は晴れの予報");
  check("19 雨天作業不可日で監督・職員0人（入力した0）を保存（未入力と区別）", r["07"].staffCount === 0 && r["07"].rainCancelledWork === "足場組立");
  check("5・24〜26 事務作業日: 業者なし・監督/職員2人・作業内容を保存", r["05"].dayStatus === "office" && r["05"].companies.length === 0 && r["05"].staffCount === 2 && r["05"].staffWork === "施工計画書作成、工程調整" && q5.staffShown);
  check("雨天作業不可日の簡易登録で天気を自動で「雨」にしない（初期値は未選択）", q4.weather === "");

  // 23 カレンダー表示
  await openCal();
  const cal = await page.evaluate(() => Object.fromEntries(["01", "02", "03", "04", "05", "08", "09"].map((d) => [d, (document.querySelector(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`)?.title || "").split("・搬入：")[0]])));
  const calSum = await page.textContent("#reportCalendar .cal-summary");
  check("23 カレンダー: 現場作業なし・休工日・雨天作業不可日・事務作業日を区別（日報未入力として扱わない）", cal["02"] === "現場作業なし" && cal["03"] === "休工日" && cal["04"] === "雨天作業不可日" && cal["05"] === "事務作業日" && cal["08"] === "休工日" && /雨天作業不可日 2/.test(calSum) && /現場作業なし 2/.test(calSum), JSON.stringify(cal) + " " + calSum);

  // 22 再編集（日報の入力画面で雨天作業不可日を開く・直す）
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r["04"].id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const edit = await page.evaluate(() => ({ ds: document.getElementById("dayStatus").value, rainShown: !document.getElementById("rainFields").hidden, work: document.getElementById("rainCancelledWork").value, staff: document.getElementById("staffCount").value, staffWork: document.getElementById("staffWork").value }));
  await page.fill("#rainReason", "降雨により足場上での作業が危険なため中止"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const r4b = await getReport("2026-09-04");
  check("22 雨天作業不可日を日報の画面で開くと記録が表示され、修正して保存できる", edit.ds === "rain" && edit.rainShown && edit.work === "外壁塗装" && edit.staff === "2" && edit.staffWork.includes("役所協議") && r4b.rainReason.startsWith("降雨により足場上") && r4b.rainCancelledWork === "外壁塗装" && r4b.staffCount === 2);
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r["03"].id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  check("11 休工日の日報を開くと監督・職員の欄は出ない（完全休工の説明が出る）", !(await page.isVisible("#staffCount")) && (await page.isVisible("#staffHolidayNote")));

  // ---- 6〜10・27〜29・33〜37 集計（ダッシュボード）----
  const crewOf = (date) => page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildInfoBand } = await import("/js/dashboard/boardContent.js");
    const { dbGetAll, dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((x) => x.siteId === sid), signatures: [], date, kySubmissions: [] });
    return { ...m.staff.crew, band: Object.fromEntries(buildInfoBand(m).map((b) => [b.label, b.value])), checks: Object.fromEntries(m.checks.map((c) => [c.label, c.value])) };
  }, { sid: ids.siteId, date });
  const c1 = await crewOf("2026-09-01"), c2 = await crewOf("2026-09-02"), c3 = await crewOf("2026-09-03"), c4 = await crewOf("2026-09-04"), c5 = await crewOf("2026-09-05"), c8 = await crewOf("2026-09-08");
  check("27〜29 通常作業: 現場作業員7人・7人工、監督/職員2人・2人工、全体9人・9人工（別集計・内訳つき）", c1.workers === 7 && c1.workerManDays === 7 && c1.staff === 2 && c1.staffManDays === 2 && c1.total === 9 && c1.totalManDays === 9, JSON.stringify(c1));
  check("12・13 現場作業なし: 現場作業員0人・監督/職員2人 → 全体2人（その日の稼働人数は0ではない）", c2.workers === 0 && c2.staff === 2 && c2.total === 2);
  check("6〜10 休工日: 現場作業員0人・監督/職員0人・人工0・全体0", c3.workers === 0 && c3.staff === 0 && c3.workerManDays === 0 && c3.staffManDays === 0 && c3.total === 0 && c3.totalManDays === 0);
  check("休工日（以前のデータに監督の氏名2名・人数2が保存されていても）は0人として数える", c8.staff === 0 && c8.total === 0 && c8.staffSource === "holiday");
  check("20・25 雨天作業不可日・事務作業日: 現場作業員0人・監督/職員2人", c4.workers === 0 && c4.staff === 2 && c4.total === 2 && c5.workers === 0 && c5.staff === 2);
  check("累計: 現場作業員7人（通常作業の日だけ）・監督/職員 2+2+0+2+2+1+0+0＝9人（休工日は0）", c8.workersCumulative === 7 && c8.staffCumulative === 9 && c8.totalCumulative === 16, JSON.stringify({ w: c8.workersCumulative, s: c8.staffCumulative }));
  check("33〜37 工期経過・着工○日目は日の状態に関係なく進む（10/2 2日・2日目 … 10/5 5日・5日目）", c2.band["工期経過"] === "2日" && c2.band["着工"] === "2日目" && c3.band["工期経過"] === "3日" && c4.band["工期経過"] === "4日" && c4.band["着工"] === "4日目" && c5.band["着工"] === "5日目");
  check("今日の確認事項: 雨天作業不可日に「中止となった予定作業 外壁塗装」・監督/職員の人数", c4.checks["中止となった予定作業"] === "外壁塗装" && c4.checks["監督・職員"] === "2人" && c3.checks["監督・職員"] === "0人");

  // 画面（監督管理・現場掲示）
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-09-04"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  const dash = await page.evaluate(() => ({ crew: [...document.querySelectorAll("#siteDashboard .dash-crew tr")].map((tr) => tr.textContent.replace(/\s+/g, "")), text: document.getElementById("siteDashboard").textContent.replace(/\s+/g, " "), textNoBilling: (() => { const c = document.getElementById("siteDashboard").cloneNode(true); c.querySelectorAll(".dash-billing-card, .billing-monthly").forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, " "); })(), board: document.querySelector("#siteDashboard [data-panel=board]").textContent.replace(/\s+/g, " ") }));
  check("監督管理: 本日の稼働の表で 現場作業員0人・監督/職員2人・全体2人 を分けて表示・作業内容", dash.crew.some((t) => t.startsWith("現場作業員0人0")) && dash.crew.some((t) => t.startsWith("監督・職員2人2")) && dash.crew.some((t) => t.startsWith("全体2人2")) && dash.text.includes("監督・職員の作業内容：現場確認、役所協議"), dash.crew.join(" / "));
  check("31・32 ダッシュボード（現場掲示・日々の集計）に請求人工を出さない（請求の欄＝月次の請求管理だけ）", !dash.textNoBilling.includes("請求") && !dash.board.includes("請求"));
  check("38・39 現場掲示（画面）に「本日は雨天作業不可日」と中止となった予定作業", dash.board.includes("本日は雨天作業不可日") && dash.board.includes("中止となった予定作業：外壁塗装"));

  // ---- 03-2（1日分のExcel）: 社員の行に監督・職員、計・延労働時間に含める。業者の行には混ぜない ----
  const readX = async (id, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (rid) => (await import("/js/reportPrint.js")).exportReportExcel(rid), id)]);
    const f = path.join(dir, name); await dl.saveAs(f);
    return page.evaluate(async (b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[0];
      const { parseSharedStrings, readSheetLayout, parseXlsxStyles } = await import("/js/report-output/xlsxSheetReader.js");
      const styles = parseXlsxStyles(await pkg.getText("xl/styles.xml"));
      const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
      const o = {}; for (const [ref, c] of L.cells) o[ref] = { t: c.text, diag: !!styles.resolveStyle(c.styleIndex).border.diagonalDown };
      return o;
    }, fs.readFileSync(f).toString("base64"));
  };
  const t = (x, ref) => x[ref]?.t || "";
  const x1 = await readX(r4b ? d1.id : d1.id, "d1.xlsx");
  check("ケース1・30 03-2 通常作業: 社員（O50）2・計（O51）9＝現場作業員7＋監督/職員2・延労働時間（O52）72。業者の行（塗装工事O33＝3・鳶工事O7＝4）には混ぜない", t(x1, "M50") === "社員" && t(x1, "O50") === "2" && t(x1, "O51") === "9" && t(x1, "O52") === "72" && t(x1, "O33") === "3" && t(x1, "O7") === "4", JSON.stringify({ O50: t(x1, "O50"), O51: t(x1, "O51"), O52: t(x1, "O52"), O33: t(x1, "O33") }));
  const x2 = await readX(r["02"].id, "d2.xlsx"), x3 = await readX(r["03"].id, "d3.xlsx"), x4 = await readX(r["04"].id, "d4.xlsx"), x5 = await readX(r["05"].id, "d5.xlsx"), x8 = await readX(ids.legacy, "d8.xlsx");
  check("ケース2 03-2 現場作業なし: 社員2・計2（業者の行は空）・社員の累計（P50）は 2＋2＝4", t(x2, "O50") === "2" && t(x2, "O51") === "2" && !t(x2, "O33") && t(x2, "P50") === "4", JSON.stringify({ O50: t(x2, "O50"), O51: t(x2, "O51"), P50: t(x2, "P50") }));
  check("ケース3 03-2 休工日: 社員・計は空（0人）・巡回点検の欄は斜線", !t(x3, "O50") && !t(x3, "O51") && x3.L7?.diag && x3.L39?.diag);
  check("ケース3 03-2 休工日（以前のデータで監督の氏名・人数あり）: 社員は書かない（0人）", !t(x8, "O50") && !t(x8, "O51"));
  check("ケース4・21 03-2 雨天作業不可日: 社員2・計2・巡回点検の欄は斜線（L7〜L39）・業者の行は空", t(x4, "O50") === "2" && t(x4, "O51") === "2" && x4.L7?.diag && x4.L39?.diag && !t(x4, "O33"));
  check("ケース5 03-2 事務作業日: 社員2・計2・斜線", t(x5, "O50") === "2" && t(x5, "O51") === "2" && x5.L7?.diag);
  // ケース6 請求人工を変えても03-2の実稼働人数は変わらない
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].billingManDays = "3.0"; await dbPut("reports", r); }, d1.id);
  const x1b = await readX(d1.id, "d1b.xlsx");
  check("ケース6 請求人工 1.5→3.0 にしても03-2の社員2・計9・塗装工事3は変わらない（請求人工は書かない）", t(x1b, "O50") === "2" && t(x1b, "O51") === "9" && t(x1b, "O33") === "3" && !Object.values(x1b).some((c) => c.t === "3.0" || c.t === "1.5"));

  // 台帳: 社員の当日・累計を頁ごとに。計・延労働時間（数式）に含まれる
  const [ld] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (sid) => (await import("/js/reportPrint.js")).exportSiteLedgerExcel(sid), ids.siteId)]);
  const lf = path.join(dir, "ledger.xlsx"); await ld.saveAs(lf);
  const lg = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[0];
    const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
    const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
    const o = {}; for (const [ref, c] of L.cells) if (c.text) o[ref] = c.text; return o;
  }, fs.readFileSync(lf).toString("base64"));
  const pg = (ref, day) => lg[ref.replace(/\d+$/, (n) => String(Number(n) + 52 * day))] || "";
  check("台帳: 10/1 頁 社員2・計9・延労働時間72、10/3（休工日）頁 社員は空・社員の累計4、10/8（休工日・以前のデータ）頁 社員は空・社員の累計9・計の累計16", pg("O50", 0) === "2" && pg("O51", 0) === "9" && pg("O52", 0) === "72" && !pg("O50", 2) && pg("P50", 2) === "4" && !pg("O50", 7) && pg("P50", 7) === "9" && pg("P51", 7) === "16", JSON.stringify({ o50: pg("O50", 0), o51: pg("O51", 0), p50d3: pg("P50", 2), p50d8: pg("P50", 7), p51d8: pg("P51", 7) }));

  // ---- 40 現場掲示A3（雨天作業不可日）----
  const a3 = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((x) => x.siteId === sid), signatures: [], date: "2026-09-04", kySubmissions: [] }));
  }, ids.siteId);
  const p = await ctx.newPage(); await p.setContent(a3); await p.waitForTimeout(300);
  const a3r = await p.evaluate(() => { dispatchEvent(new Event("beforeprint")); return { over: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1).length, text: document.body.textContent.replace(/\s+/g, " ") }; });
  const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1"); await p.close();
  check("38〜40 A3: 「本日は雨天作業不可日」・中止となった予定作業・監督/職員（現場作業員と区別）・A3横1ページ・請求人工なし", a3r.text.includes("本日は雨天作業不可日") && a3r.text.includes("中止となった予定作業：外壁塗装") && a3r.text.includes("監督・職員") && !a3r.text.includes("請求") && a3r.over === 0 && (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf));

  // ---- 43 バックアップ・復元 ----
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "staff-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 8, null, { timeout: 20000 });
  const restored = await p3.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.date === "2026-09-04"));
  check("43 バックアップ・復元で雨天作業不可日・中止予定作業・中止理由・監督/職員の人数と作業内容が保たれる", restored.dayStatus === "rain" && restored.rainCancelledWork === "外壁塗装" && restored.rainReason.startsWith("降雨により") && restored.staffCount === 2 && restored.staffWork.includes("役所協議"));
  await ctx2.close();

  check("以前のデータの休工日（監督の氏名・人数）は書き換えない", (await legacyContent(ids.legacy)) === legacyBefore);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
