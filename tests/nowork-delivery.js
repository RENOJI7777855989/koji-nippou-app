// 「現場作業はしていないが搬入だけあった日」の扱いを確かめる（架空データ・Chromium）。
//   ・日の状態は増やさない（現場作業なし＋搬入あり → カレンダーは「現場作業なし」）。搬入は日報の搬入・搬出（deliveries）のまま
//   ・カレンダーで日付を押すと「搬入：あり（n件）」と内容。現場掲示・A3・PDFも同じ搬入データ
//   ・巡回点検は「未実施（現場作業なし）」、作業員の人数・人工は0のまま、請求人工は変えない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowork-dlv-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const site = await createSite({ name: "搬入だけの日の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const dl = (time, item, vendor, dir = "in") => ({ id: item, direction: dir, time, item, quantity: "", vendor, status: "plan" });
    const base = { siteId: site.id, siteSupervisorNames: [], companies: [] };
    const work = stampNew({ ...base, date: "2026-09-09", dayStatus: "work", progressPercent: 30, weather: "晴れ",
      companies: [{ companyId: "a", companyName: "ナダカ工業", occupation: "塗装", actualWorkerCount: "3", plannedWorkerCount: "3", workHours: "08:00～17:00", billingManDays: "3.5" }],
      patrolChecklist: { morningMeeting: "good" }, deliveries: [dl("09:00", "塗料", "サンプル商事")] });
    const nowork = stampNew({ ...base, date: "2026-09-10", dayStatus: "nowork", deliveries: [dl("10:00", "外壁材", "○○運送"), dl("14:00", "足場材", "△△運輸")] });
    const noworkEmpty = stampNew({ ...base, date: "2026-09-11", dayStatus: "nowork" });
    const rain = stampNew({ ...base, date: "2026-09-12", dayStatus: "rain", rainCancelledWork: "外壁塗装", deliveries: [dl("11:00", "シーラー", "□□商会")] });
    const holiday = stampNew({ ...base, date: "2026-09-13", dayStatus: "holiday" });
    for (const r of [work, nowork, noworkEmpty, rain, holiday]) await dbPut("reports", r);
    await saveSignature({ reportId: work.id, companyId: "a", blob: png });
    await addPhoto(work.id, site.id, new File([png], "p.png", { type: "image/png" }));
    return { siteId: site.id, work: work.id, nowork: nowork.id };
  });
  const snap = () => page.evaluate(async (sid) => { const { dbGetAll } = await import("/js/db.js"); return { reports: JSON.stringify((await dbGetAll("reports")).filter((r) => r.siteId === sid && r.date !== "2026-09-14").sort((a, b) => a.date.localeCompare(b.date))), sigs: JSON.stringify(await dbGetAll("signatures")), photos: JSON.stringify((await dbGetAll("photos")).map((p) => [p.id, p.reportId, p.blob?.size])) }; }, ids.siteId);
  const before = await snap();

  const openCal = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$('#reportCalendar .cal-cell[data-date="2026-09-10"]')); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const cal = (d) => page.$eval(`#reportCalendar .cal-cell[data-date="${d}"]`, (b) => b.className.match(/cal-(?!cell)(\w+)/)?.[1]);
  const panel = async (d) => {
    await page.click(`#reportCalendar .cal-cell[data-date="${d}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
    const t = (await page.textContent("#dayPanelDialog")).replace(/\s+/g, " ");
    await page.click("#dayPanelCloseBtn");
    return t;
  };
  await openCal();

  // ===== 1〜5 カレンダーの状態は増やさない・日付を押すと搬入の有無と内容 =====
  const p9 = await panel("2026-09-09"), p10 = await panel("2026-09-10"), p11 = await panel("2026-09-11"), p12 = await panel("2026-09-12"), p13 = await panel("2026-09-13");
  check("1 通常作業＋搬入 → 日報あり（記入済み）＋搬入：あり（09:00 塗料 サンプル商事）", ["ok", "partial"].includes(await cal("2026-09-09")) && p9.includes("日報：") && p9.includes("搬入：あり（1件）") && p9.includes("09:00 塗料 サンプル商事"), p9.slice(0, 160));
  check("2・6 現場作業なし＋搬入あり → カレンダーは「現場作業なし」のまま、開くと「現場作業なし」「搬入：あり（2件）」と 10:00 外壁材 ○○運送・14:00 足場材 △△運輸", (await cal("2026-09-10")) === "nowork" && p10.includes("日報：現場作業なし") && p10.includes("搬入：あり（2件）") && p10.includes("10:00 外壁材 ○○運送") && p10.includes("14:00 足場材 △△運輸"), p10);
  check("3 現場作業なし＋搬入なし → 現場作業なし・搬入：なし", (await cal("2026-09-11")) === "nowork" && p11.includes("日報：現場作業なし") && p11.includes("搬入：なし"), p11);
  check("4 雨天作業不可＋搬入あり → 雨天作業不可日＋搬入：あり（11:00 シーラー □□商会）", (await cal("2026-09-12")) === "rain" && p12.includes("日報：雨天作業不可日") && p12.includes("搬入：あり（1件）") && p12.includes("11:00 シーラー □□商会"), p12);
  check("5 休工日は既存のまま（休工日・搬入：なし）", (await cal("2026-09-13")) === "holiday" && p13.includes("日報：休工日") && p13.includes("搬入：なし"));
  check("カレンダーに新しい状態は増えていない（日報あり・一部未記入・日報なし・現場作業なし・休工日・雨天作業不可日・事務作業日だけ）", await page.evaluate(() => [...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")].every((b) => /cal-(ok|partial|none|nowork|holiday|rain|office|out|future)\b/.test(b.className))));

  // ===== 7・8・9・10 現場掲示・A3・PDF・巡回点検・人数 =====
  const m = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js");
    const out = {};
    for (const d of ["2026-09-10", "2026-09-12"]) {
      const model = buildDashboardModel({ site: await dbGet("sites", sid), reports: await listReportsBySite(sid), signatures: [], date: d, kySubmissions: [] });
      out[d] = { html: buildTodaySheetHtml(model), workers: model.staff.today, works: model.works.length, manDays: model.works.reduce((s, w) => s + (w.manDays || 0), 0), patrol: model.patrolStatus.label, flowNonDlv: model.flow.filter((f) => f.kind !== "delivery").length };
    }
    return out;
  }, ids.siteId);
  const t10 = m["2026-09-10"].html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check("7 A3現場掲示: 「本日は現場作業なし」と搬入・搬出の欄に外壁材 ○○運送・足場材 △△運輸（通常作業の流れは出ない）", t10.includes("本日は現場作業なし") && t10.includes("外壁材") && t10.includes("○○運送") && t10.includes("足場材") && t10.includes("△△運輸") && m["2026-09-10"].flowNonDlv === 0 && !t10.includes("片付け開始"));
  // 画面の現場掲示も同じ
  await page.$eval("#siteDashboard .dash-date-input", (el) => { el.value = "2026-09-10"; el.dispatchEvent(new Event("change", { bubbles: true })); }); await page.waitForTimeout(500);
  await page.click("#siteDashboard .dash-tab[data-tab=board]");
  const board = (await page.textContent('#siteDashboard [data-panel="board"]')).replace(/\s+/g, " ");
  check("7 現場掲示（画面）にも同じ搬入（外壁材・足場材）と「現場作業なし」", board.includes("現場作業なし") && board.includes("外壁材") && board.includes("足場材"));
  // PDF（A3印刷の印刷用HTMLをPDFに。文字を pdf.js で取り出す）
  const pp = await ctx.newPage(); await pp.setContent(m["2026-09-10"].html); await pp.emulateMedia({ media: "print" }); await pp.waitForTimeout(300);
  const pdf = Buffer.from(await pp.pdf({ preferCSSPageSize: true })); await pp.close();
  const pdfText = await page.evaluate(async (b64) => {
    const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const doc = await pdfjs.getDocument({ data: u, cMapUrl: "/js/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/js/vendor/pdfjs/standard_fonts/" }).promise;
    return { pages: doc.numPages, text: (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join("").normalize("NFKC").replace(/\s+/g, "") };
  }, pdf.toString("base64"));
  check("8 PDF（A3横1ページ）にも同じ搬入（10:00 外壁材 ○○運送・14:00 足場材 △△運輸）", pdfText.pages === 1 && pdfText.text.includes("外壁材") && pdfText.text.includes("○○運送") && pdfText.text.includes("足場材") && pdfText.text.includes("△△運輸") && pdfText.text.includes("10:00") && pdfText.text.includes("14:00"));
  // 「📄 PDF保存・共有」のPDFも同じ印刷用HTMLから作る（tests/board-pdf.js で一致を確認済み）。ここでは作れることを確かめる
  const sharePdf = await page.evaluate(async (html) => { const { buildBoardPdfFile } = await import("/js/ui/board-pdf.js"); const { file } = await buildBoardPdfFile(html, { siteName: "搬入だけの日の確認現場", date: "2026-09-10" }); return { type: file.type, size: file.size }; }, m["2026-09-10"].html);
  check("8 「PDF保存・共有」のPDFも作れる（同じ印刷用HTMLから）", sharePdf.type === "application/pdf" && sharePdf.size > 10000, JSON.stringify(sharePdf));
  check("9 現場作業なし（搬入あり）の巡回点検は「未実施（現場作業なし）」、雨天作業不可日は「未実施（雨天作業不可日）」", m["2026-09-10"].patrol === "未実施（現場作業なし）" && m["2026-09-12"].patrol === "未実施（雨天作業不可日）");
  check("10 搬入があっても作業員の人数・人工は0（業者別稼働なし）", m["2026-09-10"].workers === 0 && m["2026-09-10"].works === 0 && m["2026-09-10"].manDays === 0 && m["2026-09-12"].workers === 0);

  // ===== 搬入を簡単修正で入力できる（現場作業なしの日でも搬入・搬出の欄は隠さない）=====
  await openCal();
  await page.click('#reportCalendar .cal-cell[data-date="2026-09-14"]'); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click('#dayStatusDialog [data-day-status="nowork"]'); await page.click("#dayStatusSaveBtn");
  await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open); await page.waitForTimeout(500);
  await page.click('#reportCalendar .cal-cell[data-date="2026-09-14"]'); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  await page.click('#dayPanelActions [data-day-go="quick"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const vis = await page.evaluate(() => ({ dlv: document.querySelector('[data-qsec="deliveries"]').offsetParent !== null, companies: document.querySelector('[data-qsec="companies"]').offsetParent !== null, timeline: document.querySelector('[data-qsec="timeline"]').offsetParent !== null }));
  await page.click("#addDeliveryBtn");
  const row = page.locator(".delivery-row").last();
  await row.locator(".dlvTime").fill("09:30"); await row.locator(".dlvItem").fill("サッシ"); await row.locator(".dlvVendor").fill("◇◇物流");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(600);
  const p14 = await panel("2026-09-14");
  const r14 = await page.evaluate(async (sid) => (await (await import("/js/reports.js")).listReportsBySite(sid)).find((r) => r.date === "2026-09-14"), ids.siteId);
  check("現場作業なしの日も、簡単修正で搬入を入力・保存できる（業者・流れの欄は隠す）→ 現場作業なしのまま・搬入：あり", vis.dlv && !vis.companies && !vis.timeline && r14.dayStatus === "nowork" && r14.deliveries.length === 1 && (await cal("2026-09-14")) === "nowork" && p14.includes("搬入：あり（1件）") && p14.includes("09:30 サッシ ◇◇物流") && !(r14.timeline || []).length && !(r14.companies || []).some((c) => c.actualWorkerCount), JSON.stringify(vis));

  // ===== 11・12 請求人工・既存データ =====
  const after = await snap();
  const workAfter = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), ids.work);
  check("11 請求人工は変わらない（3.5のまま）", workAfter.companies[0].billingManDays === "3.5");
  check("12 既存の日報・搬入・写真・署名は変わらない（確認・新しい日報の登録の前後）", after.reports === before.reports && after.sigs === before.sigs && after.photos === before.photos);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
