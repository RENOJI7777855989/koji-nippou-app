// 日報の作業行の工種の選択欄（2026-11-17、v83）。架空データ・Chromium＋WebKit（iPad の縦）
//   ・選択肢: 現場の工種の一覧 → 過去の日報の工種 →「＋ 工種を追加…」。選ぶと入力欄に入る（保存は従来どおり工種の名前）
//   ・「＋ 工種を追加…」で現場の一覧に登録してその行で選ぶ。表記ゆれ（塗装工事）は一覧の工種を選ぶ
//   ・一覧に無い保存済みの名前は「入力中: 名前」で残す（書き換えない）。手で打った名前も保存できる
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const seed = (page) => page.evaluate(async () => {
  const { createSite, updateSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
  const s = await createSite({ name: "工種の確認現場", startDate: "2026-10-01", endDate: "2026-12-20" });
  await updateSite(s.id, { trades: [{ id: "t1", name: "足場", active: true, order: 0 }, { id: "t2", name: "塗装", active: true, order: 1 }, { id: "t3", name: "防水", active: false, order: 2 }] });
  const r = stampNew({ siteId: s.id, date: "2026-10-05", dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [
    { companyId: "c1", companyName: "アオバ塗装工業", occupation: "外壁下地補修", actualWorkerCount: "2" },
    { companyId: "c2", companyName: "ウエノ建設", occupation: "特殊な作業（古い表記）", actualWorkerCount: "1" }] });
  await dbPut("reports", r);
  return { site: s.id, report: r.id };
});
const optionsOf = (page, n = 0) => page.$$eval(".company-row", (rs, i) => [...rs[i].querySelectorAll(".tradePick option")].map((o) => `${o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label + ">" : ""}${o.textContent}`), n);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-picker-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const answers = [];
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? answers.shift() ?? "" : undefined));
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);

  // 新規の日報
  await page.goto(`${BASE}#/sites/${ids.site}/report/new?date=2026-10-20`); await page.waitForSelector(".company-row .tradePick"); await page.waitForTimeout(600);
  const opts = await optionsOf(page);
  check("1. 選択肢: 一覧から選ぶ・現場の工種の一覧（使用中のみ・並び順）・過去の日報の工種・＋ 工種を追加…", JSON.stringify(opts) === JSON.stringify(["— 一覧から選ぶ —", "現場の工種の一覧>足場", "現場の工種の一覧>塗装", "過去の日報の工種>外壁下地補修", "過去の日報の工種>特殊な作業（古い表記）", "＋ 工種を追加…"]), JSON.stringify(opts));
  await page.selectOption(".company-row >> nth=0 >> .tradePick", "塗装");
  check("2. 選ぶと入力欄に工種の名前が入る（一覧の工種なので［この工種を現場の一覧に追加］は出ない）", (await page.inputValue(".company-row >> nth=0 >> .occupation")) === "塗装" && await page.isHidden(".company-row >> nth=0 >> .addTradeBtn"));
  // ＋ 工種を追加…
  answers.push("外壁補修");
  await page.selectOption(".company-row >> nth=0 >> .tradePick", "__add__"); await page.waitForTimeout(700);
  const site1 = await page.evaluate(async (s) => (await (await import("/js/sites.js")).getSite(s)).trades.map((t) => t.name), ids.site);
  check("3. 「＋ 工種を追加…」: 現場の一覧に登録し、その行で選んだ状態になる", site1.includes("外壁補修") && (await page.inputValue(".company-row >> nth=0 >> .occupation")) === "外壁補修" && (await page.$eval(".company-row .tradePick", (s) => s.value)) === "外壁補修", JSON.stringify(site1));
  answers.push("塗装工事");
  await page.selectOption(".company-row >> nth=0 >> .tradePick", "__add__"); await page.waitForTimeout(700);
  const site2 = await page.evaluate(async (s) => (await (await import("/js/sites.js")).getSite(s)).trades.length, ids.site);
  check("4. 表記ゆれ（塗装工事）は二重に登録せず、一覧の「塗装」を選ぶ", site2 === site1.length && (await page.inputValue(".company-row >> nth=0 >> .occupation")) === "塗装");
  // 手で打つ
  await page.fill(".company-row >> nth=0 >> .occupation", "はつり"); await page.dispatchEvent(".company-row >> nth=0 >> .occupation", "input");
  const opts2 = await optionsOf(page);
  check("5. 手で打った一覧に無い名前は「入力中: はつり」として選択欄に出る（［この工種を現場の一覧に追加］も出る）", opts2.includes("入力中: はつり") && (await page.$eval(".company-row .tradePick", (s) => s.value)) === "はつり" && await page.isVisible(".company-row >> nth=0 >> .addTradeBtn"), JSON.stringify(opts2));
  await page.fill(".company-row >> nth=0 >> .companyName", "キタノ土建"); await page.fill(".company-row >> nth=0 >> .actualWorkerCount", "2");
  await page.click("#reportSaveBtn"); await page.waitForTimeout(1500);
  const saved = await page.evaluate(async (s) => { const rs = await (await import("/js/reports.js")).listReportsBySite(s); return rs.find((r) => r.date === "2026-10-20")?.companies.map((c) => c.occupation); }, ids.site);
  check("6. 保存する値は従来どおり工種の名前（手で打った名前も保存）", JSON.stringify(saved) === JSON.stringify(["はつり"]), JSON.stringify(saved));
  // 保存済みの古い表記を開いても書き換えない
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.report}`); await page.waitForSelector(".company-row .tradePick"); await page.waitForTimeout(600);
  const vals = await page.$$eval(".company-row", (rs) => rs.map((r) => [r.querySelector(".tradePick").value, r.querySelector(".occupation").value]));
  check("7. 保存済みの日報: 工種の名前のまま選ばれている（過去の日報の工種・古い表記も書き換えない）", JSON.stringify(vals) === JSON.stringify([["外壁下地補修", "外壁下地補修"], ["特殊な作業（古い表記）", "特殊な作業（古い表記）"]]), JSON.stringify(vals));
  check("8. ページエラーが無い", errors.length === 0, errors.join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // iPad の縦（WebKit）: 選択欄は44px以上・行の中に収まる
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "trade-picker-wk-"));
  const c2 = await webkit.launchPersistentContext(d2, { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
  await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
  const i2 = await seed(p2);
  await p2.goto(`${BASE}#/sites/${i2.site}/report/new?date=2026-10-20`); await p2.waitForSelector(".company-row .tradePick"); await p2.waitForTimeout(600);
  const lay = await p2.$eval(".company-row", (r) => { const s = r.querySelector(".tradePick").getBoundingClientRect(); const rb = r.getBoundingClientRect(); return { h: s.height, inside: s.left >= rb.left - 0.5 && s.right <= rb.right + 0.5, overflow: document.documentElement.scrollWidth - window.innerWidth }; });
  check("9. iPad 縦（WebKit）: 工種の選択欄は44px以上で行の中に収まる・横スクロールなし", lay.h >= 44 && lay.inside && lay.overflow <= 0, JSON.stringify(lay));
  await c2.close(); fs.rmSync(d2, { recursive: true, force: true });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
