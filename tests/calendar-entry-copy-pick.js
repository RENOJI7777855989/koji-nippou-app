// 「📅 日報カレンダー」の入口と、「前の日報から作成」の「別の日報を選択」（コピー元を自分で選ぶ）を確かめる（架空データ・Chromium）。
//   ・入口: どちらのタブからでも押すと、既存の［🛠 監督管理］タブのカレンダーへ移る（カレンダー本体は変えない）
//   ・コピー元: 作成する日付より前の日報だけを月ごとに並べ、過去の月へさかのぼれる。日報の無い日・未来の日は選べない
//     同じ日の複数の日報は1件ずつ選ぶ（まとめない）。選んだ日報からのコピーは従来と同じ規則。元の日報は変わらない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-entry-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "コピー元選択の確認現場", startDate: "2026-08-01", endDate: "2026-12-20" });
    const mk = async (date, name, extra = {}) => { const r = stampNew({ siteId: site.id, date, dayStatus: "work", siteSupervisorNames: [], remarks: `${name}の連絡`, companies: [{ companyId: "c" + name, companyName: name, occupation: "塗装", workContent: `${name}の作業`, safetyNotes: `${name}の注意`, actualWorkerCount: "3", billingManDays: "2" }], ...extra }); await dbPut("reports", r); await new Promise((x) => setTimeout(x, 15)); return r.id; };
    return {
      siteId: site.id,
      old: await mk("2026-08-20", "八月工業"),
      d2a: await mk("2026-09-02", "甲工業"), d2b: await mk("2026-09-02", "乙工業"),
      d5: await mk("2026-09-05", "五日工業"),
      d9: await mk("2026-09-09", "九日工業"),
      future: await mk("2026-09-12", "未来工業")
    };
  });
  const dumpAll = () => page.evaluate(async (sid) => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.siteId === sid).sort((a, b) => a.id.localeCompare(b.id))), ids.siteId);
  const before = await dumpAll();

  // ===== 日報カレンダーの入口 =====
  await page.evaluate(() => { try { localStorage.removeItem("siteDashboardTab"); } catch {} });
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])"); await page.waitForTimeout(500);
  const start = await page.evaluate(() => ({ tab: document.querySelector("#siteDashboard .dash-tab.is-active")?.dataset.tab, btn: !!document.querySelector('#siteDashboard [data-action="calendar"]'), inBoardPanel: !!document.querySelector('#siteDashboard [data-panel="board"] [data-action="calendar"]'), calVisible: document.getElementById("reportCalendar").offsetParent !== null }));
  check("現場掲示タブのときもタブの並びに「📅 日報カレンダー」がある（現場掲示の欄の中には入れない）", start.tab === "board" && start.btn && !start.inBoardPanel && !start.calVisible, JSON.stringify(start));
  await page.click('#siteDashboard [data-action="calendar"]'); await page.waitForTimeout(400);
  const jumped = await page.evaluate(() => { const r = document.getElementById("reportCalendar").getBoundingClientRect(); return { tab: document.querySelector("#siteDashboard .dash-tab.is-active")?.dataset.tab, visible: document.getElementById("reportCalendar").offsetParent !== null, inView: r.top >= -2 && r.top < window.innerHeight, cells: [...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")].map((b) => b.className).join("|") }; });
  check("「📅 日報カレンダー」を押すと［🛠 監督管理］タブに切り替わり、カレンダーの位置へ移る", jumped.tab === "manage" && jumped.visible && jumped.inView, JSON.stringify({ ...jumped, cells: undefined }));
  // 従来どおり［🛠 監督管理］タブからも開け、表示は同じ
  await page.click('#siteDashboard .dash-tab[data-tab="board"]'); await page.click('#siteDashboard .dash-tab[data-tab="manage"]'); await page.waitForTimeout(300);
  const viaTab = await page.evaluate(() => [...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")].map((b) => b.className).join("|"));
  check("［🛠 監督管理］タブからも従来どおり開け、カレンダーの表示は入口から開いたときと同じ", viaTab === jumped.cells && viaTab.length > 0);

  // ===== 別の日報を選択（作成する日付 9/10）=====
  const newForm = async (date) => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${date}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500); };
  const panel = () => page.evaluate(() => ({ title: document.querySelector("#copyPickPanel .copy-pick-head b")?.textContent || "", dates: [...document.querySelectorAll("#copyPickPanel .copy-pick-date")].map((p) => p.textContent), btns: [...document.querySelectorAll("#copyPickPanel [data-pick-from]")].map((b) => b.dataset.pickFrom), prevDisabled: document.querySelector('#copyPickPanel [data-pick-month="1"]')?.disabled, nextDisabled: document.querySelector('#copyPickPanel [data-pick-month="-1"]')?.disabled }));
  const rowNames = () => page.$$eval(".company-row .companyName", (xs) => xs.map((x) => x.value).join(","));
  await newForm("2026-09-10");
  // 従来の「📋 前の日報から作成」はそのまま（一番新しい 9/9）
  await page.click("#copyPrevBtn"); await page.waitForTimeout(300);
  check("従来の「📋 前の日報から作成」はそのまま（一番新しい 9/9 から1回でコピー）", (await rowNames()) === "九日工業");
  await page.click("#copyPickBtn"); await page.waitForTimeout(300);
  let pn = await panel();
  check("［別の日報を選択］で、作成する日付（9/10）より前の日報だけを月ごとに表示（9月: 9/9・9/5・9/2。9/12（未来）・日報の無い日は出ない）", pn.title === "2026年9月の日報" && pn.dates.map((d) => d.slice(0, 4)).join(",") === "9/9（,9/5（,9/2（" && !pn.btns.includes(ids.future) && pn.nextDisabled === true, JSON.stringify(pn));
  check("同じ日（9/2）の2件は1件ずつ別のボタンで選ぶ（まとめない）", pn.dates[2].includes("日報2件") && pn.btns.filter((x) => x === ids.d2a || x === ids.d2b).length === 2);
  // 数日前（9/5）
  await page.click(`#copyPickPanel [data-pick-from="${ids.d5}"]`); await page.waitForTimeout(300);
  check("数日前の日報（9/5）を選んでコピーできる（入力中の内容は確認して置き換え）", (await rowNames()) === "五日工業" && (await page.inputValue("#remarks")) === "五日工業の連絡" && (await page.isHidden("#copyPickPanel")));
  // かなり前（8/20）: 前の月へ
  await page.click("#copyPickBtn"); await page.waitForTimeout(200);
  await page.click('#copyPickPanel [data-pick-month="1"]'); await page.waitForTimeout(200);
  pn = await panel();
  check("［◀ 前の月］で過去の月（8月）へさかのぼれる（8/20）", pn.title === "2026年8月の日報" && pn.btns.join() === ids.old && pn.prevDisabled === true && pn.nextDisabled === false, JSON.stringify(pn));
  await page.click(`#copyPickPanel [data-pick-from="${ids.old}"]`); await page.waitForTimeout(300);
  const rows = await page.$$eval(".company-row", (rs) => rs.map((r) => `${r.querySelector(".companyName").value}/${r.querySelector(".workContent").value}/${r.querySelector(".safetyNotes").value}/${r.querySelector(".actualWorkerCount").value}/${r.querySelector(".billingManDays").value}`));
  check("かなり前の日報（8/20）を選んでコピーできる。コピーの規則は従来どおり（業者・作業内容・安全注意事項は入り、実績人数・請求人工は入らない）", rows.join(",") === "八月工業/八月工業の作業/八月工業の注意//", rows.join(","));
  // 同じ日の2件目だけ
  await page.click("#copyPickBtn"); await page.waitForTimeout(200);
  await page.click(`#copyPickPanel [data-pick-from="${ids.d2b}"]`); await page.waitForTimeout(300);
  check("同じ日の2件目（乙工業）だけをコピーする（甲工業とまとめない）", (await rowNames()) === "乙工業");
  // 保存して、元の日報がどれも変わらない
  await page.locator(".company-row .actualWorkerCount").first().fill("4");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(400);
  const saved = await page.evaluate(async (sid) => (await (await import("/js/reports.js")).listReportsBySite(sid)).find((r) => r.date === "2026-09-10"), ids.siteId);
  check("選んだ日報からのコピーで 9/10 の日報を保存できる（業者の行は新しいid）", saved && saved.companies[0].companyName === "乙工業" && saved.companies[0].companyId !== "c乙工業" && saved.companies[0].billingManDays === "");
  const after = JSON.parse(await dumpAll()).filter((r) => r.date !== "2026-09-10");
  check("コピー元に使った日報（8/20・9/2・9/5・9/9）とほかの日報は1文字も変わらない", JSON.stringify(after) === before);

  // 一番古い日報の日・前の日報が無い日
  await newForm("2026-08-20");
  check("作成する日付より前に日報が無い日（8/20）は［別の日報を選択］も押せない", (await page.isDisabled("#copyPickBtn")) && (await page.isDisabled("#copyPrevBtn")));
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
