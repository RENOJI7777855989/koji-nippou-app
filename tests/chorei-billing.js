// 朝礼入力の「請求人工」（2026-11-15。架空データ・隔離したプロファイル）
//   ・業者の行ごとに 今日の人数 と 請求人工 を入れる。保存先は既存の companies[].billingManDays（新しい項目は作らない）
//   ・人数と請求人工は別の値（違ってよい）・小数2桁・空欄は未入力のまま（0にしない）・以前の版の manDays は変えなければそのまま
//   ・合計の表示・作業人数（合計）に請求人工を足さない・再読み込みで残る・行の並べ替え後も同じ行（companyId）に結びつく
//   ・現場掲示の画面・A3印刷（PDF保存も同じHTMLから作る）に請求人工が出ない
//   ・iPad の縦・横（WebKit）で入力欄が画面に収まり押しやすい。iPad 実機は未確認
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const D = "2026-09-15";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

async function setup(page) {
  return page.evaluate(async (date) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "朝礼入力の確認現場B", startDate: "2026-09-01", endDate: "2026-12-20" });
    const row = (id, name, trade, actual, extra = {}) => ({ companyId: id, companyName: name, occupation: trade, plannedWorkerCount: "3", actualWorkerCount: actual, workHours: "08:00～17:00", workContent: trade + "の作業", ...extra });
    const r = stampNew({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", progressPercent: 30, siteSupervisorNames: [], remarks: "連絡",
      companies: [row("a1", "アオバ塗装工業", "塗装", "", { billingManDays: "" }), row("e1", "エノキ建装工業", "外壁補修", "", { billingManDays: "" }),
        row("k1", "キタノ土建", "土工", "2", { manDays: "1.5" }), row("u1", "ウエノ建設", "足場", "", {})],
      workerCountTotal: "2" });
    await dbPut("reports", r);
    return { siteId: site.id, reportId: r.id };
  }, D);
}
const openDash = async (page, ids) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, D);
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, D); await page.waitForTimeout(300);
};
const openChorei = async (page) => { await page.click('#siteDashboard [data-action="chorei"]'); await page.waitForFunction(() => document.getElementById("choreiDialog").open); await page.waitForTimeout(200); };
const rowsOf = (page) => page.$$eval(".chorei-row", (rs) => rs.map((r) => ({ key: r.dataset.key, vendor: r.querySelector(".chorei-vendor").textContent, count: r.querySelector(".chorei-count").value, billing: r.querySelector(".chorei-billing").value, bstate: r.querySelector(".chorei-bstate").textContent })));
const saveChorei = async (page) => { await page.click("#choreiSaveBtn"); await page.waitForFunction(() => !document.getElementById("choreiDialog").open, null, { timeout: 10000 }); await page.waitForTimeout(300); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chorei-billing-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await setup(page);
  const getR = () => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), ids.reportId);
  const before = await getR();

  await openDash(page, ids); await openChorei(page);
  let rs = await rowsOf(page);
  check("1. 業者の行ごとに「今日の人数」と「請求人工」の入力欄がある（4行）", rs.length === 4 && (await page.$$(".chorei-row .chorei-billing")).length === 4 && (await page.textContent("#choreiTitle")).includes("請求人工"), JSON.stringify(rs));
  check("2. 以前の版の請求人工（manDays 1.5）は請求人工として表示", rs[2].billing === "1.5" && rs[2].bstate === "請求 1.5人工", JSON.stringify(rs[2]));

  // 人数と請求人工を別々に入れる（小数・人数と違う値・空欄のまま・0）
  await page.fill(".chorei-row >> nth=0 >> .chorei-count", "3"); await page.fill(".chorei-row >> nth=0 >> .chorei-billing", "2.75");
  await page.fill(".chorei-row >> nth=1 >> .chorei-count", "4"); // 請求人工は空欄のまま
  await page.fill(".chorei-row >> nth=3 >> .chorei-count", "1"); await page.fill(".chorei-row >> nth=3 >> .chorei-billing", "0");
  await page.waitForTimeout(150);
  const prog = await page.textContent("#choreiProgress");
  check("3. 合計: 今日の人数（3+4+2+1=10人）と請求人工（2.75+1.5+0=4.25人工）を別々に表示", /今日の人数 10人/.test(prog) && /請求人工 4\.25人工/.test(prog) && /請求人工 入力済み 3／4行/.test(prog), prog);

  // 誤った値は保存しない
  await page.fill(".chorei-row >> nth=1 >> .chorei-billing", "1.234"); await page.click("#choreiSaveBtn"); await page.waitForTimeout(300);
  check("4. 小数3桁の請求人工は保存せず、ダイアログは開いたまま・日報は変わらない", await page.evaluate(() => document.getElementById("choreiDialog").open) && JSON.stringify((await getR()).companies) === JSON.stringify(before.companies));
  await page.fill(".chorei-row >> nth=1 >> .chorei-billing", "");
  await saveChorei(page);

  let r = await getR();
  const c = Object.fromEntries(r.companies.map((x) => [x.companyId, x]));
  check("5. 保存先は既存の billingManDays（人数と違う値・小数そのまま）。実績人数は別に保存", c.a1.actualWorkerCount === "3" && c.a1.billingManDays === "2.75" && c.u1.actualWorkerCount === "1" && c.u1.billingManDays === "0", JSON.stringify([c.a1, c.u1].map((x) => [x.actualWorkerCount, x.billingManDays])));
  check("6. 空欄の請求人工は未入力のまま（0にしない）", c.e1.billingManDays === "" && c.e1.actualWorkerCount === "4");
  check("7. 変えていない以前の版の manDays はそのまま（billingManDays を作らない）", c.k1.manDays === "1.5" && !("billingManDays" in c.k1));
  check("8. 作業人数（合計）は実績人数の合計（10）で、請求人工を足さない", r.workerCountTotal === "10", r.workerCountTotal);
  check("9. 新しい項目を作らない（業者の行の項目は元の項目と既存の billingManDays だけ。予定人数・作業時間・作業内容は不変）", r.companies.every((x, i) => { const o = before.companies[i]; return Object.keys(x).every((k) => k in o || k === "billingManDays") && x.plannedWorkerCount === o.plannedWorkerCount && x.workHours === o.workHours && x.workContent === o.workContent; }) && r.remarks === before.remarks && r.progressPercent === before.progressPercent);

  // 再読み込みで残る
  await page.reload(); await openDash(page, ids); await openChorei(page);
  rs = await rowsOf(page);
  check("10. 再読み込みして開き直しても、人数・請求人工（小数）が残る", rs[0].count === "3" && rs[0].billing === "2.75" && rs[1].billing === "" && rs[1].bstate === "請求 未入力" && rs[3].billing === "0", JSON.stringify(rs));
  await page.click("#choreiCloseBtn");

  // 日報画面にも同じ値
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.reportId}`); await page.waitForSelector(".company-row"); await page.waitForTimeout(400);
  const formBill = await page.$$eval(".company-row", (rows) => rows.map((row) => row.querySelector(".billingManDays, [class*=billing] input, input.billingManDays")?.value ?? null));
  check("11. 日報画面の請求人工の欄にも同じ値", formBill[0] === "2.75" && formBill[3] === "0", JSON.stringify(formBill));

  // 行の並べ替え（データ上で順番を入れ替える）後も companyId に結びつく
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const x = await dbGet("reports", id); x.companies = [...x.companies].reverse(); await dbPut("reports", x); }, ids.reportId);
  await openDash(page, ids); await openChorei(page);
  rs = await rowsOf(page);
  check("12. 行の順番が変わっても、請求人工は同じ業者の行に表示", rs[0].vendor === "ウエノ建設" && rs[0].billing === "0" && rs[3].vendor === "アオバ塗装工業" && rs[3].billing === "2.75", JSON.stringify(rs.map((x) => [x.vendor, x.billing])));
  await page.fill(".chorei-row >> nth=3 >> .chorei-billing", "3.5"); await saveChorei(page);
  r = await getR();
  check("13. 並べ替え後に直した請求人工は、その業者（アオバ塗装工業）の行にだけ保存", r.companies.find((x) => x.companyId === "a1").billingManDays === "3.5" && r.companies.find((x) => x.companyId === "u1").billingManDays === "0" && r.companies.find((x) => x.companyId === "e1").billingManDays === "");

  // 現場掲示の画面・A3印刷に請求人工が出ない
  await openDash(page, ids);
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
  const boardText = await page.$eval("#siteDashboard [data-panel=board]", (el) => el.textContent);
  check("14. 現場掲示の画面に「請求」の文字・請求人工の値（3.5）が出ない", !boardText.includes("請求") && !boardText.includes("3.5"), boardText.slice(0, 120));
  await page.click("#siteDashboard [data-action=print]");
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const html = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
  await page.click("#reportPrintCloseBtn");
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, html);
  const bodyText = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
  check("15. 現場掲示のA3印刷（PDF保存も同じHTML）に「請求」・請求人工の値が出ない。実績人数（10人）は出る", !bodyText.includes("請求") && !/3\.5/.test(bodyText) && /10/.test(bodyText), JSON.stringify({ seikyu: bodyText.indexOf("請求") >= 0 ? bodyText.slice(bodyText.indexOf("請求") - 60, bodyText.indexOf("請求") + 40) : "", v: (bodyText.match(/.{0,40}3\.5.{0,20}/) || [""])[0], total: (bodyText.match(/合計.{0,80}/) || [""])[0].replace(/\s+/g, " ") }));
  check("16. ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // iPad の縦・横（WebKit）
  for (const [label, vp] of [["縦", { width: 820, height: 1180 }], ["横", { width: 1180, height: 820 }]]) {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "chorei-billing-wk-"));
    const c2 = await webkit.launchPersistentContext(d2, { viewport: vp, deviceScaleFactor: 2, hasTouch: true });
    const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
    await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
    const i2 = await setup(p2);
    await openDash(p2, i2); await openChorei(p2);
    await p2.tap(".chorei-row >> nth=0 >> .chorei-billing"); await p2.keyboard.type("1.5"); await p2.waitForTimeout(150);
    const m = await p2.evaluate(() => {
      const dlg = document.getElementById("choreiDialog").getBoundingClientRect();
      const inputs = [...document.querySelectorAll(".chorei-count, .chorei-billing")].map((el) => el.getBoundingClientRect());
      return { w: window.innerWidth, dlgRight: dlg.right, dlgLeft: dlg.left, inside: inputs.every((b) => b.left >= dlg.left - 1 && b.right <= dlg.right + 1), minH: Math.min(...inputs.map((b) => b.height)), overflow: document.documentElement.scrollWidth - window.innerWidth, state: document.querySelector(".chorei-row .chorei-bstate").textContent };
    });
    check(`17. iPad ${label}（WebKit）: 人数・請求人工の欄がダイアログの中に収まり、44px以上・タップで入力できる`, m.inside && m.dlgRight <= m.w && m.dlgLeft >= 0 && m.minH >= 44 && m.overflow <= 0 && m.state === "請求 1.5人工", JSON.stringify(m));
    await c2.close(); fs.rmSync(d2, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
