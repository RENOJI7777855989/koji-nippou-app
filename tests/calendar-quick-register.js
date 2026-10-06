// 日報カレンダーの「日報なし」の日から、この日の状態（通常作業／作業なし／休工日／事務作業日）を登録する操作と、
// 現場掲示A3の印刷で「時刻」「区分」が枠からはみ出さないことを確かめる（架空データ・Chromium＋WebKit）。
//   ・通常作業 → 既存の日報作成画面。作業なし・休工日・事務作業日 → 連絡事項・進捗率（任意）で既存の日報として保存
//   ・保存後・再読み込み後もカレンダーの表示が変わる。日報のある日は従来どおり編集画面
//   ・稼働人数・人工・労働時間に数えない。巡回点検は○にしない（未実施・03-2は斜線）。既存のデータは変わらない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-quick-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } }); // iPadの縦向きの幅
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 工期 9/1〜9/30。9/1 に通常作業の日報（塗装3人・巡回点検○1・是正指示）。他の日は日報なし
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "カレンダー登録の確認現場", startDate: "2026-09-01", endDate: "2026-09-30" });
    const r = stampNew({ siteId: site.id, date: "2026-09-01", dayStatus: "work", progressPercent: 10, siteSupervisorNames: [],
      companies: [{ companyId: "a", companyName: "サンプル塗装", occupation: "塗装工事", actualWorkerCount: "3", workHours: "08:00～17:00" }],
      patrolChecklist: { morningMeeting: "good" }, patrolComment: "通路を片付けること", remarks: "既存の連絡事項" });
    await dbPut("reports", r);
    return { siteId: site.id, existing: r.id };
  });
  const existingBefore = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.existing);

  const openSite = async () => {
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="2026-09-01"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const calState = (d) => page.$eval(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`, (b) => b.className.match(/cal-(?!cell)(\w+)/)?.[1]);
  const quick = async (d, status, { remarks = "", progress = "" } = {}) => {
    await page.click(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`);
    await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
    await page.click(`#dayStatusDialog [data-day-status="${status}"]`);
    if (remarks) await page.fill("#dayStatusRemarks", remarks);
    if (progress) await page.fill("#dayStatusProgress", progress);
    await page.click("#dayStatusSaveBtn");
    await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open);
    await page.waitForTimeout(400);
  };

  await openSite();
  // 1・2 日報なしをタップ → 選択肢 → 通常作業は既存の日報作成画面
  check("前提: 9/2 は日報なし", (await calState("02")) === "none");
  await page.click(`#reportCalendar .cal-cell[data-date="2026-09-02"]`);
  await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  const choices = await page.$$eval("#dayStatusDialog [data-day-status]", (bs) => bs.map((b) => b.childNodes[0].textContent.trim()));
  const title = await page.textContent("#dayStatusDialogTitle");
  check("1 日報なしの日をタップすると「この日の状態」の選択肢（通常作業・現場作業なし・休工日・雨天作業不可日・事務作業日）が出る", choices.join() === "通常作業,現場作業なし,休工日,雨天作業不可日,事務作業日" && title.includes("9/2") && title.includes("日報なし"), `${title} / ${choices.join()}`);
  await page.click(`#dayStatusDialog [data-day-status="work"]`);
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  check("2 通常作業を選ぶと既存の日報作成画面がその日付で開く（巡回点検は初期値「良」）", (await page.inputValue("#date")) === "2026-09-02" && (await page.inputValue("#dayStatus")) === "work" && (await page.$$eval("#patrolChecklistContainer select", (ss) => ss.every((s) => s.value === "good"))));
  const reportsAfterOpen = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).length);
  check("2 作成画面を開いただけでは日報は作られない（日報なしのまま）", reportsAfterOpen === 1);

  // 3〜5 作業なし・休工日・事務作業日を登録 → 6 カレンダー表示が変わる
  await openSite();
  await quick("03", "nowork", { remarks: "資材待ち" });
  await quick("04", "holiday", { progress: "12" });
  await page.click(`#reportCalendar .cal-cell[data-date="2026-09-05"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click(`#dayStatusDialog [data-day-status="office"]`);
  const officeLabel = await page.textContent("#dayStatusRemarksLabel");
  await page.fill("#dayStatusRemarks", "書類作成・施工計画書の修正");
  await page.click("#dayStatusSaveBtn"); await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open); await page.waitForTimeout(400);
  const saved = await page.evaluate(async (sid) => Object.fromEntries((await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.siteId === sid).map((r) => [r.date.slice(8), { st: r.dayStatus, remarks: r.remarks, p: r.progressPercent, co: r.companies.length, patrol: Object.values(r.patrolChecklist || {}).filter(Boolean).length }])), ids.siteId);
  check("3 作業なしを登録（連絡事項「資材待ち」・業者なし）", saved["03"]?.st === "nowork" && saved["03"].remarks === "資材待ち" && saved["03"].co === 0 && saved["03"].p === null, JSON.stringify(saved["03"]));
  check("4 休工日を登録（進捗率12％）", saved["04"]?.st === "holiday" && saved["04"].p === 12 && saved["04"].remarks === "", JSON.stringify(saved["04"]));
  check("5 事務作業日を登録（連絡事項に事務作業の内容）", saved["05"]?.st === "office" && saved["05"].remarks === "書類作成・施工計画書の修正" && officeLabel.includes("事務作業の内容"), JSON.stringify(saved["05"]));
  check("6 保存後、カレンダーの表示が 作業なし・休工日・事務作業日 に変わる（9/6 は日報なしのまま）", (await calState("03")) === "nowork" && (await calState("04")) === "holiday" && (await calState("05")) === "office" && (await calState("06")) === "none");
  // 進捗率の入力チェック
  await page.click(`#reportCalendar .cal-cell[data-date="2026-09-07"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click(`#dayStatusDialog [data-day-status="holiday"]`); await page.fill("#dayStatusProgress", "120"); await page.click("#dayStatusSaveBtn"); await page.waitForTimeout(300);
  const stillOpen = await page.evaluate(() => document.getElementById("dayStatusDialog").open);
  const n7 = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.date === "2026-09-07").length);
  check("進捗率が0〜100でなければ登録しない（ダイアログは開いたまま）", stillOpen && n7 === 0);
  await page.click("#dayStatusBackBtn"); await page.click("#dayStatusCancelBtn");

  // 7 再読み込み後も保持
  await page.reload(); await openSite();
  check("7 再読み込み後も 作業なし・休工日・事務作業日 の表示が保たれる", (await calState("03")) === "nowork" && (await calState("04")) === "holiday" && (await calState("05")) === "office");

  // 8 日報のある日をタップ → 「この日の日報」（状況）→［日報を全部見る］で編集画面（2026-10-03 から。状態の登録ダイアログは出ない）
  await page.click(`#reportCalendar .cal-cell[data-date="2026-09-01"]`);
  await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  const statusDialogOpen = await page.evaluate(() => document.getElementById("dayStatusDialog").open);
  await page.click('#dayPanelActions [data-day-go="full"]');
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  check("8 日報のある日（9/1）をタップすると「この日の日報」が出て、［日報を全部見る］で編集画面が開く（状態の登録ダイアログは出ない）", (await page.inputValue("#date")) === "2026-09-01" && !statusDialogOpen);
  // 登録した休工日をタップ → その日報の編集画面（状態は休工日）
  await openSite(); await page.click(`#reportCalendar .cal-cell[data-date="2026-09-04"]`);
  await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  await page.click('#dayPanelActions [data-day-go="full"]');
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  check("8 登録した休工日をタップすると日報の編集画面（日の状態＝休工日）", (await page.inputValue("#dayStatus")) === "holiday");

  // 9 通常作業の日報入力が壊れていない（日報なしの日→通常作業→入力→保存）
  await openSite();
  await page.click(`#reportCalendar .cal-cell[data-date="2026-09-08"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click(`#dayStatusDialog [data-day-status="work"]`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  await page.locator(".company-row").nth(0).locator(".companyName").fill("サンプル塗装");
  await page.locator(".company-row").nth(0).locator(".occupation").fill("塗装工事"); // 累計人工は業者×工種ごと（9/1 と同じ工種）
  await page.locator(".company-row").nth(0).locator(".actualWorkerCount").fill("4");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const work8 = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.date === "2026-09-08"));
  check("9 通常作業の日報は既存の画面で入力・保存できる（塗装4人）", work8?.dayStatus === "work" && work8.companies[0].actualWorkerCount === "4");

  // 10 稼働人数・人工・労働時間に数えない／11 巡回点検は○にしない（未実施・03-2の斜線の対象）
  const agg = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { patrolStatusOf, patrolSlashApplies } = await import("/js/patrolChecklist.js");
    const { dbGetAll, dbGet } = await import("/js/db.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    const m = buildDashboardModel({ site, reports, signatures: [], date: "2026-09-08" });
    const st = Object.fromEntries(["03", "04", "05"].map((d) => { const r = reports.find((x) => x.date === `2026-09-${d}`); return [d, { label: patrolStatusOf(r).label, slash: patrolSlashApplies(r) }]; }));
    return { cumulative: m.staff.cumulative, labor: m.staff.laborHoursCumulative, cumManDays: m.works[0]?.cumulativeManDays, st };
  }, ids.siteId);
  check("10 作業なし・休工日・事務作業日は稼働人数・人工・延べ労働時間に数えない（累計 3＋4＝7人・56時間・累計人工7）", agg.cumulative === 7 && agg.labor === 56 && agg.cumManDays === 7, JSON.stringify(agg));
  check("11 簡単登録の日は巡回点検が空欄で、未実施（現場作業なし・休工日・事務作業日）・03-2は斜線の対象", saved["03"].patrol === 0 && saved["04"].patrol === 0 && saved["05"].patrol === 0 && agg.st["03"].label === "未実施（現場作業なし）" && agg.st["04"].label === "未実施（休工日）" && agg.st["05"].label === "未実施（事務作業日）" && Object.values(agg.st).every((x) => x.slash), JSON.stringify(agg.st));
  check("12 既存の日報（9/1）は変わらない", (await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.existing)) === existingBefore);

  // ---- 13〜23 現場掲示A3の印刷: 時刻・区分が枠からはみ出さない（区分の印は題名と同じとき（昼礼）は出さない既存の表示） ----
  const sheetHtml = await page.evaluate(async () => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const site = { id: "s", name: "印刷確認現場", startDate: "2026-09-01", endDate: "2026-12-20", constructionNumber: "P-1" };
    const flow = [["08:00", "全体朝礼", "chorei"], ["10:30", "設備打合せ", "uchiawase"], ["12:00", "昼礼", "churei"], ["14:00", "3階巡回", "patrol"], ["15:00", "配筋検査", "inspection"], ["16:30", "片付け", "other"]];
    const r = { id: "r", siteId: "s", date: "2026-10-05", dayStatus: "work", weather: "晴れ", progressPercent: 30,
      companies: [{ companyId: "a", companyName: "サンプル塗装", occupation: "塗装工事", actualWorkerCount: "3", workHours: "08:00～17:00", workContent: "外壁" }],
      timeline: flow.map(([time, title, kind], i) => ({ id: "t" + i, time, title, kind, status: "plan" })),
      deliveries: [["07:30", "in", "鋼管", "done"], ["09:00", "in", "塗料缶", "done"], ["13:30", "out", "廃材", "plan"], ["16:00", "out", "残材", "cancelled"]].map(([time, direction, item, status], i) => ({ id: "d" + i, direction, time, item, quantity: "10", vendor: "サンプル商事", origin: "倉庫", destination: "現場", vehicle: "4t", status })) };
    return buildTodaySheetHtml(buildDashboardModel({ site, reports: [r], signatures: [], date: "2026-10-05", kySubmissions: [] }));
  });
  for (const [name, browserType] of [["Chromium", chromium], ["WebKit", webkit]]) {
    const b = await browserType.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
    await p.setContent(sheetHtml); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
    const m = await p.evaluate(() => {
      dispatchEvent(new Event("beforeprint"));
      const inside = (el, box) => { const r = el.getBoundingClientRect(), t = box.getBoundingClientRect(); return r.left >= t.left - 0.5 && r.right <= t.right + 0.5; };
      const fits = (td) => td.scrollWidth <= td.clientWidth + 1;
      const one = (el) => el.getClientRects().length === 1 && el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).fontSize) * 2;
      const flowTimes = [...document.querySelectorAll("table.flow td.t")].map((td) => ({ t: td.textContent, ok: fits(td) }));
      const kinds = [...document.querySelectorAll("table.flow .kd")].map((k) => ({ t: k.textContent, ok: inside(k, k.closest("td")) && one(k) }));
      const dlv = [...document.querySelectorAll("table.dlv td.t, table.dlv td.dir")].map((td) => ({ t: td.textContent, ok: fits(td) && [...td.childNodes].every((n) => n.nodeType !== 1 || inside(n, td)) }));
      const boxes = [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]")?.dataset.section);
      return { flowTimes, kinds, dlv, boxes, ver: document.querySelector(".ver")?.textContent || "" };
    });
    const bad = [...m.flowTimes, ...m.kinds, ...m.dlv].filter((x) => !x.ok).map((x) => x.t);
    check(`13〜20 ${name}: 流れの時刻（08:00・10:30・12:00・14:00…）・区分（朝礼・打ち合わせ・昼礼・現場巡回）・搬入搬出の時刻・区分が枠内で1行、隣の列に重ならない`, bad.length === 0 && m.kinds.map((k) => k.t).join() === "朝礼,打ち合わせ,現場巡回,検査・立会,その他" && m.dlv.length === 8, bad.join(",") || `区分 ${m.kinds.map((k) => k.t).join("・")}／搬入搬出${m.dlv.length}`);
    check(`23 ${name}: 他の現場掲示の欄も文字があふれない・レイアウトの版 2026-10-07-1`, m.boxes.length === 0 && m.ver.includes("2026-10-07-1"), m.boxes.join(","));
    if (name === "Chromium") {
      const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1");
      check("21・22 A3横・1ページ", (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf));
    }
    await b.close();
  }

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
