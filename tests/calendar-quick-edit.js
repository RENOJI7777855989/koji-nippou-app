// 日報カレンダーを起点にした簡単記入・修正と、本日の現場の流れ（基本スケジュールの初期値）・現場掲示との連携を確かめる
// （架空データ・Chromium。iPadの縦向きの幅）。
//   ・日報なし → この日の状態を選んで登録（通常作業は日報画面。現場作業なし・休工日・雨天作業不可日・事務作業日は簡易登録）
//   ・一部未記入 → 未記入の項目（何が・誰の）を表示 → 未記入だけを入力 → 保存でカレンダーへ戻り状態が変わる
//   ・日報あり → 概要 → 簡単に修正（既存の値を表示）→ 保存でカレンダーへ戻る
//   ・新規の通常作業の日報に流れの初期値8件（変更・削除・追加・時刻順）。特殊な日・既存の日報には入れない
//   ・流れは日報のデータだけから現場掲示・A3・PDFに出る（変更・追加・削除がそのまま反映）
//   ・写真・署名・巡回点検・請求人工は消えない・変わらない。Excel・PDF出力・バックアップ・復元
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
// 保存し直すと項目の並び順が整うので、値で比べる
const flowKey = (rows) => JSON.stringify((rows || []).map((f) => [f.id, f.time, f.kind, f.title, f.status, f.note || ""]));
const coKey = (c) => JSON.stringify(["companyName", "occupation", "actualWorkerCount", "workHours", "workContent", "billingManDays"].map((k) => c?.[k] ?? ""));
const DEFAULTS = ["08:00|chorei|朝礼", "08:20|work|作業", "10:00|break|休憩", "12:00|break|昼休憩", "13:00|churei|昼礼", "15:00|break|休憩", "16:45|cleanup|片付け開始", "17:00|workend|作業終了"];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-edit-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 工期 9/1〜9/30（過去の月）。
  //   9/1 一部未記入: 進捗率なし・ナダカ工業（外壁下地補修）と野本建装工業の作業時間なし。署名・写真・請求人工・流れ（既存1行）あり
  //   9/2 日報あり: 協栄工業（足場4人）・進捗40%・曇り・巡回点検○・署名あり
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js");
    const site = await createSite({ name: "カレンダー簡単記入の確認現場", startDate: "2026-09-01", endDate: "2026-09-30" });
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const r1 = stampNew({ siteId: site.id, date: "2026-09-01", dayStatus: "work", weather: "晴れ", progressPercent: null, siteSupervisorNames: [],
      companies: [
        { companyId: "n1", companyName: "ナダカ工業", occupation: "外壁下地補修", actualWorkerCount: "3", workHours: "", billingManDays: "5", workContent: "クラック補修" },
        { companyId: "n2", companyName: "ナダカ工業", occupation: "塗装", actualWorkerCount: "2", workHours: "08:00～17:00", workContent: "下塗り" },
        { companyId: "m1", companyName: "野本建装工業", occupation: "塗装", actualWorkerCount: "2", workHours: "", workContent: "中塗り" }],
      patrolChecklist: { morningMeeting: "good" }, timeline: [{ id: "old1", time: "09:00", kind: "uchiawase", title: "既存の打ち合わせ", status: "done", note: "" }], remarks: "" });
    const r2 = stampNew({ siteId: site.id, date: "2026-09-02", dayStatus: "work", weather: "曇り", progressPercent: 40, siteSupervisorNames: [],
      companies: [{ companyId: "k1", companyName: "協栄工業", occupation: "足場", actualWorkerCount: "4", workHours: "08:00～17:00", billingManDays: "4.5", workContent: "足場組立" }],
      patrolChecklist: { morningMeeting: "good" }, remarks: "既存の連絡事項", tomorrowPlan: "足場点検" });
    await dbPut("reports", r1); await dbPut("reports", r2);
    for (const cid of ["n1", "n2", "m1"]) await saveSignature({ reportId: r1.id, companyId: cid, blob: png });
    await saveSignature({ reportId: r2.id, companyId: "k1", blob: png });
    await addPhoto(r1.id, site.id, new File([png], "p.png", { type: "image/png" }));
    return { siteId: site.id, r1: r1.id, r2: r2.id };
  });
  const db = (fn, arg) => page.evaluate(fn, arg);
  const getReport = (id) => db(async (x) => (await import("/js/db.js")).dbGet("reports", x), id);
  const reportOf = (date) => db(async ([sid, d]) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === d && !r.isDeleted) || null, [ids.siteId, date]);

  const openSite = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="2026-09-01"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const calState = (d) => page.$eval(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`, (b) => b.className.match(/cal-(?!cell)(\w+)/)?.[1]);
  const backAtCalendar = async () => {
    await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
    return page.evaluate(() => ({ manage: !document.querySelector('.dash-panel[data-panel="manage"]').hidden, inManage: !!document.querySelector('.dash-panel[data-panel="manage"] #reportCalendar'), saved: document.querySelector("#reportCalendar .cal-just-saved")?.dataset.date || "" }));
  };
  const flowRows = () => page.$$eval("#timelineContainer .timeline-row", (rows) => rows.map((r) => `${r.querySelector(".flowTime").value}|${r.querySelector(".flowKind").value}|${r.querySelector(".flowTitle").value}`));
  const tapDay = async (d) => { await page.click(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`); };
  const quickRegister = async (d, status, fill = async () => {}) => {
    await tapDay(d); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
    await page.click(`#dayStatusDialog [data-day-status="${status}"]`);
    await fill();
    await page.click("#dayStatusSaveBtn"); await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open); await page.waitForTimeout(500);
  };
  const setSlider = async (sel, v) => page.$eval(sel, (range, val) => { range.value = String(val); range.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const before1 = await getReport(ids.r1);
  const before2 = await getReport(ids.r2);

  // ===== 1・2・13〜20 日報なし → 通常作業 → 新規日報に流れの初期値8件 =====
  await openSite();
  check("前提: 9/1 一部未記入・9/2 日報あり・9/10 日報なし", (await calState("01")) === "partial" && (await calState("02")) === "ok" && (await calState("10")) === "none");
  await tapDay("10"); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  const choices = await page.$$eval("#dayStatusDialog [data-day-status]", (bs) => bs.map((b) => b.childNodes[0].textContent.trim()));
  check("1 日報なしの日をタップ → 通常作業・現場作業なし・休工日・雨天作業不可日・事務作業日を選べる", choices.join() === "通常作業,現場作業なし,休工日,雨天作業不可日,事務作業日", choices.join());
  await page.click(`#dayStatusDialog [data-day-status="work"]`);
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  const initial = await flowRows();
  check("2 通常作業 → 通常の日報入力画面（日付 9/10・通常作業）", (await page.inputValue("#date")) === "2026-09-10" && (await page.inputValue("#dayStatus")) === "work");
  check("13 新規の通常作業日報に流れの初期値が8件入る（13:00 昼礼を含む）", initial.length === 8, initial.join(" / "));
  DEFAULTS.forEach((d, i) => check(`${14 + i} 初期値 ${d.replace(/\|/g, " ")}`, initial[i] === d, initial[i]));
  check("流れの初期値の状態は「予定」・保存ボタンは「保存してカレンダーへ戻る」", (await page.$$eval("#timelineContainer .flowStatus", (ss) => ss.every((s) => s.value === "plan"))) && (await page.textContent("#reportSaveBtn")) === "保存してカレンダーへ戻る");
  // 日の状態を休工日に変えると初期値（変更していない行）は外れ、通常作業に戻すと元に戻る
  await page.selectOption("#dayStatus", "holiday"); await page.waitForTimeout(100);
  const whenHoliday = (await flowRows()).length;
  await page.selectOption("#dayStatus", "work"); await page.waitForTimeout(100);
  check("28 通常作業以外に変えると初期値の流れは外れ（0件）、通常作業に戻すと8件に戻る", whenHoliday === 0 && (await flowRows()).length === 8, `休工日 ${whenHoliday}件`);
  // 21〜25 時刻変更（08:20→08:30）・種別変更（15:00 休憩→現場巡回）・内容変更（15:00 →「3階巡回」）・削除（10:00休憩）・追加（09:30 打ち合わせ）
  const rows = page.locator("#timelineContainer .timeline-row");
  await rows.nth(1).locator(".flowTime").fill("08:30");
  await rows.nth(5).locator(".flowKind").selectOption("patrol"); // 15:00 休憩（13:00 昼礼の次）
  await rows.nth(5).locator(".flowTitle").fill("3階巡回");
  await rows.nth(2).locator(".removeRowBtn").click(); // 初期値のままなので確認なし（入力ありでも確認ダイアログは自動で承認）
  await page.click("#addTimelineBtn");
  const added = page.locator("#timelineContainer .timeline-row").last();
  await added.locator(".flowTime").fill("09:30"); await added.locator(".flowKind").selectOption("uchiawase"); await added.locator(".flowTitle").fill("打ち合わせ");
  await page.locator(".company-row").nth(0).locator(".companyName").fill("ナダカ工業");
  await page.locator(".company-row").nth(0).locator(".occupation").fill("防水");
  await page.locator(".company-row").nth(0).locator(".actualWorkerCount").fill("2");
  await page.click("#reportSaveBtn");
  const back10 = await backAtCalendar();
  const r10 = await reportOf("2026-09-10");
  const saved10 = (r10.timeline || []).map((f) => `${f.time}|${f.kind}|${f.title}`);
  check("21 時刻変更（08:20→08:30）が保存される", saved10.includes("08:30|work|作業") && !saved10.some((x) => x.startsWith("08:20")), saved10.join(" / "));
  check("22・23 種別変更（休憩→現場巡回）・内容変更（3階巡回）が保存される", saved10.includes("15:00|patrol|3階巡回"));
  check("24 削除（10:00 休憩）が保存される", !saved10.some((x) => x.startsWith("10:00")));
  check("25・26 追加（09:30 打ち合わせ）・保存は時刻順", saved10.includes("09:30|uchiawase|打ち合わせ") && saved10.join() === [...saved10].sort().join() && saved10.length === 8, saved10.join(" / "));
  check("11・17 保存後はカレンダー（監督管理タブ）へ戻り、9/10 を表示する", back10.manage && back10.inManage && back10.saved === "2026-09-10", JSON.stringify(back10));
  check("18・19 保存後の状態: 作業時間・署名・巡回点検が未記入なので「一部未記入」", (await calState("10")) === "partial");

  // ===== 29〜33 現場掲示（画面）に日報の流れが時刻順で出る =====
  const boardFlow = async (date) => {
    await page.click("#siteDashboard .dash-tab[data-tab=board]");
    await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, date);
    await page.waitForTimeout(600);
    return page.$$eval('#siteDashboard .dash-panel[data-panel="board"] .dash-flow-item:not(.is-delivery)', (li) => li.map((x) => `${x.querySelector(".dash-flow-time").textContent} ${x.querySelector(".dash-flow-title").textContent.trim()}`));
  };
  let bf = await boardFlow("2026-09-10");
  check("29・33 現場掲示に日報の流れが時刻順で表示される（12:00 は種別の印なしで「昼休憩」）", bf.join(" / ") === "08:00 朝礼 / 08:30 作業 / 09:30 打ち合わせ / 12:00 昼休憩 / 13:00 昼礼 / 15:00 現場巡回3階巡回 / 16:45 片付け開始 / 17:00 作業終了", bf.join(" / "));
  check("30〜32 日報の時刻変更（08:30）・追加（09:30）・削除（10:00）が現場掲示に反映", bf.some((x) => x.startsWith("08:30")) && bf.some((x) => x.startsWith("09:30")) && !bf.some((x) => x.startsWith("10:00")));
  // 日報で 16:45 片付け開始 → 17:00 に変えると現場掲示も変わる（簡単に修正から）
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r10.id}?mode=quick&from=calendar`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.$$eval("#timelineContainer .timeline-row", (rs) => { const r = rs.find((x) => x.querySelector(".flowKind").value === "cleanup"); r.querySelector(".flowTime").value = "17:00"; });
  await page.click("#reportSaveBtn"); await backAtCalendar();
  bf = await boardFlow("2026-09-10");
  check("30 日報で 16:45 片付け開始 → 17:00 に変えると現場掲示も 17:00", bf.includes("17:00 片付け開始") && !bf.some((x) => x.startsWith("16:45")), bf.join(" / "));

  // ===== 3〜6・22〜25・28 現場作業なし・休工日・雨天作業不可日・事務作業日の簡易登録 =====
  await openSite();
  await quickRegister("11", "nowork", async () => { await page.fill("#dayStatusRemarks", "資材待ち"); await page.fill("#dayStatusStaffCount", "1"); });
  await quickRegister("12", "holiday");
  await quickRegister("13", "rain", async () => {
    await page.fill("#dayStatusRainWork", "外壁塗装"); await page.fill("#dayStatusRainReason", "朝から降雨");
    await page.fill("#dayStatusStaffCount", "2"); await page.fill("#dayStatusStaffWork", "書類作成");
    await setSlider("#dayStatusQuickForm .progress-range", 33); await page.selectOption("#dayStatusWeather", "雨"); await page.fill("#dayStatusRemarks", "明日再開予定");
  });
  await quickRegister("14", "office", async () => { await page.fill("#dayStatusRemarks", "施工計画書の修正"); });
  const sp = {};
  for (const d of ["11", "12", "13", "14"]) sp[d] = await reportOf(`2026-09-${d}`);
  check("3 現場作業なしを登録（連絡事項・監督/職員1人）", sp["11"]?.dayStatus === "nowork" && sp["11"].remarks === "資材待ち" && sp["11"].staffCount === 1);
  check("4 休工日を登録", sp["12"]?.dayStatus === "holiday");
  check("5 雨天作業不可日を登録（天気・中止作業・理由・連絡事項・監督/職員・作業内容・進捗率をスライダーで33%）", sp["13"]?.dayStatus === "rain" && sp["13"].weather === "雨" && sp["13"].rainCancelledWork === "外壁塗装" && sp["13"].rainReason === "朝から降雨" && sp["13"].remarks === "明日再開予定" && sp["13"].staffCount === 2 && sp["13"].staffWork === "書類作成" && sp["13"].progressPercent === 33, JSON.stringify({ w: sp["13"]?.weather, p: sp["13"]?.progressPercent }));
  check("6 事務作業日を登録", sp["14"]?.dayStatus === "office" && sp["14"].remarks === "施工計画書の修正");
  check("23〜25 休工日・雨天作業不可日・事務作業日（と現場作業なし）は通常作業にならない", ["11", "12", "13", "14"].every((d) => sp[d].dayStatus !== "work"));
  check("28 特殊な日に通常作業の初期の流れが入らない", ["11", "12", "13", "14"].every((d) => !(sp[d].timeline || []).length));
  check("12・22 カレンダー: 現場作業なし・休工日・雨天作業不可日・事務作業日（日報なしと混同しない。9/15 は日報なし）", (await calState("11")) === "nowork" && (await calState("12")) === "holiday" && (await calState("13")) === "rain" && (await calState("14")) === "office" && (await calState("15")) === "none");
  check("進捗率は未入力のまま登録すると未入力（0%にしない）", sp["11"].progressPercent === null && sp["12"].progressPercent === null);

  // ===== 7・8・19・20 一部未記入 → 未記入項目 → 未記入を入力 =====
  await tapDay("01"); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  const panel1 = await page.evaluate(() => ({ text: document.getElementById("dayPanelDialog").textContent.replace(/\s+/g, " "), items: [...document.querySelectorAll(".day-panel-missing li")].map((li) => li.textContent), btns: [...document.querySelectorAll("#dayPanelActions button")].map((b) => b.textContent) }));
  check("7 一部未記入の日をタップ → 「日報：一部未記入」と未記入項目（進捗率・ナダカ工業（外壁下地補修）：作業時間・野本建装工業：作業時間）", panel1.text.includes("日報：一部未記入") && panel1.items.join("|") === "進捗率|ナダカ工業（外壁下地補修）：作業時間|野本建装工業：作業時間" && panel1.btns.join("|") === "未記入を入力|日報を全部見る", `${panel1.items.join("|")} / ${panel1.btns.join("|")}`);
  check("21（一部未記入の判定）連絡事項が空でも未記入にしない・記入済みのナダカ工業（塗装）は出ない", !panel1.items.some((x) => x.includes("連絡事項") || x.includes("（塗装）")));
  await page.click('#dayPanelActions [data-day-go="missing"]');
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const vis = await page.evaluate(() => {
    const shown = (el) => !!el && el.offsetParent !== null;
    return {
      guide: [...document.querySelectorAll(".report-missing-item")].map((b) => b.textContent),
      rows: [...document.querySelectorAll(".company-row")].map((r) => `${r.querySelector(".companyName").value}/${r.querySelector(".occupation").value}:${shown(r) ? "表示" : "非表示"}`),
      timeline: shown(document.querySelector('[data-qsec="timeline"]')), photos: shown(document.querySelector('[data-qsec="photos"]')), progress: shown(document.getElementById("progressPercent")),
      sliderText: document.querySelector("#reportForm .progress-slider-value").textContent
    };
  });
  check("8 未記入を入力: 未記入の項目の一覧・未記入の業者の行だけ表示（記入済みのナダカ工業（塗装）・流れ・写真は隠す）", vis.guide.join("|") === "進捗率|ナダカ工業（外壁下地補修）：作業時間|野本建装工業：作業時間" && vis.rows.join(",") === "ナダカ工業/外壁下地補修:表示,ナダカ工業/塗装:非表示,野本建装工業/塗装:表示" && !vis.timeline && !vis.photos && vis.progress, JSON.stringify(vis));
  check("6 進捗率が未入力なら「未入力」と大きく表示（0%にしない）", vis.sliderText === "未入力");
  // まず進捗率だけ入れて保存 → まだ一部未記入（19）
  await page.click(".report-missing-item >> nth=0"); await page.waitForTimeout(200);
  await setSlider("#reportForm .progress-range", 55);
  const afterProgress = await page.$$eval(".report-missing-item", (b) => b.map((x) => x.textContent));
  await page.click("#reportSaveBtn"); await backAtCalendar();
  check("19 未入力が残れば一部未記入のまま（進捗率だけ入力）", (await calState("01")) === "partial" && (await getReport(ids.r1)).progressPercent === 55 && afterProgress.length === 2, afterProgress.join("|"));
  // 残りの作業時間を入れて保存 → 日報あり（20）
  await tapDay("01"); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  await page.click('#dayPanelActions [data-day-go="missing"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.click(".report-missing-item >> nth=1"); // 野本建装工業：作業時間 へ移動
  const target = await page.evaluate(() => [...document.querySelectorAll(".is-target")].map((el) => el.closest(".company-row")?.querySelector(".companyName").value || el.className).join(","));
  for (const cid of ["n1", "m1"]) await page.selectOption(`.company-row[data-company-id="${cid}"] .workStart`, "08:00"); // 終了は自動で17:00
  const doneText = await page.textContent("#reportMissingGuide");
  await page.click("#reportSaveBtn"); await backAtCalendar();
  const r1 = await getReport(ids.r1);
  check("8 未記入の項目を押すとその業者の欄へ移動する（野本建装工業）", target === "野本建装工業", target);
  check("20 全て完了すれば「日報あり」（作業時間 08:00～17:00）", (await calState("01")) === "ok" && r1.companies.find((c) => c.companyId === "n1").workHours === "08:00～17:00" && r1.companies.find((c) => c.companyId === "m1").workHours === "08:00～17:00" && doneText.includes("未記入の項目はありません"), doneText);
  const sig1 = await db(async (id) => (await (await import("/js/signatures.js")).listSignaturesByReport(id)).length, ids.r1);
  const ph1 = await db(async (id) => (await (await import("/js/photos.js")).listPhotosByReport(id)).length, ids.r1);
  check("26 写真・署名が消えない（署名3・写真1）", sig1 === 3 && ph1 === 1, `署名${sig1}・写真${ph1}`);
  check("27 請求人工・既存の流れ・巡回点検・他の業者の値は変わらない（既存日報に初期値を追加しない）", r1.companies.find((c) => c.companyId === "n1").billingManDays === "5" && flowKey(r1.timeline) === flowKey(before1.timeline) && JSON.stringify(r1.patrolChecklist) === JSON.stringify(before1.patrolChecklist) && coKey(r1.companies.find((c) => c.companyId === "n2")) === coKey(before1.companies.find((c) => c.companyId === "n2")), `${flowKey(r1.timeline)} / ${coKey(r1.companies.find((c) => c.companyId === "n2"))}`);

  // ===== 9〜16・21 日報あり → 簡単に修正（過去日 9/2）=====
  await tapDay("02"); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
  const panel2 = await page.evaluate(() => ({ text: document.getElementById("dayPanelDialog").textContent.replace(/\s+/g, " "), btns: [...document.querySelectorAll("#dayPanelActions button")].map((b) => b.textContent) }));
  check("9 日報ありの日 → 「日報：記入済み」・作業人数4人・業者1社・進捗率40%・巡回点検 実施・［簡単に修正］［日報を全部見る］", panel2.text.includes("日報：記入済み") && panel2.text.includes("作業人数4人") && panel2.text.includes("業者1社・1工種") && panel2.text.includes("進捗率40%") && panel2.text.includes("巡回点検実施") && panel2.btns.join("|") === "簡単に修正|日報を全部見る", panel2.text);
  await page.click('#dayPanelActions [data-day-go="quick"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const q = await page.evaluate(() => ({
    progress: document.getElementById("progressPercent").value, slider: document.querySelector("#reportForm .progress-slider-value").textContent, weather: document.getElementById("weather").value,
    vendor: document.querySelector(".company-row .companyName").value, start: document.querySelector(".company-row .workStart").value, remarks: document.getElementById("remarks").value, tomorrow: document.getElementById("tomorrowPlan").value,
    title: document.getElementById("reportQuickTitle").textContent, photosHidden: document.querySelector('[data-qsec="photos"]').offsetParent === null, flowShown: document.querySelector('[data-qsec="timeline"]').offsetParent !== null,
    flows: document.querySelectorAll("#timelineContainer .timeline-row").length
  }));
  check("10 簡単に修正: 既存の値（進捗率40%・曇り・協栄工業・08:00・連絡事項・明日の予定）を表示", q.progress === "40" && q.slider === "40%" && q.weather === "曇り" && q.vendor === "協栄工業" && q.start === "08:00" && q.remarks === "既存の連絡事項" && q.tomorrow === "足場点検", JSON.stringify(q));
  check("簡単に修正: よく変更する項目だけ（写真は隠す・流れは表示）・既存の日報に流れの初期値を足さない", q.title.includes("簡単に修正") && q.photosHidden && q.flowShown && q.flows === 0);
  await setSlider("#reportForm .progress-range", 65);
  await page.selectOption("#weather", "晴れ");
  await page.selectOption(".company-row .workStart", "07:30"); await page.selectOption(".company-row .workEnd", "17:30");
  await page.fill("#remarks", "足場の盛替えあり");
  await page.fill(".company-row .occupation", "足場・仮設"); // 15 工種の変更
  await page.click("#addCompanyBtn");
  const nr = page.locator(".company-row").last();
  await nr.locator(".companyName").fill("西原建設"); await nr.locator(".occupation").fill("足場"); await nr.locator(".actualWorkerCount").fill("2"); // 15 業者の追加（同じ工種を別の業者）
  await page.selectOption('.patrol-item-row[data-key="morningMeeting"] select', "bad"); // 16 巡回点検の変更
  await page.click("#reportSaveBtn"); const back2 = await backAtCalendar();
  const r2 = await getReport(ids.r2);
  check("11 進捗率の変更（40→65）", r2.progressPercent === 65);
  check("12 天気の変更（曇り→晴れ）", r2.weather === "晴れ");
  check("13 作業時間の変更（07:30～17:30）", r2.companies[0].workHours === "07:30～17:30");
  check("14 連絡事項の変更", r2.remarks === "足場の盛替えあり");
  check("15 業者・工種の変更（協栄工業＝足場・仮設、西原建設＝足場を追加。業者名から工種を推測しない）", r2.companies[0].companyName === "協栄工業" && r2.companies[0].occupation === "足場・仮設" && r2.companies[1].companyName === "西原建設" && r2.companies[1].occupation === "足場");
  check("16 巡回点検の変更（朝礼 ○→×）", r2.patrolChecklist.morningMeeting === "bad");
  check("21 過去日（9/2）を編集でき、カレンダーへ戻る", back2.saved === "2026-09-02" && back2.manage);
  check("27 請求人工は勝手に変わらない（4.5のまま・追加業者は未入力）", r2.companies[0].billingManDays === "4.5" && r2.companies[1].billingManDays === "");
  check("18 状態更新: 西原建設の署名・作業時間が無いので一部未記入", (await calState("02")) === "partial");
  const sig2 = await db(async (id) => (await (await import("/js/signatures.js")).listSignaturesByReport(id)).length, ids.r2);
  check("26 署名が消えない（9/2 の協栄工業）", sig2 === 1);
  void before2;

  // ===== 今日の確認事項: 何が・誰の・どの日付か を表示し、押すと日報の該当箇所へ =====
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  await page.$eval("#siteDashboard .dash-date-input", (el) => { el.value = "2026-09-02"; el.dispatchEvent(new Event("change", { bubbles: true })); }); await page.waitForTimeout(600);
  const att = await page.$$eval(".dash-att-go", (b) => b.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const head = await page.textContent(".dash-attention h4");
  check("15（今日の確認事項）日付と、誰の何が未入力かを表示（9/2・西原建設 作業時間・署名）", head.includes("9/2") && att.some((x) => x.includes("作業時間") && x.includes("西原建設")) && att.some((x) => x.includes("西原建設 署名未入力")), `${head} / ${att.join(" / ")}`);
  await page.locator(".dash-att-go", { hasText: "西原建設 署名未入力" }).click();
  await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500);
  const tgt = await page.evaluate(() => ({ row: document.querySelector(".is-target")?.closest(".company-row")?.querySelector(".companyName").value || "", isSig: !!document.querySelector(".foreman-signature-block.is-target") }));
  check("15（今日の確認事項）項目を押すとその日の日報の該当箇所（西原建設の職長サイン）へ移動", tgt.row === "西原建設" && tgt.isSig, JSON.stringify(tgt));
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");

  // ===== 34〜38 A3・PDF（同じ日報データから）=====
  const sheet = async (date) => db(async ([sid, d]) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((x) => x.siteId === sid && !x.isDeleted), signatures: [], date: d, kySubmissions: [] });
    return { html: buildTodaySheetHtml(m), flow: m.flow.filter((f) => f.kind === "flow").map((f) => `${f.time} ${f.title}`) };
  }, [ids.siteId, date]);
  const s10 = await sheet("2026-09-10");
  const p = await ctx.newPage(); await p.setContent(s10.html); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
  const a3 = await p.evaluate(() => { dispatchEvent(new Event("beforeprint")); return { over: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1).map((c) => c.closest("[data-section]")?.dataset.section), flow: [...document.querySelectorAll("table.flow tr:not(.dlv)")].map((tr) => `${tr.querySelector(".t").textContent} ${tr.querySelector(".ti").textContent}`), text: document.body.textContent }; });
  const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1"); await p.close();
  check("34 A3印刷に日報の流れ（変更・追加・削除後）が時刻順で載る（画面と同じ）", a3.flow.join(" / ") === "08:00 朝礼 / 08:30 作業 / 09:30 打ち合わせ / 12:00 昼休憩 / 13:00 昼礼 / 15:00 現場巡回3階巡回 / 17:00 片付け開始 / 17:00 作業終了", a3.flow.join(" / "));
  check("35・36 PDF（A3横・1ページ）・欄からあふれない・請求人工なし", (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) && a3.over.length === 0 && !a3.text.includes("請求"), a3.over.join(","));
  // 情報の多い日（初期値8件＋追加・搬入搬出6件・業者8社）でもA3一枚に収まる
  const heavy = await db(async () => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { defaultWorkdayTimeline } = await import("/js/dashboard/dailyFlow.js");
    const timeline = [...defaultWorkdayTimeline(), { time: "09:30", kind: "uchiawase", title: "設備打合せ", status: "plan" }, { time: "13:30", kind: "patrol", title: "現場巡回", status: "plan" }, { time: "14:00", kind: "inspection", title: "配筋検査", status: "plan" }].map((r, i) => ({ ...r, id: "t" + i }));
    const companies = Array.from({ length: 8 }, (_, i) => ({ companyId: "c" + i, companyName: `業者${i + 1}工業`, occupation: ["塗装", "足場", "防水", "電気", "設備", "内装", "左官", "鉄筋"][i], actualWorkerCount: "3", plannedWorkerCount: "3", workHours: "08:00～17:00", workContent: "外壁面の補修および養生、足場周りの清掃", safetyNotes: "高所作業時は安全帯を使用", machinery: "高所作業車" }));
    const deliveries = Array.from({ length: 6 }, (_, i) => ({ id: "d" + i, direction: i % 2 ? "out" : "in", time: `${String(8 + i).padStart(2, "0")}:30`, item: "資材" + i, quantity: "10", vendor: "サンプル商事", origin: "倉庫", destination: "現場", vehicle: "4t", status: "plan" }));
    const r = { id: "r", siteId: "s", date: "2026-10-05", dayStatus: "work", weather: "晴れ", progressPercent: 50, companies, timeline, deliveries, remarks: "連絡事項1\n連絡事項2", tomorrowPlan: "明日の予定", focusInstructions: "重点1\n重点2", workCoordination: "調整1" };
    return buildTodaySheetHtml(buildDashboardModel({ site: { id: "s", name: "情報の多い日", startDate: "2026-09-01", endDate: "2026-12-20" }, reports: [r], signatures: [], date: "2026-10-05", kySubmissions: [] }));
  });
  const ph = await ctx.newPage(); await ph.setContent(heavy); await ph.emulateMedia({ media: "print" }); await ph.waitForTimeout(300);
  const hv = await ph.evaluate(() => { dispatchEvent(new Event("beforeprint")); return { over: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]")?.dataset.section), flows: document.querySelectorAll("table.flow tr").length }; });
  const hpdf = Buffer.from(await ph.pdf({ preferCSSPageSize: true })).toString("latin1"); await ph.close();
  check("36 情報の多い日（流れ11件＋搬入搬出6件・業者8社）でもA3一枚・欄からあふれない（項目は削らない）", (hpdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && hv.over.length === 0 && hv.flows === 17, `${hv.over.join(",")} 流れ${hv.flows}行`);
  const s20 = await sheet("2026-09-20");
  const s12 = await sheet("2026-09-12");
  const s13 = await sheet("2026-09-13");
  check("37 日報なしの日（9/20）は架空の流れを表示しない", s20.flow.length === 0 && !s20.html.includes("片付け開始"));
  check("38 特殊な日（休工日 9/12・雨天作業不可日 9/13）に通常作業の流れを表示しない", s12.flow.length === 0 && s13.flow.length === 0 && !s12.html.includes("片付け開始") && !s13.html.includes("片付け開始"));

  // ===== 40・42〜45 既存の出力（Excel・PDF・巡回点検）=====
  const out = await db(async (id) => {
    const { generateReportOutput } = await import("/js/report-output/index.js");
    const { buildReportPrintHtml } = await import("/js/reportPrint.js");
    const x = await generateReportOutput({ reportId: id, format: "excel" });
    const pdfHtml = await buildReportPrintHtml(id);
    return { excel: x.filename, size: x.blob.size, pdfLen: pdfHtml.html.length, hasVendor: pdfHtml.html.includes("協栄工業") };
  }, ids.r2);
  check("29・43 Excel出力（修正した9/2の日報）が作れる", /\.(xlsx|csv)$/.test(out.excel) && out.size > 0, out.excel);
  check("30・44 PDF（印刷用）出力に修正後の内容が載る", out.pdfLen > 1000 && out.hasVendor);
  const patrol = await db(async (id) => { const { patrolStatusOf } = await import("/js/patrolChecklist.js"); return patrolStatusOf(await (await import("/js/db.js")).dbGet("reports", id)).label; }, ids.r2);
  check("40 巡回点検が壊れない（×の項目 → 要確認）", patrol === "要確認");

  // ===== 46 バックアップ・復元 =====
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "cal-edit-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 7, null, { timeout: 20000 });
  const restored = await p3.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.date === "2026-09-10"));
  check("46 バックアップ・復元で日報の流れ（変更・追加・削除後）が保たれる", JSON.stringify(restored.timeline) === JSON.stringify((await reportOf("2026-09-10")).timeline));
  await ctx2.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
