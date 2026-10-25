// 業者管理（#/sites/:id/vendors）の［業者別稼働］の「累計実績人工」と「期間を指定して集計」（2026-10-20）を確かめる（架空データ・Chromium・隔離したプロファイル）
//   累計実績人工＝選んだ月の末日（今月は今日）までのすべての日報の実績人工（通常作業の日だけ・1人＝1人工・請求人工は使わない）。
//   その月に稼働していなくても、それより前に稼働した業者は表示する（その月の欄は0）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-cum-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const monthLabel = (m) => { const [y, mm] = m.split("-").map(Number); return `${y}年${mm}月`; };
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const thisMonth = today.slice(0, 7);
  const ids = await page.evaluate(async (today) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "累計実績人工の確認現場", startDate: "2026-08-01", endDate: "2027-03-31" });
    const row = (id, name, n, billing = "", trade = "塗装") => ({ companyId: id, companyName: name, occupation: trade, actualWorkerCount: String(n), workHours: "08:00～17:00", billingManDays: billing });
    const mk = (date, companies, dayStatus = "work") => stampNew({ siteId: site.id, date, dayStatus, companies, siteSupervisorNames: [] });
    const plusDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const list = [
      mk("2025-12-15", [row("p1", "甲工業", 4)]), // 工期開始日（2026-08-01）より前（月・累計・期間のどれにも数えない）
      mk("2026-01-10", [row("p2", "甲工業", 1), row("p3", "甲工業", 2, "", "防水"), row("p4", "乙建設", 2)]), // 同じ業者が2つの工種（1日・3人）
      mk("2026-08-06", [row("d1", "丁組", 5)], "holiday"), // 丁組は休工日と0人の日しかない（一度も稼働していない）
      mk("2026-08-08", [row("d2", "丁組", 0)]),
      mk("2026-08-03", [row("a1", "甲工業", 3, "7.5"), row("b1", "乙建設", 2)]),
      mk("2026-08-04", [row("a2", "甲工業", 2, "9.9")]), // 請求人工 9.9 は実績人工に混ぜない
      mk("2026-08-06", [row("b2", "乙建設", 4)], "holiday"), // 休工日（数えない）
      mk("2026-08-07", [row("b3", "乙建設", 5)], "rain"), // 雨天作業不可日（数えない）
      mk("2026-09-10", [row("a3", "甲工業", 1)]),
      mk(`${today.slice(0, 7)}-01`, [row("a4", "甲工業", 2)]),
      mk(plusDays(today, 2), [row("a5", "甲工業", 9)]) // 今日より後（数えない）
    ];
    for (const r of list) await dbPut("reports", r);
    // 現場B（工期開始 2025-12-01）: 年をまたぐ期間と、同じ日に同じ業者が2つの工種の行にある日（どちらも工期開始日以降）
    const siteB = await createSite({ name: "年またぎの確認現場", startDate: "2025-12-01", endDate: "2027-03-31" });
    const mkB = (date, companies) => stampNew({ siteId: siteB.id, date, dayStatus: "work", companies, siteSupervisorNames: [] });
    for (const r of [mkB("2025-12-15", [row("q1", "甲工業", 4)]), mkB("2026-01-10", [row("q2", "甲工業", 1), row("q3", "甲工業", 2, "", "防水"), row("q4", "乙建設", 2)])]) await dbPut("reports", r);
    // 現場C（工期開始 2026-08-01）: 工期開始日の前日・当日・翌日
    const siteC = await createSite({ name: "工期開始日の確認現場", startDate: "2026-08-01", endDate: "2027-03-31" });
    const mkC = (date, n, billing) => stampNew({ siteId: siteC.id, date, dayStatus: "work", companies: [row("x" + date, "戊電気", n, billing)], siteSupervisorNames: [] });
    const cList = [mkC("2026-07-31", 3, "5"), mkC("2026-08-01", 2, "2"), mkC("2026-08-02", 4, "")];
    for (const r of cList) await dbPut("reports", r);
    return { site: site.id, siteB: siteB.id, siteC: siteC.id, c0731: cList[0].id, sep: list[8].id, aug4: list[5].id, oct1: list[9].id };
  }, today);

  const open = async (siteId = ids.site) => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${siteId}/vendors`); await page.waitForSelector("#vendorMgmtMonth"); await page.waitForTimeout(300); };
  const selectMonth = async (m) => { await page.selectOption("#vendorMgmtMonth", m); await page.waitForTimeout(250); };
  // 行: [業者, 稼働日数, 稼働人数, 実績人工, 作業時間, 累計実績人工]
  const table = () => page.evaluate(() => {
    const t = document.querySelector("#vendorMgmtBody .vm-activity"); if (!t) return null;
    const cell = (c) => c.textContent.replace(/\s+/g, "");
    return { head: [...t.tHead.rows[0].cells].map(cell), rows: [...t.tBodies[0].rows].filter((tr) => tr.classList.contains("vm-vendor-row")).map((tr) => ({ idle: tr.classList.contains("vm-row-idle"), vendor: tr.querySelector(".vm-vendor").textContent.trim(), cells: [...tr.cells].map(cell) })), foot: [...t.tFoot.rows[0].cells].map(cell) };
  });
  const map = (t) => Object.fromEntries(t.rows.map((r) => [r.vendor, { month: r.cells.slice(1, 5).join("|"), cum: r.cells[5], idle: r.idle }]));

  await open();
  // ---- 8月 ----
  await selectMonth("2026-08");
  let t = await table(); let m = map(t);
  check("1 選んだ月（8月）の実績人工: 甲工業 2日・5人・5、乙建設 1日・2人・2（休工日・雨天作業不可日は数えない）", m["甲工業"]?.month.startsWith("2日|5人|5|") && m["乙建設"]?.month.startsWith("1日|2人|2|"), JSON.stringify(m));
  check("2 累計実績人工の列があり、8月は 8/31 までの合計（甲工業 5・乙建設 2）", t.head[5].startsWith("累計実績人工") && t.head[5].includes("8/31") && m["甲工業"]?.cum === "5" && m["乙建設"]?.cum === "2", JSON.stringify(t.head));
  check("8 請求人工（7.5・9.9）は実績人工・累計実績人工に入らない（甲工業 8月の実績人工 5・累計 5）", m["甲工業"]?.month.startsWith("2日|5人|5|") && m["甲工業"]?.cum === "5");
  check("6 合計行（8月）: 2社・3日・7人・実績人工 7・累計実績人工 7", t.foot[0].includes("2社") && t.foot[1] === "3日" && t.foot[2] === "7人" && t.foot[3] === "7" && t.foot[5] === "7", JSON.stringify(t.foot));
  // ---- 9月 ----
  await selectMonth("2026-09");
  t = await table(); m = map(t);
  check("2 累計実績人工は工期の初めから選んだ月の末日まで（9月: 甲工業 5+1=6）", m["甲工業"]?.month.startsWith("1日|1人|1|") && m["甲工業"]?.cum === "6", JSON.stringify(m));
  check("4・5 9月に稼働していない乙建設も表示し、9月の欄は0（0日・0人・0）、累計は8月の実績（2）", m["乙建設"]?.idle === true && m["乙建設"]?.month.startsWith("0日|0人|0|") && m["乙建設"]?.cum === "2", JSON.stringify(m["乙建設"]));
  check("6 合計行（9月）: 9月に稼働したのは1社（累計は2社）・1日・1人・実績人工 1・累計実績人工 8", t.foot[0].includes("1社") && t.foot[0].includes("累計2社") && t.foot[1] === "1日" && t.foot[2] === "1人" && t.foot[3] === "1" && t.foot[5] === "8", JSON.stringify(t.foot));
  check("並び順は従来どおり業者名の順（甲工業・乙建設）", t.rows.map((r) => r.vendor).join("・") === ["甲工業", "乙建設"].sort((a, b) => a.localeCompare(b, "ja")).join("・"), t.rows.map((r) => r.vendor).join("・"));
  // ---- 今月 ----
  await selectMonth(thisMonth);
  t = await table(); m = map(t);
  check("3 今月は今日までの日報だけ（今日より後の 9人 は入れない。甲工業 今月 2・累計 8）", m["甲工業"]?.month.startsWith("1日|2人|2|") && m["甲工業"]?.cum === "8" && t.head[5].includes(`${+today.slice(5, 7)}/${+today.slice(8, 10)}`), JSON.stringify({ m, head: t.head[5] }));
  check("6 合計行（今月）: 累計実績人工 10（甲工業 8＋乙建設 2）", t.foot[5] === "10", JSON.stringify(t.foot));
  check("5 工期開始日（8/1）より前の日報（2025年12月・2026年1月）は累計に入れない（今月の甲工業の累計 8・乙建設 2）", m["甲工業"]?.cum === "8" && m["乙建設"]?.cum === "2");
  check("8 一度も稼働していない業者（丁組: 休工日と0人の日だけ）は表示しない", !m["丁組"], JSON.stringify(Object.keys(m)));

  // ===== 期間を指定して集計 =====
  const setPeriod = async (from, to) => { await page.selectOption(".vm-period-from", from); await page.waitForTimeout(250); await page.selectOption(".vm-period-to", to); await page.waitForTimeout(250); };
  const period = () => page.evaluate(() => {
    const sec = document.querySelector("#vendorMgmtBody .vm-period"); if (!sec) return null;
    const t = sec.querySelector(".vm-period-table"); const cell = (c) => c.textContent.replace(/\s+/g, "");
    // 画面の列の順は「業者・期間合計・稼働日数・月ごと」。下の確認は「月ごと…・期間合計・稼働日数」の順に並べ直して比べる（displayHead は画面の順のまま）
    const reorder = (xs) => [...xs.slice(2), xs[0], xs[1]];
    const headCells = t ? [...t.tHead.rows[0].cells].map(cell) : [];
    return { label: sec.querySelector(".vm-period-label")?.textContent.replace(/\s+/g, "") || "", error: sec.querySelector(".vm-period-error")?.textContent || "", displayHead: headCells, head: t ? [headCells[0], ...reorder(headCells.slice(1))] : [],
      rows: t ? [...t.tBodies[0].rows].filter((tr) => tr.classList.contains("vm-vendor-row")).map((tr) => ({ vendor: tr.querySelector(".vm-vendor").textContent.trim(), idle: tr.classList.contains("vm-row-idle"), cells: reorder([...tr.cells].slice(1).map(cell)) })) : [], foot: t ? reorder([...t.tFoot.rows[0].cells].slice(1).map(cell)) : [] };
  });
  const pm = (p) => Object.fromEntries(p.rows.map((r) => [r.vendor, r]));
  await selectMonth("2026-08");
  let pr = await period();
  check("期間の集計の初期値は、表示している月の1か月（2026年8月～2026年8月）", pr && pr.label.includes("2026年8月") && !pr.label.includes("～2026年9月"), pr?.label);
  check("9 1か月だけ（8月）: 甲工業 5（期間合計 5・2日）、乙建設 2、合計 7", pm(pr)["甲工業"]?.cells.join("|") === "5|5|2日" && pm(pr)["乙建設"]?.cells.join("|") === "2|2|1日" && pr.foot.join("|") === "7|7|3日", JSON.stringify(pr.rows));
  await setPeriod("2026-08", thisMonth);
  pr = await period();
  const nMonths = pr.head.length - 3;
  const ga = pm(pr)["甲工業"]?.cells || [];
  check("10・13・14 8月～今月: 月ごとの実績人工（甲工業 8月 5・9月 1・…・今月 2。稼働の無い月は0）と期間合計（月ごとの合計＝8）、今日より後は入れない", ga[0] === "5" && ga[1] === "1" && ga[nMonths - 1] === "2" && ga.slice(0, nMonths).reduce((x, y) => x + Number(y), 0) === 8 && ga[nMonths] === "8", JSON.stringify({ head: pr.head, ga }));
  check("列の順: 業者・期間合計・稼働日数・月ごと（大事な合計が左に来る）", pr.displayHead[0] === "業者" && pr.displayHead[1].startsWith("期間合計") && pr.displayHead[2] === "稼働日数" && pr.displayHead[3] === "8月", JSON.stringify(pr.displayHead));
  check("13 合計の行: 月ごとの合計（8月 7・9月 1・今月 2）と期間合計 10 が一致", pr.foot[0] === "7" && pr.foot[1] === "1" && pr.foot[nMonths - 1] === "2" && pr.foot[nMonths] === "10" && pr.foot.slice(0, nMonths).reduce((x, y) => x + Number(y), 0) === 10, JSON.stringify(pr.foot));
  check("19 別の業者の実績が混ざらない（乙建設 8月 2・期間合計 2）", pm(pr)["乙建設"]?.cells[0] === "2" && pm(pr)["乙建設"]?.cells[nMonths] === "2");
  await setPeriod("2025-12", "2026-01");
  pr = await period();
  check("工期開始日より前（2025年12月～2026年1月）を期間に指定しても、工期開始日より前の日報は数えない（業者は出ない）", pr && pr.rows.length === 0 && !pr.error, JSON.stringify(pr?.rows));
  // 年をまたぐ期間は、工期開始日が早い現場Bで確かめる
  await open(ids.siteB); await selectMonth("2026-01"); await setPeriod("2025-12", "2026-01");
  pr = await period();
  check("11・20・21 年をまたぐ期間（現場B: 2025年12月～2026年1月）: 見出しに年、甲工業 12月 4・1月 3（同じ日の2つの工種は1日・3人として1回だけ）＝7・2日、乙建設 0・2＝2", pr.head[1].startsWith("2025年12月") && pr.head[2].startsWith("2026年1月") && pm(pr)["甲工業"]?.cells.join("|") === "4|3|7|2日" && pm(pr)["乙建設"]?.cells.join("|") === "0|2|2|1日" && pr.foot.join("|") === "4|5|9|3日", JSON.stringify({ head: pr.head, rows: pr.rows, foot: pr.foot }));
  // ===== 工期開始日の前日・当日・翌日（現場C: 工期開始 8/1。7/31 3人・8/1 2人・8/2 4人） =====
  await open(ids.siteC); await selectMonth("2026-07");
  const c7 = await table();
  check("1 工期開始日より前（7月）の月の表: 7/31 の日報は数えない（業者は出ない）", c7 === null || c7.rows.length === 0, JSON.stringify(c7?.rows));
  await setPeriod("2026-07", "2026-08");
  pr = await period();
  check("1・2・3・6 期間（7月～8月）に工期開始日より前の日が入っていても数えない: 戊電気 7月 0・8月 6（当日 8/1 の2人と翌日 8/2 の4人）＝期間合計 6・2日、合計の行も 0・6・6", pm(pr)["戊電気"]?.cells.join("|") === "0|6|6|2日" && pr.foot.join("|") === "0|6|6|2日", JSON.stringify({ rows: pr.rows, foot: pr.foot }));
  await selectMonth("2026-08");
  const c8 = await table(); const cm8 = map(c8);
  check("4・5 月の表（8月）と累計: 戊電気 2日・6人・実績人工 6・累計 6（7/31 は入らない）＝期間合計と一致", cm8["戊電気"]?.month.startsWith("2日|6人|6|") && cm8["戊電気"]?.cum === "6", JSON.stringify(cm8));
  await setPeriod("2026-07", "2026-08");
  await page.click('[data-vm-period-vendor="戊電気"]'); await page.waitForTimeout(250);
  const cdet = await page.evaluate(() => ({ days: [...document.querySelectorAll(".vm-period-days tbody tr")].map((tr) => [tr.cells[0].textContent.trim(), tr.cells[2].textContent.replace(/\s+/g, "")]), summary: document.querySelector(".vm-summary")?.textContent.replace(/\s+/g, "") || "" }));
  check("7 期間の日別の詳細: 8/1（当日）と 8/2 の2日だけ（7/31 は出ない）、日ごとの合計 6＝期間合計", cdet.days.length === 2 && cdet.days[0][0].endsWith("8/1") && cdet.days[1][0].endsWith("8/2") && cdet.summary.includes("実績人工（期間合計）6"), JSON.stringify(cdet));
  await page.click(".vm-back"); await page.waitForTimeout(200);
  await page.click('.vm-activity [data-vm-vendor="戊電気"]'); await page.waitForTimeout(250);
  const cmdet = await page.evaluate(() => ({ rows: document.querySelectorAll(".vm-days tbody tr").length, summary: document.querySelector(".vm-summary")?.textContent.replace(/\s+/g, "") || "" }));
  check("7 月（8月）の日別の詳細: 2日・実績人工 6", cmdet.rows === 2 && cmdet.summary.includes("稼働日2日") && cmdet.summary.includes("実績人工6"), JSON.stringify(cmdet));
  await page.click(".vm-back"); await page.waitForTimeout(200);
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].billingManDays = "50"; r.companies[0].actualWorkerCount = "9"; await dbPut("reports", r); }, ids.c0731);
  await open(ids.siteC); await selectMonth("2026-08"); await setPeriod("2026-07", "2026-08");
  pr = await period();
  check("8 工期開始日より前の日報の実績人数・請求人工を変えても、集計は変わらない（期間合計 6）", pm(pr)["戊電気"]?.cells.join("|") === "0|6|6|2日", JSON.stringify(pr.rows));
  // 現場Aに戻る
  await open(); await selectMonth("2026-08");
  await setPeriod("2026-09", "2026-09");
  pr = await period();
  check("15 期間（9月）に稼働していない乙建設も、それより前に稼働していれば表示し、期間の欄は0", pm(pr)["乙建設"]?.idle === true && pm(pr)["乙建設"]?.cells.join("|") === "0|0|0日" && pr.foot[1] === "1", JSON.stringify(pr.rows));
  await page.selectOption(".vm-period-from", "2026-10"); await page.waitForTimeout(250);
  pr = await period();
  check("12 開始年月（10月）が終了年月（9月）より後: 集計を出さず、選び直すよう案内する", pr.error.includes("開始年月が終了年月より後") && pr.rows.length === 0, pr.error);
  // 16 期間の日別の詳細
  await setPeriod("2026-08", thisMonth);
  await page.click('[data-vm-period-vendor="甲工業"]'); await page.waitForTimeout(250);
  const det = await page.evaluate(() => ({ title: document.querySelector(".vm-detail-title")?.textContent || "", summary: document.querySelector(".vm-summary")?.textContent.replace(/\s+/g, "") || "", months: document.querySelector(".vm-period-months")?.textContent.replace(/\s+/g, "") || "", days: [...document.querySelectorAll(".vm-period-days tbody tr")].map((tr) => tr.cells[2].textContent.replace(/\s+/g, "")) }));
  const daySum = det.days.reduce((x, d) => x + Number(d.replace(/[^0-9]/g, "")), 0);
  check("16 期間の日別の詳細: 甲工業の稼働日4日（8/3・8/4・9/10・今月1日）、日ごとの合計 8＝期間合計、月ごとの小計（8月 5・9月 1・今月 2）", det.days.length === 4 && daySum === 8 && det.summary.includes("実績人工（期間合計）8") && det.months.includes("2026年8月5（2日）") && det.months.includes("2026年9月1（1日）") && det.months.includes(`${monthLabel(thisMonth)}2（1日）`), JSON.stringify(det));
  await page.click(".vm-back"); await page.waitForTimeout(200);
  check("詳細から戻ると、期間の集計（8月～今月）のまま", (await period())?.rows.length >= 2 && (await page.$eval(".vm-period-from", (e) => e.value)) === "2026-08");
  // 22 請求人工を変えても実績人工は変わらない
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].billingManDays = "99"; await dbPut("reports", r); }, ids.aug4);
  await open(); await setPeriod("2026-08", "2026-08");
  pr = await period();
  check("22 請求人工を 9.9→99 に変えても、実績人工（8月 甲工業 5）は変わらない", pm(pr)["甲工業"]?.cells[0] === "5" && pm(pr)["甲工業"]?.cells[1] === "5");

  // ---- 7 日報の修正・追加が反映される ----
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js"); const r = await dbGet("reports", id); r.companies[0].actualWorkerCount = "4"; await dbPut("reports", r); await dbPut("reports", stampNew({ siteId: r.siteId, date: "2026-09-20", dayStatus: "work", companies: [{ companyId: "c1", companyName: "丙工務店", occupation: "内装", actualWorkerCount: "3", workHours: "08:00～17:00" }], siteSupervisorNames: [] })); }, ids.sep);
  await open(); await selectMonth("2026-09");
  t = await table(); m = map(t);
  check("7 日報の修正（9/10 の甲工業 1→4人）と追加（9/20 丙工務店 3人）が反映される（甲工業 9月 4・累計 9、丙工務店 3・累計 3、合計の累計 14）", m["甲工業"]?.month.startsWith("1日|4人|4|") && m["甲工業"]?.cum === "9" && m["丙工務店"]?.cum === "3" && t.foot[5] === "14", JSON.stringify({ m, foot: t.foot }));
  await selectMonth("2026-08");
  t = await table(); m = map(t);
  check("7 8月の表は9月の修正・追加の影響を受けない（丙工務店は出ない・合計の累計 7）", !m["丙工務店"] && t.foot[5] === "7", JSON.stringify(Object.keys(m)));
  await setPeriod("2026-08", thisMonth);
  pr = await period();
  const ga2 = pm(pr)["甲工業"]?.cells || []; const n2 = pr.head.length - 3;
  check("17・23 期間の集計にも、日報の修正（9月 甲工業 1→4）と追加（丙工務店 3）が反映される（甲工業 期間合計 11・丙工務店 3・合計 16）", ga2[1] === "4" && ga2[n2] === "11" && pm(pr)["丙工務店"]?.cells[n2] === "3" && pr.foot[n2] === "16", JSON.stringify({ ga2, foot: pr.foot }));
  // 削除（論理削除）した日報は数えない
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.isDeleted = true; r.deletedAt = new Date().toISOString(); await dbPut("reports", r); }, ids.oct1);
  await open(); await setPeriod("2026-08", thisMonth);
  pr = await period();
  const ga3 = pm(pr)["甲工業"]?.cells || []; const n3 = pr.head.length - 3;
  check("17 日報を削除すると集計から外れる（今月1日の甲工業 2 が消え、期間合計 9・合計 14）", ga3[n3 - 1] === "0" && ga3[n3] === "9" && pr.foot[n3] === "14", JSON.stringify({ ga3, foot: pr.foot }));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
