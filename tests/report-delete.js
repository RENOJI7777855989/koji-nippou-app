// 日報1件の削除（誤登録・同じ日の重複登録の整理）を確かめる（架空データ・Chromium）。
//   ・同じ日（10/3）に日報3件 → カレンダー「日報3件」→ 1件ずつ開いて内容を見て、不要なものだけ削除 → 残りは残る → 最後の1件で「日報なし」
//   ・削除は確認ダイアログ（キャンセルで残る）。削除後は日報カレンダーへ戻る
//   ・削除する日報の写真・署名だけ削除済みにし、他の日報・他の日付・他の現場は変えない。流れ・搬入搬出・巡回点検は日報と一緒に消える
//   ・削除済みの日報はカレンダー・一覧・ダッシュボード・A3・PDF・Excel・バックアップの復元後も出てこない。自動の重複削除・統合はしない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const D = "2026-09-03"; // 重複のある日（実際は10/3。テストは過去の月で行う）

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-delete-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 現場A: 9/3 に日報3件（A・B・C。どれも写真1枚・署名1件）、9/2 に別の日報（写真・署名あり）。現場B: 9/3 に日報1件
  const ids = await page.evaluate(async (date) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js"); const { defaultWorkdayTimeline } = await import("/js/dashboard/dailyFlow.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const mk = async (siteId, d, name, workers, extra = {}) => {
      const r = stampNew({ siteId, date: d, dayStatus: "work", weather: "晴れ", progressPercent: 30, siteSupervisorNames: [],
        companies: [{ companyId: "c-" + name, companyName: name + "工業", occupation: "塗装", actualWorkerCount: String(workers), workHours: "08:00～17:00", billingManDays: "3" }],
        timeline: defaultWorkdayTimeline().map((x, i) => ({ ...x, id: name + i })), deliveries: [{ id: "d-" + name, direction: "in", time: "09:00", item: name + "資材", status: "plan" }],
        patrolChecklist: { morningMeeting: "good" }, remarks: name + "の連絡", ...extra });
      await dbPut("reports", r);
      await saveSignature({ reportId: r.id, companyId: "c-" + name, blob: png });
      await addPhoto(r.id, siteId, new File([png], "p.png", { type: "image/png" }));
      await new Promise((x) => setTimeout(x, 15)); // 作成時刻をずらす
      return r.id;
    };
    const A = await createSite({ name: "削除確認現場A", startDate: "2026-09-01", endDate: "2026-09-30" });
    const B = await createSite({ name: "削除確認現場B", startDate: "2026-09-01", endDate: "2026-09-30" });
    const rA = await mk(A.id, date, "A", 3), rB = await mk(A.id, date, "B", 5), rC = await mk(A.id, date, "C", 7);
    const other = await mk(A.id, "2026-09-02", "前日", 4);
    const siteB = await mk(B.id, date, "別現場", 2);
    return { siteA: A.id, siteB: B.id, rA, rB, rC, other, siteBReport: siteB };
  }, D);
  const dump = (id) => page.evaluate(async (x) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", x)), id);
  const attach = (id) => page.evaluate(async (x) => { const { dbGetAll } = await import("/js/db.js"); return { photos: (await dbGetAll("photos")).filter((p) => p.reportId === x).map((p) => !!p.isDeleted), sigs: (await dbGetAll("signatures")).filter((s) => s.reportId === x).map((s) => !!s.isDeleted) }; }, id);
  const keep = { other: await dump(ids.other), siteB: await dump(ids.siteBReport), otherAtt: JSON.stringify(await attach(ids.other)), siteBAtt: JSON.stringify(await attach(ids.siteBReport)) };

  const openCal = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteA}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="${D}"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const cell = () => page.$eval(`#reportCalendar .cal-cell[data-date="${D}"]`, (b) => ({ cls: b.className.match(/cal-(?!cell)(\w+)/)?.[1], multi: b.querySelector(".cal-multi")?.textContent || "" }));
  const liveCount = () => page.evaluate(async ([sid, d]) => (await (await import("/js/reports.js")).listReportsBySite(sid)).filter((r) => r.date === d).length, [ids.siteA, D]);
  // カレンダーの日付 → 一覧から n 番目（作業人数で選ぶ）を開く
  const openFromList = async (workers) => {
    await page.click(`#reportCalendar .cal-cell[data-date="${D}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
    const items = await page.$$eval(".day-panel-list li", (lis) => lis.map((li) => ({ meta: li.querySelector(".day-panel-item-meta").textContent, id: li.querySelector("[data-day-open]").dataset.dayOpen })));
    const it = items.find((x) => x.meta.includes(`作業人数 ${workers}人`));
    await page.click(`[data-day-open="${it.id}"]`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
    return { items, id: it.id };
  };
  const deleteOpened = async () => {
    await page.click("#deleteReportBtn"); await page.waitForFunction(() => document.getElementById("reportDeleteDialog").open);
    const text = (await page.textContent("#reportDeleteDialog")).replace(/\s+/g, " ");
    await page.click("#reportDeleteConfirmBtn");
    await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(600);
    return text;
  };

  // ===== 7 同じ日に3件 → カレンダーに「日報3件」・一覧から選べる =====
  await openCal();
  let c = await cell();
  check("7 同じ日（9/3）に日報3件 → カレンダーに「日報3件」と出る", c.multi === "日報3件", JSON.stringify(c));
  const first = await openFromList(5); // B を開く
  check("8（一覧）日付を押すと3件が1件ずつ（作業人数・業者・進捗率・作成時刻）並び、選んで開ける", first.items.length === 3 && first.items.every((x) => /作業人数 \d+人/.test(x.meta) && x.meta.includes("業者") && x.meta.includes("進捗率") && x.meta.includes("作成")) && (await page.inputValue("#date")) === D && (await page.locator(".company-row .companyName").first().inputValue()) === "B工業", first.items.map((x) => x.meta).join(" | "));

  // ===== 2・3 削除確認・キャンセル =====
  const btnVisible = await page.isVisible("#deleteReportBtn");
  const saveBox = await page.locator("#reportSaveBtn").boundingBox(), delBox = await page.locator("#deleteReportBtn").boundingBox();
  check("削除ボタン「この日報を削除」は保存ボタンから離れた下の方にある", btnVisible && (await page.textContent("#deleteReportBtn")).trim() === "この日報を削除" && delBox.y - (saveBox.y + saveBox.height) > 100, `${saveBox.y}→${delBox.y}`);
  await page.click("#deleteReportBtn"); await page.waitForFunction(() => document.getElementById("reportDeleteDialog").open);
  const dlg = (await page.textContent("#reportDeleteDialog")).replace(/\s+/g, " ");
  const focused = await page.evaluate(() => document.activeElement?.id);
  check("2 削除確認: 日付 2026/09/03・作業人数5人・業者1社・作成日時・写真1枚・職長サイン1件・同じ日の件数・元に戻せない", dlg.includes("この日報を削除しますか") && dlg.includes("2026/09/03") && dlg.includes("5人") && dlg.includes("1社") && dlg.includes("作成") && dlg.includes("写真1枚・職長サイン1件") && dlg.includes("日報は3件") && dlg.includes("元に戻せません") && focused === "reportDeleteCancelBtn", dlg.slice(0, 200));
  await page.click("#reportDeleteCancelBtn");
  check("3 キャンセルすると削除されない", !(await page.evaluate(() => document.getElementById("reportDeleteDialog").open)) && !JSON.parse(await dump(ids.rB)).isDeleted && (await liveCount()) === 3);

  // ===== 1・4・5・8・9 B だけ削除 =====
  await deleteOpened();
  const back = await page.evaluate(() => ({ manage: !document.querySelector('.dash-panel[data-panel="manage"]').hidden, saved: document.querySelector("#reportCalendar .cal-just-saved")?.dataset.date || "" }));
  const rB = JSON.parse(await dump(ids.rB));
  check("1・4 確認すると、その日報（B）だけ削除される", rB.isDeleted === true && !!rB.deletedAt && !JSON.parse(await dump(ids.rA)).isDeleted && !JSON.parse(await dump(ids.rC)).isDeleted);
  check("5 削除後は日報カレンダー（監督管理タブ・その日）へ戻る", back.manage && back.saved === D, JSON.stringify(back));
  c = await cell();
  check("9 残り2件が残り、カレンダーは「日報2件」", (await liveCount()) === 2 && c.multi === "日報2件", JSON.stringify(c));
  const attB = await attach(ids.rB);
  check("17 削除した日報（B）の写真・署名は一緒に削除済み（孤立させない）", attB.photos.length === 1 && attB.photos.every(Boolean) && attB.sigs.length === 1 && attB.sigs.every(Boolean), JSON.stringify(attB));
  const attA = await attach(ids.rA);
  check("18 同じ日の他の日報（A・C）と前日の日報の写真・署名は消えない", attA.photos.every((x) => !x) && attA.sigs.every((x) => !x) && JSON.stringify(await attach(ids.other)) === keep.otherAtt && JSON.stringify(await attach(ids.siteBReport)) === keep.siteBAtt);
  check("14〜16 削除した日報の流れ・搬入搬出・巡回点検（日報の中のデータ）は画面・集計から消える", await page.evaluate(async ([sid, d]) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js");
    const reports = await listReportsBySite(sid);
    const m = buildDashboardModel({ site: await dbGet("sites", sid), reports, signatures: [], date: d, kySubmissions: [] });
    return !reports.some((r) => r.companies.some((x) => x.companyName === "B工業")) && !JSON.stringify(m).includes("B資材") && !JSON.stringify(m).includes("Bの連絡");
  }, [ids.siteA, D]));
  // 削除済みの日報をアドレスから開いても開けない
  await page.goto(`${BASE}#/sites/${ids.siteA}/report/${ids.rB}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(300);
  check("削除した日報はアドレスから直接開いても開けない（現場詳細へ戻る）", await page.isVisible("#view-site-detail"));

  // ===== 10・11 もう1件（C）削除 → 1件 =====
  await openCal();
  await openFromList(7);
  const t2 = await deleteOpened();
  c = await cell();
  check("10・11 もう1件（C）を削除 → 残り1件（A）、カレンダーは複数表示なし・日報あり", (await liveCount()) === 1 && c.multi === "" && ["ok", "partial"].includes(c.cls) && JSON.parse(await dump(ids.rC)).isDeleted && !JSON.parse(await dump(ids.rA)).isDeleted && t2.includes("日報は2件"), JSON.stringify(c));
  // 1件になったら、日付を押すと従来の「この日の日報」
  await page.click(`#reportCalendar .cal-cell[data-date="${D}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  const single = await page.evaluate(() => ({ list: document.querySelectorAll(".day-panel-list li").length, btns: [...document.querySelectorAll("#dayPanelActions button")].map((b) => b.textContent) }));
  check("1件だけの日は従来どおり「この日の日報」（簡単に修正／日報を全部見る）", single.list === 0 && single.btns.includes("日報を全部見る"), JSON.stringify(single));
  await page.click("#dayPanelCloseBtn");

  // ===== 12・13・6 最後の1件（A）を削除 → 日報なし =====
  await page.click(`#reportCalendar .cal-cell[data-date="${D}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  await page.click('#dayPanelActions [data-day-go="full"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const t3 = await deleteOpened();
  c = await cell();
  check("12・13・6 最後の1件を削除 → 「日報なし」", (await liveCount()) === 0 && c.cls === "none" && t3.includes("この1件だけ"), JSON.stringify(c));
  const listText = await page.textContent("#reportList");
  check("日報一覧にも削除した日報は出ない（前日の日報は出る）", !listText.includes(D) && listText.includes("2026-09-02"));

  // ===== 19・20 他の日付・他の現場は変わらない =====
  check("19 他の日付の日報（9/2）は変わらない", (await dump(ids.other)) === keep.other);
  check("20 他の現場の同じ日の日報は変わらない", (await dump(ids.siteBReport)) === keep.siteB);

  // ===== 21〜27 既存機能（カレンダー・簡単編集・一部未記入・現場掲示・A3・PDF・Excel）=====
  // 日報なしになった 9/3 にカレンダーから新しく登録できる（簡単登録 → 通常作業の画面）
  await page.click(`#reportCalendar .cal-cell[data-date="${D}"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click('#dayStatusDialog [data-day-status="work"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  await page.locator(".company-row .companyName").first().fill("新規工業"); await page.locator(".company-row .actualWorkerCount").first().fill("2");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
  c = await cell();
  check("21・23 削除した日にカレンダーから新しく登録でき、一部未記入の判定も動く（作業時間・署名なし → 一部未記入）", c.cls === "partial" && (await liveCount()) === 1, JSON.stringify(c));
  const newId = await page.evaluate(async ([sid, d]) => (await (await import("/js/reports.js")).listReportsBySite(sid)).find((r) => r.date === d).id, [ids.siteA, D]);
  await page.goto(`${BASE}#/sites/${ids.siteA}/report/${newId}?mode=quick&from=calendar`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  await page.fill("#remarks", "簡単編集の確認"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  check("22 簡単編集で保存できる", JSON.parse(await dump(newId)).remarks === "簡単編集の確認");
  const board = await page.evaluate(async ([sid, d]) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", sid), reports: await listReportsBySite(sid), signatures: [], date: d, kySubmissions: [] });
    return { same: m.sameDayCount, html: buildTodaySheetHtml(m) };
  }, [ids.siteA, D]);
  check("24・25 現場掲示・A3は残った（新しい）日報だけ（削除した A・B・C の内容は出ない）", board.same === 1 && board.html.includes("新規工業") && !/[ABC]工業/.test(board.html) && !board.html.includes("A資材"));
  const out = await page.evaluate(async (id) => {
    const { generateReportOutput } = await import("/js/report-output/index.js"); const { buildReportPrintHtml } = await import("/js/reportPrint.js");
    const x = await generateReportOutput({ reportId: id, format: "excel" }); const h = await buildReportPrintHtml(id);
    return { size: x.blob.size, pdf: h.html.includes("新規工業") };
  }, newId);
  check("26・27 PDF・Excel出力（残った日報）", out.size > 0 && out.pdf);
  const p2 = await ctx.newPage(); await p2.setContent(board.html); await p2.waitForTimeout(200);
  const pdf = Buffer.from(await p2.pdf({ preferCSSPageSize: true })).toString("latin1"); await p2.close();
  check("25 A3はA3横・1ページ", (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf));

  // ===== 28 バックアップ・復元（削除済みの日報・写真・署名は復元後も出てこない。他は残る）=====
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "report-delete-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 6, null, { timeout: 20000 });
  const restored = await p3.evaluate(async ([sid, d]) => {
    const { listReportsBySite } = await import("/js/reports.js"); const { listPhotosByReport } = await import("/js/photos.js");
    const live = await listReportsBySite(sid);
    return { day: live.filter((r) => r.date === d).map((r) => r.companies[0]?.companyName), prev: live.filter((r) => r.date === "2026-09-02").length, prevPhotos: (await listPhotosByReport(live.find((r) => r.date === "2026-09-02").id)).length };
  }, [ids.siteA, D]);
  check("28 バックアップ・復元: 削除した日報は復元後も出てこない。残した日報・前日の日報と写真は復元される", restored.day.join() === "新規工業" && restored.prev === 1 && restored.prevPhotos === 1, JSON.stringify(restored));
  await ctx2.close();

  // 確定済みの日報は削除できない（データ層）
  const finalized = await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); await dbPut("reports", { ...r, finalizedAt: new Date().toISOString() }); try { await (await import("/js/reports.js")).deleteReportWithAttachments(id); return "deleted"; } catch (e) { return e.message; } }, ids.other);
  check("工事完了で確定した日報は削除できない", finalized.includes("確定済み") && !JSON.parse(await dump(ids.other)).isDeleted, finalized);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
