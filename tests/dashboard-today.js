// ダッシュボードの「今日の状態」「今日の確認事項・要確認」「昨日→今日」「現場概要」と日報カレンダー、
// 日の状態（通常作業／作業なし／休工日）の検証（実ブラウザ・実IndexedDB。データは架空）
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/dashboard-today.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-today-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  // 工期 2026-09-01〜09-30。9/2 通常作業、9/3 通常作業（入力そろい）、9/4 作業なし、9/5 休工日、9/6 日報なし
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "今日の確認現場", startDate: "2026-09-01", endDate: "2026-09-30", constructionNumber: "T-001" });
    const mk = (date, extra) => stampNew({ siteId: site.id, date, weather: "晴れ", ...extra });
    const d2 = mk("2026-09-02", { progressPercent: 38, companies: [{ companyId: "a", companyName: "サンプル塗装", occupation: "塗装工", actualWorkerCount: "10", workHours: "08:00～17:00" }, { companyId: "b", companyName: "サンプル足場", occupation: "とび工", actualWorkerCount: "8", workHours: "08:00～17:00", billingManDays: "7.5" }], patrolChecklist: { morningMeeting: "good" } });
    const d3 = mk("2026-09-03", { progressPercent: 41, focusInstructions: "開口部の養生確認", workCoordination: "午後は区画を分ける", remarks: "元請から連絡あり",
      companies: [{ companyId: "a", companyName: "サンプル塗装", occupation: "塗装工", actualWorkerCount: "12", workHours: "08:00～17:00" }, { companyId: "b", companyName: "サンプル足場", occupation: "とび工", actualWorkerCount: "8", workHours: "08:00～12:00", billingManDays: "4" }, { companyId: "c", companyName: "サンプル電気", occupation: "電工", actualWorkerCount: "2" }],
      patrolChecklist: { morningMeeting: "good", openingUsage: "bad" }, patrolComment: "3階開口部を復旧",
      deliveries: [{ id: "x", direction: "in", time: "09:00", item: "塗料", status: "done" }, { id: "y", direction: "out", time: "15:00", item: "残材", status: "plan" }] });
    const d4 = mk("2026-09-04", { dayStatus: "nowork", companies: [{ companyId: "a", companyName: "サンプル塗装", occupation: "塗装工", actualWorkerCount: "3" }] });
    const d5 = mk("2026-09-05", { dayStatus: "holiday", remarks: "日曜のため休工" });
    for (const r of [d2, d3, d4, d5]) await dbPut("reports", r);
    // 9/3 は塗装・足場に職長サインあり、電気は無し
    const cv = document.createElement("canvas"); cv.width = 60; cv.height = 20; cv.getContext("2d").fillRect(1, 1, 30, 5);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    for (const cid of ["a", "b"]) await dbPut("signatures", stampNew({ reportId: d3.id, companyId: cid, role: "foreman", roleLabel: "職長", imageBlob: blob, signedAt: new Date().toISOString() }));
    for (const cid of ["a", "b"]) await dbPut("signatures", stampNew({ reportId: d2.id, companyId: cid, role: "foreman", roleLabel: "職長", imageBlob: blob, signedAt: new Date().toISOString() }));
    return { siteId: site.id, d3: d3.id, d4: d4.id };
  });
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  const at = async (date) => { await page.fill("#siteDashboard .dash-date-input", date); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
    return page.evaluate(() => ({ text: document.getElementById("siteDashboard").textContent.replace(/\s+/g, " "), state: document.querySelector("#siteDashboard .dash-state")?.textContent || "", att: [...document.querySelectorAll("#siteDashboard .dash-attention li")].map((l) => l.textContent.replace(/\s+/g, " ")), checks: Object.fromEntries([...document.querySelectorAll("#siteDashboard .dash-checks dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])), compare: [...document.querySelectorAll("#siteDashboard .dash-compare tbody tr")].map((tr) => tr.textContent.replace(/\s+/g, "")), vendors: document.querySelectorAll("#siteDashboard .dash-vendors tbody tr").length, firstCard: document.querySelector("#siteDashboard .dash-panel[data-panel=manage] .dash-card h3")?.textContent, boardCards: [...document.querySelectorAll("#siteDashboard .dash-panel[data-panel=board] .dash-card h3")].map((h) => h.textContent) })); };

  const d3 = await at("2026-09-03");
  check("配置: 「監督管理」タブの最初のカードが「今日の確認事項」・「現場掲示」タブには確認事項・日誌状況・巡回点検を出さない", d3.firstCard.includes("今日の確認事項") && d3.boardCards[0].includes("業者別 稼働状況") && !d3.boardCards.some((t) => /確認事項|日誌状況|巡回点検|現場概要|昨日/.test(t)), d3.boardCards.join(" / "));
  check("今日の確認事項: 日報・進捗率41%・業者3社・作業員22人・作業時間（電気が未入力）・重点指示・連絡調整・搬入", d3.checks["日報"] === "入力済み（通常作業）" && d3.checks["進捗率"] === "41%" && d3.checks["業者"] === "3社" && d3.checks["作業員数"] === "22人" && d3.checks["作業時間"] === "サンプル電気 未入力" && d3.checks["本日の重点指示"] === "入力済み" && d3.checks["作業間の連絡・調整"] === "入力済み" && d3.checks["搬入・搬出"] === "2件（完了1・予定1）", JSON.stringify(d3.checks));
  check("要確認: 作業時間（電気）・署名（電気）・巡回点検・要確認（×1件・是正指示あり）・巡回点検の未記入", d3.att.length === 4 && d3.att.some((a) => a.includes("サンプル電気") && a.includes("署名未入力")) && d3.att.includes("巡回点検・要確認 × 1件・是正指示あり") && d3.att.some((a) => a.startsWith("巡回点検 未記入")), d3.att.join(" / "));
  check("昨日→今日（9/2→9/3）: 作業員 18→22人・人工（1人＝1人工）18→22・進捗率 38→41%・業者 2→3社（請求人工7.5・4は使わない）", d3.compare.join("|") === "作業員18人→22人|人工18→22|進捗率38%→41%|業者数2社→3社", d3.compare.join(" | "));
  check("人工: 現場概要の人工は稼働人数と同じ22・請求人工はダッシュボードに出さない", d3.text.includes("人工22") && !d3.text.includes("請求"), (d3.text.match(/人工[^業]{0,12}/g) || []).join(" / "));
  check("現場概要: 工事番号・進捗率・本日稼働・人工・業者・要確認件数・重点指示", /工事番号T-001/.test(d3.text) && d3.text.includes("本日稼働22人") && d3.text.includes("要確認4件") && d3.text.includes("本日の重点指示: 開口部の養生確認"));
  check("指示・連絡: 本日の重点指示・作業間の連絡・調整・連絡事項が表示される", d3.text.includes("開口部の養生確認") && d3.text.includes("午後は区画を分ける") && d3.text.includes("元請から連絡あり"));

  const d4 = await at("2026-09-04");
  check("作業なし: 「本日は作業なし」・業者別稼働状況を出さない・稼働人数に数えない", d4.state.includes("本日は作業なし") && d4.vendors === 0 && d4.compare[0] === "作業員22人→作業なし", d4.compare[0]);
  const d5 = await at("2026-09-05");
  check("休工日: 「本日は休工日」・連絡事項は表示", d5.state.includes("本日は休工日") && d5.text.includes("日曜のため休工") && d5.compare[0] === "作業員作業なし→休工日", d5.compare[0]);
  const d6 = await at("2026-09-06");
  check("日報なし（9/6）: 「日報は未入力」・要確認「日報 未入力」（作業なし・休工日とは別）", d6.state.includes("未入力") && d6.att[0] === "日報 未入力" && d6.compare[0] === "作業員休工日→日報なし");
  // 累計: 9/4（作業なし）の塗装3人は累計に数えない
  const d6staff = (d6.text.match(/累計（社員を含む）(\d+)人/) || [])[1];
  check("累計: 作業なしの日の人数を数えない（18+22=40人）", d6staff === "40", d6staff);

  // カレンダー（9月）
  check("日報カレンダーは「監督管理」タブの中にある", await page.evaluate(() => !!document.querySelector("#siteDashboard .dash-panel[data-panel=manage] #reportCalendar")));
  const cal = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")].map((b) => [b.dataset.date.slice(8), b.className.replace(/cal-cell |cal-today/g, "").trim()])));
  check("カレンダー: 9/2 は日報あり（入力がそろっている）、9/3 は一部未入力（電気の作業時間・署名）、9/4 作業なし、9/5 休工日、9/1・9/6 日報なし", cal["02"] === "cal-ok" && cal["03"] === "cal-partial" && cal["04"] === "cal-nowork" && cal["05"] === "cal-holiday" && cal["01"] === "cal-none" && cal["06"] === "cal-none", JSON.stringify({ "01": cal["01"], "02": cal["02"], "03": cal["03"], "04": cal["04"], "05": cal["05"], "06": cal["06"] }));
  await page.click("#siteDashboard .dash-tab[data-tab=manage]"); // 日報カレンダーは「監督管理」タブ
  await page.click("#reportCalendar .cal-cell[data-date='2026-09-04']"); await page.waitForSelector("#view-report-form:not([hidden])");
  check("カレンダー: 日付を押すとその日の日報が開き、日の状態「作業なし」が選ばれている", (await page.inputValue("#dayStatus")) === "nowork" && (await page.inputValue("#date")) === "2026-09-04");
  // 日の状態を画面で変えて保存
  await page.selectOption("#dayStatus", "holiday"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const saved = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).dayStatus, ids.d4);
  check("日の状態を画面で休工日に変えて保存できる", saved === "holiday");
  await page.selectOption("#reportListFilter", "holiday"); await page.waitForTimeout(300);
  const cards = await page.$$eval("#reportList .report-card", (els) => els.map((e) => e.textContent));
  check("日報一覧: 絞り込み「休工日」で 9/4・9/5 が出て、「休工日」の印が付く", cards.length === 2 && cards.every((t) => t.includes("休工日")));
  // ===== 巡回点検の表示（ケース1〜5）=====
  const patrolCase = await page.evaluate(async (siteId) => {
    const { dbPut, dbGetAll } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { PATROL_CHECKLIST_ITEMS } = await import("/js/patrolChecklist.js");
    const allGood = Object.fromEntries(PATROL_CHECKLIST_ITEMS.map((i) => [i.key, "good"]));
    const mk = (date, extra) => stampNew({ siteId, date, progressPercent: 50, companies: [], ...extra });
    await dbPut("reports", mk("2026-09-10", { patrolChecklist: allGood }));
    await dbPut("reports", mk("2026-09-11", { patrolChecklist: { ...allGood, scaffoldBridge: "bad", openingUsage: "bad" } }));
    await dbPut("reports", mk("2026-09-12", { patrolChecklist: { ...allGood, scaffoldBridge: "bad" }, patrolComment: "足場の手すりを復旧すること" }));
    await dbPut("reports", mk("2026-09-13", { patrolChecklist: allGood, patrolComment: "安全通路の資材を片付けること" }));
    return JSON.stringify((await dbGetAll("reports")).map((r) => [r.id, r.patrolChecklist, r.patrolComment]).sort());
  }, ids.siteId);
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  const patrolOf = async (date) => { const d = await at(date); return { ...d, card: await page.evaluate(() => [...document.querySelectorAll("#siteDashboard .dash-card")].find((c) => c.querySelector("h3").textContent.includes("巡回点検"))?.textContent.replace(/\s+/g, " ") || "") }; };
  const c1 = await patrolOf("2026-09-10");
  check("巡回点検 ケース1: 全項目○ → 要確認に出ない（「全項目 記入済み（×なし）」）", !c1.att.some((a) => a.startsWith("巡回点検")) && c1.checks["巡回点検"] === "全項目 記入済み（×なし）" && !c1.card.includes("巡回点検・要確認"), c1.checks["巡回点検"]);
  const c2 = await patrolOf("2026-09-11");
  check("巡回点検 ケース2: × → 「巡回点検・要確認」に×の項目が出る", c2.att.includes("巡回点検・要確認 × 2件") && c2.card.includes("巡回点検・要確認") && c2.card.includes("足場,桟橋 ×") && c2.card.includes("開口部"), c2.att.join(" / "));
  const c3 = await patrolOf("2026-09-12");
  check("巡回点検 ケース3: ×＋是正指示 → 「巡回点検・要確認 × 1件・是正指示あり」と是正指示の文章", c3.att.includes("巡回点検・要確認 × 1件・是正指示あり") && c3.card.includes("是正指示あり") && c3.card.includes("足場の手すりを復旧すること"), c3.att.join(" / "));
  const c4 = await patrolOf("2026-09-13");
  check("巡回点検 ケース4: 是正指示だけ（対応済みの記録は無い）→ 「要確認」にとどめ、「未対応」とは表示しない", c4.att.includes("巡回点検・要確認 是正指示あり（×の項目なし）") && !c4.text.includes("未対応") && !c2.text.includes("未対応") && !c3.text.includes("未対応"), c4.att.join(" / "));
  const afterPatrol = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).map((r) => [r.id, r.patrolChecklist, r.patrolComment]).sort()));
  check("巡回点検 ケース5: ダッシュボードを表示しても巡回点検のデータ（件数・内容）は変わらない", afterPatrol === patrolCase);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
