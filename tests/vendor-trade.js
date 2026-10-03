// 業者と工種を別のものとして扱うことを確かめる（架空データ・Chromium）。
//   実際の現場の例: ナダカ工業＝外壁下地補修・塗装・防水（3工種）、野本建装工業＝塗装、協栄工業＝足場、西原建設＝足場
//   ・日報の入力画面で、同じ日に1社を3工種（別々の行）、1工種（足場）を2社で登録・保存・再表示できる
//   ・業者を選んでも工種は自動で入らない（入力候補は業者・工種で別々）
//   ・ダッシュボード・A3: 業者と工種を別の列に出し、業者数は4社・工種数は4種（行の数で数えない）。累計人工は業者×工種ごと
//   ・03-2: 協力会社名（A列）と職種（B列）を行ごとに書き、稼動人数表は工種ごと（塗装＝ナダカ2＋野本2）。既存の日報は変わらない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const ROWS = [
  ["ナダカ工業", "外壁下地補修", "3", "外壁ひび割れ部の下地補修"],
  ["ナダカ工業", "塗装", "2", "北面塗装"],
  ["ナダカ工業", "防水", "1", "バルコニー防水"],
  ["野本建装工業", "塗装", "2", "南面塗装"],
  ["協栄工業", "足場", "3", "東面足場盛替え"],
  ["西原建設", "足場", "2", "西面足場点検"]
];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-trade-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 9/1 に既存の日報（ナダカ工業＝塗装1人。以前の入力）
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "業者と工種の確認現場", startDate: "2026-09-01", endDate: "2026-09-30" });
    const old = stampNew({ siteId: site.id, date: "2026-09-01", dayStatus: "work", siteSupervisorNames: [], companies: [{ companyId: "o1", companyName: "ナダカ工業", occupation: "塗装", actualWorkerCount: "1", workHours: "08:00～17:00", workContent: "以前の塗装" }] });
    await dbPut("reports", old);
    return { siteId: site.id, old: old.id };
  });
  const oldBefore = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.old);

  // ---- 1〜8 日報の入力画面で6行（1社3工種・足場2社）を登録 ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=2026-09-02`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const label = await page.$eval(".company-row .occupation", (i) => i.closest("label").childNodes[0].textContent.trim());
  const suggest = await page.evaluate(() => ({ names: [...document.querySelectorAll("#companyNameSuggestions option")].map((o) => o.value), trades: [...document.querySelectorAll("#occupationSuggestions option")].map((o) => o.value) }));
  check("入力画面: 業者名と「工種」が別々の欄で、入力候補も別々（過去の日報から 業者＝ナダカ工業・工種＝塗装）", label === "工種" && suggest.names.join() === "ナダカ工業" && suggest.trades.join() === "塗装", JSON.stringify(suggest));
  for (let i = 0; i < ROWS.length; i++) {
    if (i > 0) await page.click("#addCompanyBtn");
    const r = page.locator(".company-row").nth(i);
    await r.locator(".companyName").fill(ROWS[i][0]);
    if (i === 0) {
      // 業者を入れても工種は自動で入らない
      const trade = await r.locator(".occupation").inputValue();
      check("5・11 業者（ナダカ工業）を入れても工種は自動で入らない（空欄のまま）", trade === "");
    }
    await r.locator(".occupation").fill(ROWS[i][1]);
    await r.locator(".actualWorkerCount").fill(ROWS[i][2]);
    await r.locator(".workContent").fill(ROWS[i][3]);
    await r.locator(".workStart").selectOption("08:00"); await r.locator(".workEnd").selectOption("17:00");
  }
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const saved = await page.evaluate(async (sid) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === "2026-09-02"), ids.siteId);
  const pairs = saved.companies.map((c) => `${c.companyName}|${c.occupation}|${c.actualWorkerCount}`);
  const expect = ROWS.map((r) => `${r[0]}|${r[1]}|${r[2]}`);
  ["1 ナダカ工業＋外壁下地補修", "2 ナダカ工業＋塗装", "3 ナダカ工業＋防水", "4 野本建装工業＋塗装", "5 協栄工業＋足場", "6 西原建設＋足場"].forEach((name, i) => check(`${name} を保存（${expect[i]}）`, pairs[i] === expect[i], pairs[i]));
  check("7 同じ日にナダカ工業を3工種で登録（3行・それぞれ別の作業内容）", saved.companies.filter((c) => c.companyName === "ナダカ工業").map((c) => `${c.occupation}:${c.workContent}`).join() === "外壁下地補修:外壁ひび割れ部の下地補修,塗装:北面塗装,防水:バルコニー防水");
  check("8 同じ日に足場を2社（協栄工業・西原建設）で登録", saved.companies.filter((c) => c.occupation === "足場").map((c) => c.companyName).join() === "協栄工業,西原建設");
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${saved.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const reopened = await page.$$eval(".company-row", (rows) => rows.map((r) => `${r.querySelector(".companyName").value}|${r.querySelector(".occupation").value}|${r.querySelector(".actualWorkerCount").value}`));
  check("開き直すと6行とも同じ業者・工種・人数", JSON.stringify(reopened) === JSON.stringify(expect), reopened.join(" / "));

  // ---- 9・10 ダッシュボード ----
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-09-02"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(600);
  const d = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("#siteDashboard .dash-vendors tbody tr")].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ""))),
    foot: document.querySelector("#siteDashboard .dash-vendors tfoot th")?.textContent,
    text: document.getElementById("siteDashboard").textContent.replace(/\s+/g, " "),
    cmp: [...document.querySelectorAll("#siteDashboard .dash-compare tbody tr")].map((r) => r.textContent.replace(/\s+/g, "")),
    att: [...document.querySelectorAll("#siteDashboard .dash-attention li")].map((l) => l.textContent.replace(/\s+/g, " "))
  }));
  const vt = d.rows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[4]}|${r[5]}`);
  check("10 業者別稼働状況: 業者と工種が別の列で6行（同じ会社が複数行に出る）・人工は人数と同じ", JSON.stringify(vt) === JSON.stringify(["ナダカ工業|外壁下地補修|3人|3|3", "ナダカ工業|塗装|2人|2|3", "ナダカ工業|防水|1人|1|1", "野本建装工業|塗装|2人|2|2", "協栄工業|足場|3人|3|3", "西原建設|足場|2人|2|2"]), vt.join(" / "));
  check("10 累計人工は業者×工種ごと（ナダカ工業の塗装は 9/1 の1＋2＝3。外壁下地補修・防水は足さない）", vt[1].endsWith("|3") && vt[0].endsWith("|3") && vt[2].endsWith("|1"));
  check("9 業者数4社・工種数4種（合計欄・本日の人員・現場概要・今日の確認事項）", d.foot === "合計（4社・4工種）" && /業者\s*4社\s*工種\s*4種/.test(d.text) && /業者\s*4社・4工種/.test(d.text), `${d.foot} / ${(d.text.match(/業者[^業]{0,14}/g) || []).join(" | ")}`);
  check("9 昨日→今日: 業者数 1社→4社・工種数 1種→4種（9/1はナダカ工業の塗装だけ）", d.cmp.includes("業者数1社→4社") && d.cmp.includes("工種数1種→4種"), d.cmp.join(" / "));
  check("同じ業者が複数行ある日は、署名未入力の表示に工種を付けて区別（ナダカ工業（塗装）など）", d.att.some((a) => a === "署名 ナダカ工業（塗装） 署名未入力") && d.att.some((a) => a === "署名 協栄工業 署名未入力"), d.att.filter((a) => a.startsWith("署名")).join(" / "));
  const a3 = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((r) => r.siteId === sid), signatures: [], date: "2026-09-02", kySubmissions: [] }));
  }, ids.siteId);
  check("10 A3: 本日の作業の表に業者・工種を別の列で6行、合計「4社・4工種」・人員の業者4社・工種4種", (a3.match(/<tr><td>ナダカ工業<\/td>/g) || []).length === 3 && a3.includes("<td>野本建装工業</td><td>塗装</td>") && a3.includes("合計（4社・4工種）") && a3.includes("<tr><th>業者・工種</th><td>4社・4種</td></tr>"));

  // ---- 12 03-2 ----
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), saved.id)]);
  const xf = path.join(dir, "d2.xlsx"); await dl.saveAs(xf);
  const x = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[0];
    const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
    const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
    const o = {}; for (const [ref, c] of L.cells) if (c.text) o[ref] = c.text; return o;
  }, fs.readFileSync(xf).toString("base64"));
  const sheetRows = [7, 9, 11, 13, 15, 17].map((r) => `${x[`A${r}`]}|${x[`B${r}`]}|${x[`D${r}`]}`);
  check("12 03-2: 協力会社名（A列）と職種（B列）を行ごとに別々に書く（ナダカ工業3行・足場2社）", JSON.stringify(sheetRows) === JSON.stringify(expect), sheetRows.join(" / "));
  check("12 03-2 稼動人数: 塗装工事の行＝ナダカ2＋野本2＝4、防水工事の行＝1（工種ごと。業者でまとめない）", x.O33 === "4" && x.O20 === "1", `O33=${x.O33} O20=${x.O20}`);
  const freeRows = [26, 31, 34, 40, 42, 47].map((r) => `${x[`M${r}`] || ""}:${x[`O${r}`] || ""}`).filter((v) => v !== ":");
  check("12 03-2 稼動人数: 様式に無い工種（外壁下地補修3・足場5＝協栄3＋西原2）は空き行に工種名つき", freeRows.includes("外壁下地補修:3") && freeRows.includes("足場:5"), freeRows.join(" / "));

  check("11 既存の日報（9/1）は変わらない", (await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.old)) === oldBefore);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
