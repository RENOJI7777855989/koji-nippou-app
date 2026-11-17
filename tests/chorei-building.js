// 朝礼入力の各行に棟の名前を出す（2026-11-17）。架空データ・Chromium＋WebKit（iPad の縦）
//   ・棟を使う現場: 作業行の棟の名前（保存した時点の名前）・棟の無い行は「棟未設定」・同じ業者の別の棟は別の行
//   ・棟を使わない現場: 棟の表示を出さない
//   ・入力欄の読み上げ名に棟を含む・保存は従来どおり（棟・ほかの項目を変えない）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const DAY = "2026-10-20";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const seed = (page) => page.evaluate(async (day) => {
  const { createSite, updateSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
  const a = await createSite({ name: "棟ありの確認現場", startDate: "2026-10-01", endDate: "2026-12-20" });
  // 一覧の名前を後から変えても、行に保存した名前で出す（TB号棟 → 一覧では「TB号棟（北）」）
  await updateSite(a.id, { buildings: [{ id: "bTA", name: "TA号棟", active: true, order: 0 }, { id: "bTB", name: "TB号棟（北）", active: true, order: 1 }] });
  const row = (id, b, bn, name, trade) => ({ companyId: id, buildingId: b, buildingName: bn, companyName: name, occupation: trade, plannedWorkerCount: "2", actualWorkerCount: "", workContent: "作業" });
  const ra = stampNew({ siteId: a.id, date: day, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [
    row("c1", "bTA", "TA号棟", "アオバ塗装工業", "塗装"), row("c2", "bTB", "TB号棟", "アオバ塗装工業", "塗装"), row("c3", "", "", "ウエノ建設", "足場")] });
  await dbPut("reports", ra);
  const b = await createSite({ name: "道路の確認現場", startDate: "2026-10-01", endDate: "2026-12-20" });
  const rb = stampNew({ siteId: b.id, date: day, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [row("o1", "", "", "オリーブ警備", "警備")] });
  await dbPut("reports", rb);
  return { a: a.id, b: b.id, ra: ra.id };
}, DAY);
const openChorei = async (page, siteId) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, DAY);
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, DAY); await page.waitForTimeout(300);
  await page.click('#siteDashboard [data-action="chorei"]'); await page.waitForFunction(() => document.getElementById("choreiDialog").open); await page.waitForTimeout(200);
  return page.$$eval(".chorei-row", (rs) => rs.map((r) => ({ who: r.querySelector(".chorei-who").innerText.replace(/\s+/g, " ").trim(), b: r.querySelector(".chorei-building")?.textContent || null, none: !!r.querySelector(".chorei-building-none"), aria: r.querySelector(".chorei-count").getAttribute("aria-label") })));
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chorei-building-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);
  const rows = await openChorei(page, ids.a);
  check("1. 棟を使う現場: 各行に棟の名前（TA号棟・TB号棟）、棟の無い行は「棟未設定」", JSON.stringify(rows.map((r) => [r.b, r.none])) === JSON.stringify([["TA号棟", false], ["TB号棟", false], ["棟未設定", true]]), JSON.stringify(rows));
  check("2. 同じ業者（アオバ塗装工業）の別の棟は別の行・業者名と工種もそのまま", rows.filter((r) => r.who.includes("アオバ塗装工業") && r.who.includes("塗装")).length === 2);
  check("3. 棟の名前は行に保存した時点の名前（一覧で「TB号棟（北）」に変えても TB号棟）", rows[1].b === "TB号棟" && !rows.some((r) => (r.b || "").includes("北")));
  check("4. 入力欄の読み上げ名に棟を含む（TA号棟 アオバ塗装工業 塗装 の今日の実績人数）", rows[0].aria === "TA号棟 アオバ塗装工業 塗装 の今日の実績人数", rows[0].aria);
  // 保存しても棟・ほかの項目は変わらない
  await page.fill(".chorei-row >> nth=0 >> .chorei-count", "3"); await page.fill(".chorei-row >> nth=1 >> .chorei-count", "2");
  await page.click("#choreiSaveBtn"); await page.waitForFunction(() => !document.getElementById("choreiDialog").open); await page.waitForTimeout(300);
  const saved = await page.evaluate(async (id) => (await (await import("/js/reports.js")).getReport(id)).companies.map((c) => [c.companyId, c.buildingId, c.buildingName, c.actualWorkerCount].join(",")), ids.ra);
  check("5. 保存は実績人数だけ（棟の id・名前は変わらない）", JSON.stringify(saved) === JSON.stringify(["c1,bTA,TA号棟,3", "c2,bTB,TB号棟,2", "c3,,,"]), JSON.stringify(saved));
  const rowsB = await openChorei(page, ids.b);
  check("6. 棟を使わない現場: 棟の表示を出さない（「棟未設定」も出さない）", rowsB.length === 1 && rowsB[0].b === null && rowsB[0].aria === "オリーブ警備 警備 の今日の実績人数", JSON.stringify(rowsB));
  check("7. ページエラーが無い", errors.length === 0, errors.join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // iPad の縦（WebKit）: 業者名・棟・工種が行の中に収まる
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "chorei-building-wk-"));
  const c2 = await webkit.launchPersistentContext(d2, { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
  await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
  const i2 = await seed(p2); await openChorei(p2, i2.a);
  const lay = await p2.$$eval(".chorei-row", (rs) => rs.map((r) => { const row = r.getBoundingClientRect(); const b = r.querySelector(".chorei-building").getBoundingClientRect(); return b.left >= row.left - 0.5 && b.right <= row.right + 0.5 && b.height > 0; }));
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("8. iPad 縦（WebKit）: 棟の表示が各行の中に収まる・横スクロールなし", lay.every(Boolean) && overflow <= 0, JSON.stringify({ lay, overflow }));
  await c2.close(); fs.rmSync(d2, { recursive: true, force: true });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
