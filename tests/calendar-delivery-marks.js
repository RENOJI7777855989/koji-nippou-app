// 日報カレンダーの各日に「搬入 n件／なし」「搬出 n件／なし」を出す（日の状態とは別）ことを確かめる（架空データ・Chromium＋WebKit）。
//   ・件数は日報の搬入・搬出（deliveries）をそのまま数える。日付を押したときの「搬入：あり（n件）」と一致する
//   ・日の状態・搬入搬出のデータは変えない。iPadの画面幅でカレンダーが崩れない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const SEED = async () => {
  const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
  const site = await createSite({ name: "搬入搬出の印の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
  const d = (dir, time, item) => ({ id: `${dir}${time}${item}`, direction: dir, time, item, status: "plan" });
  const legacyIn = { id: "legacy", time: "07:30", item: "区分の無い搬入（以前のデータ）", status: "done" }; // direction 無し＝搬入
  const rows = [
    ["2026-09-01", "work", [d("in", "09:00", "塗料")]],
    ["2026-09-02", "work", [d("out", "15:00", "残材")]],
    ["2026-09-03", "work", [d("in", "09:00", "外壁材"), legacyIn, d("out", "16:00", "空缶")]],
    ["2026-09-04", "work", []],
    ["2026-09-05", "nowork", [d("in", "10:00", "足場材")]],
    ["2026-09-06", "rain", [d("in", "11:00", "シーラー")]],
    ["2026-09-07", "office", [d("out", "14:00", "書類箱")]],
    ["2026-09-09", "holiday", []]
  ];
  for (const [date, st, deliveries] of rows) await dbPut("reports", stampNew({ siteId: site.id, date, dayStatus: st, rainCancelledWork: st === "rain" ? "塗装" : "", deliveries, companies: st === "work" ? [{ companyId: "a", companyName: "サンプル工業", occupation: "塗装", actualWorkerCount: "2" }] : [], siteSupervisorNames: [] }));
  return site.id;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-dlv-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const siteId = await page.evaluate(SEED);
  const dump = () => page.evaluate(async (sid) => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.siteId === sid).sort((a, b) => a.date.localeCompare(b.date)).map((r) => [r.date, r.dayStatus, r.deliveries, r.updatedAt])), siteId);
  const before = await dump();

  const openCal = async (p) => {
    await p.goto(`${BASE}#/sites`); await p.waitForSelector("#view-site-list:not([hidden])");
    await p.goto(`${BASE}#/sites/${siteId}`); await p.waitForSelector("#siteDashboard:not([hidden])");
    await p.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await p.$('#reportCalendar .cal-cell[data-date="2026-09-01"]')); i++) { await p.click("#reportCalendar .cal-nav[data-shift='-1']"); await p.waitForTimeout(150); }
  };
  await openCal(page);
  const cell = (d) => page.$eval(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`, (b) => ({ state: b.className.match(/cal-(?!cell)(\w+)/)?.[1], dlv: [...b.querySelectorAll(".cal-dlv")].map((s) => s.textContent).join("／"), label: b.querySelector(".cal-label").textContent, title: b.title }));
  const c = {};
  for (const d of ["01", "02", "03", "04", "05", "06", "07", "08", "09"]) c[d] = await cell(d);

  check("1 搬入あり・搬出なし（9/1 通常作業）→「搬入 1件／搬出 なし」", c["01"].dlv === "搬入 1件／搬出 なし" && c["01"].title.includes("搬入：あり（1件）・搬出：なし"), JSON.stringify(c["01"]));
  check("2 搬入なし・搬出あり（9/2）→「搬入 なし／搬出 1件」", c["02"].dlv === "搬入 なし／搬出 1件", c["02"].dlv);
  check("3 搬入あり・搬出あり（9/3。区分の無い以前の搬入も搬入として数える）→「搬入 2件／搬出 1件」", c["03"].dlv === "搬入 2件／搬出 1件", c["03"].dlv);
  check("4 搬入なし・搬出なし（9/4）→「搬入 なし／搬出 なし」", c["04"].dlv === "搬入 なし／搬出 なし", c["04"].dlv);
  check("5 現場作業なし＋搬入あり（9/5）→ 状態は「現場作業なし」のまま・「搬入 1件」", c["05"].state === "nowork" && c["05"].label === "現場作業なし" && c["05"].dlv === "搬入 1件／搬出 なし");
  check("6 雨天作業不可日＋搬入あり（9/6）→「雨天作業不可日」のまま・「搬入 1件」", c["06"].state === "rain" && c["06"].dlv === "搬入 1件／搬出 なし");
  check("7 事務作業日＋搬出あり（9/7）→「事務作業日」のまま・「搬出 1件」", c["07"].state === "office" && c["07"].dlv === "搬入 なし／搬出 1件");
  check("8 日報なし（9/8）→ 搬入・搬出は日報の中にしか無いので「なし」（日報なしの状態のまま）", c["08"].state === "none" && c["08"].dlv === "搬入 なし／搬出 なし");
  check("休工日（9/9）も状態はそのまま・搬入搬出なし", c["09"].state === "holiday" && c["09"].dlv === "搬入 なし／搬出 なし");
  const outCells = await page.$$eval("#reportCalendar .cal-cell.cal-out, #reportCalendar .cal-cell.cal-future", (bs) => bs.filter((b) => b.querySelector(".cal-dlv")).length);
  check("工期外・未来で日報の無い日には出さない（カレンダーを詰め込みすぎない）", outCells === 0);

  // ===== 9 日付タップの詳細と件数が一致 =====
  const panelCounts = {};
  for (const d of ["01", "02", "03", "05", "06", "07"]) {
    await page.click(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open);
    const t = (await page.textContent("#dayPanelDialog")).replace(/\s+/g, " ");
    const n = (re) => (t.match(re) ? Number(t.match(re)[1]) : 0);
    panelCounts[d] = `${n(/搬入：あり（(\d+)件）/)}/${n(/搬出：あり（(\d+)件）/)}`;
    await page.click("#dayPanelCloseBtn");
  }
  const calCounts = Object.fromEntries(Object.keys(panelCounts).map((d) => { const m = c[d].dlv.match(/搬入 (\d+|なし)件?／搬出 (\d+|なし)/); return [d, `${m[1] === "なし" ? 0 : m[1]}/${m[2] === "なし" ? 0 : m[2]}`]; }));
  check("9 カレンダーの件数と、日付を押したときの「搬入：あり（n件）」「搬出：あり（n件）」が一致", JSON.stringify(panelCounts) === JSON.stringify(calCounts), `${JSON.stringify(calCounts)} / ${JSON.stringify(panelCounts)}`);

  // ===== 10・11 状態・データは変わらない =====
  check("10・11 日の状態・搬入搬出のデータは変わらない（表示だけ）", (await dump()) === before);

  // ===== 12 iPadの画面幅（WebKit・縦／横）でカレンダーが崩れない =====
  for (const [label, vp] of [["縦", { width: 820, height: 1180 }], ["横", { width: 1180, height: 820 }]]) {
    const wctx = await webkit.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "cal-dlv-wk-")), { viewport: vp, hasTouch: true });
    const wp = wctx.pages()[0]; wp.on("dialog", (d) => d.accept());
    await wp.goto(BASE); await wp.waitForSelector("#view-site-list:not([hidden])");
    const sid2 = await wp.evaluate(SEED);
    await wp.goto(`${BASE}#/sites/${sid2}`); await wp.waitForSelector("#siteDashboard:not([hidden])");
    await wp.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await wp.$('#reportCalendar .cal-cell[data-date="2026-09-01"]')); i++) { await wp.click("#reportCalendar .cal-nav[data-shift='-1']"); await wp.waitForTimeout(150); }
    const lay = await wp.evaluate(() => {
      const grid = document.querySelector("#reportCalendar .cal-grid");
      const cells = [...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")];
      const overflow = cells.filter((b) => [...b.children].some((ch) => ch.getBoundingClientRect().right > b.getBoundingClientRect().right + 1 || ch.getBoundingClientRect().left < b.getBoundingClientRect().left - 1)).map((b) => b.dataset.date);
      const widths = cells.map((b) => Math.round(b.getBoundingClientRect().width));
      return { gridOverflow: grid.scrollWidth > grid.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, overflow, minW: Math.min(...widths), minH: Math.min(...cells.map((b) => Math.round(b.getBoundingClientRect().height))) };
    });
    check(`12 iPadの画面幅（WebKit・${label}）でカレンダーが崩れない（横にはみ出さない・文字が枠からはみ出さない・押しやすい大きさ）`, !lay.gridOverflow && !lay.pageOverflow && lay.overflow.length === 0 && lay.minW >= 40 && lay.minH >= 44, JSON.stringify(lay));
    await wp.locator('#reportCalendar .cal-cell[data-date="2026-09-03"]').scrollIntoViewIfNeeded();
    await wp.screenshot({ path: path.join(process.env.TEST_OUT_DIR || dir, `calendar-delivery-${label === "縦" ? "portrait" : "landscape"}.png`) });
    await wctx.close();
  }

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
