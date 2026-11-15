// 日報一覧の年月の選択（2026-11-15。現場詳細の「工事日報」の一覧。架空データ・隔離したプロファイル）
//   ・最初は日報がある一番新しい年月（今月に日報が無くても）・年月の選択・前後の月・日報の無い月の表示・同じ日の複数の日報・すべての月
//   ・日報を開いて戻っても年月はそのまま・まとめて出力の対象は月の選択に関係なく変わらない・データは変わらない・日報の無い現場
//   ・iPad の縦・横（WebKit）で横にはみ出さず、ボタンが押しやすい大きさ。iPad 実機は未確認
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

async function setup(page) {
  return page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const site = await createSite({ name: "月の選択の試験", startDate: "2026-08-01", endDate: "2027-03-31" });
    const mk = (date, remarks) => createReport({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", remarks, companies: [{ companyId: "c1", companyName: "アオバ塗装工業", occupation: "塗装", actualWorkerCount: "2", workContent: remarks }] });
    // 8月1件・9月2件・10月3件（10/20 に2件）。11月以降は無し（今月に日報が無い場合）
    const ids = [];
    for (const [d, t] of [["2026-08-10", "八月"], ["2026-09-05", "九月A"], ["2026-09-25", "九月B"], ["2026-10-02", "十月A"], ["2026-10-20", "十月B1"], ["2026-10-20", "十月B2"]]) ids.push((await mk(d, t)).id);
    const empty = await createSite({ name: "日報の無い現場" });
    return { site: site.id, empty: empty.id, ids };
  });
}
const listState = (page) => page.evaluate(() => ({
  month: document.getElementById("reportMonthSelect").value,
  label: document.getElementById("reportMonthSelect").selectedOptions[0]?.textContent || "",
  count: document.getElementById("reportMonthCount").textContent,
  dates: [...document.querySelectorAll("#reportList .report-card")].map((li) => (li.textContent.match(/\d{4}-\d{2}-\d{2}/) || [""])[0]),
  empty: document.querySelector("#reportList .empty-message")?.textContent || "",
  options: [...document.getElementById("reportMonthSelect").options].map((o) => o.textContent),
  prevDisabled: document.getElementById("reportMonthPrev").disabled
}));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-month-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await setup(page);
  const snap = () => page.evaluate(async (s) => JSON.stringify((await (await import("/js/reports.js")).listReportsBySite(s)).map((r) => [r.id, r.date, r.remarks, r.updatedAt])), ids.site);
  const before = await snap();

  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#reportMonthBar:not([hidden])"); await page.waitForTimeout(400);
  let st = await listState(page);
  check("最初は日報がある一番新しい年月（今月に日報が無くても 2026年10月）・件数を表示", st.month === "2026-10" && st.label === "2026年10月" && st.count === "2026年10月: 3件", JSON.stringify(st));
  check("選んだ年月の日報だけを、日付の新しい順に表示。同じ日（10/20）の2件はどちらも出る", JSON.stringify(st.dates) === JSON.stringify(["2026-10-20", "2026-10-20", "2026-10-02"]), JSON.stringify(st.dates));
  check("年月の選択肢は日報がある年月（新しい順）と「すべての月」", JSON.stringify(st.options) === JSON.stringify(["2026年10月", "2026年9月", "2026年8月", "すべての月"]), JSON.stringify(st.options));

  await page.selectOption("#reportMonthSelect", "2026-08"); await page.waitForTimeout(200);
  st = await listState(page);
  check("年月を選ぶと、その月の日報だけ（8月は1件）", st.month === "2026-08" && JSON.stringify(st.dates) === JSON.stringify(["2026-08-10"]) && st.count === "2026年8月: 1件", JSON.stringify(st));
  await page.click("#reportMonthNext"); await page.waitForTimeout(200); st = await listState(page);
  check("［次の月 ▶］で9月（2件）", st.month === "2026-09" && st.dates.length === 2 && st.dates.every((d) => d.startsWith("2026-09")), JSON.stringify(st));
  await page.click("#reportMonthPrev"); await page.click("#reportMonthPrev"); await page.waitForTimeout(200); st = await listState(page);
  check("［◀ 前の月］で日報の無い月（7月）も選べ、「日報はありません」と前後の月の案内を表示・選択肢に「（日報なし）」", st.month === "2026-07" && st.dates.length === 0 && /2026年7月の日報はありません/.test(st.empty) && st.label === "2026年7月（日報なし）" && st.count === "2026年7月: 0件", JSON.stringify(st));
  await page.selectOption("#reportMonthSelect", "all"); await page.waitForTimeout(200); st = await listState(page);
  check("「すべての月」で全6件・前後の月のボタンは押せない", st.dates.length === 6 && st.count === "すべての月: 6件" && st.prevDisabled, JSON.stringify({ n: st.dates.length, c: st.count }));

  // 日報を開いて戻っても、選んだ年月のまま
  await page.selectOption("#reportMonthSelect", "2026-09"); await page.waitForTimeout(200);
  await page.click("#reportList .report-card"); await page.waitForSelector(".company-row"); await page.waitForTimeout(300);
  const opened = await page.evaluate(() => document.getElementById("date")?.value);
  check("一覧の日報を押すと、従来どおり日報の画面が開く（9月の日報）", /^2026-09/.test(opened || ""), opened);
  await page.goBack(); await page.waitForSelector("#reportMonthBar:not([hidden])"); await page.waitForTimeout(400);
  st = await listState(page);
  check("日報の画面から戻っても、選んだ年月（9月）のまま", st.month === "2026-09" && st.dates.length === 2, JSON.stringify(st));

  // 絞り込み・検索との組み合わせ
  await page.fill("#reportListSearch", "九月B"); await page.waitForTimeout(300); st = await listState(page);
  check("検索は選んだ年月の中で効き、件数に「絞り込み・検索に合うもの」と出す", st.dates.length === 1 && /9月: 1件（絞り込み・検索に合うもの）/.test(st.count), JSON.stringify(st));
  await page.fill("#reportListSearch", ""); await page.selectOption("#reportListFilter", "missing"); await page.waitForTimeout(300);
  check("「未入力（日報のない日）」の絞り込みでは年月の欄を隠す", await page.evaluate(() => document.getElementById("reportMonthBar").hidden));
  await page.selectOption("#reportListFilter", "all"); await page.waitForTimeout(300);

  // まとめて出力の対象は、月の選択に関係なく従来どおり（絞り込み・検索に合う、すべての月）
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#bulkPrintBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open, null, { timeout: 30000 });
  const title = await page.textContent("#reportPrintTitle"); await page.click("#reportPrintCloseBtn");
  check("まとめて印刷の対象は月の選択（9月）に関係なく、全6件（2026-08-10〜2026-10-20）", /6件: 2026-08-10〜2026-10-20/.test(title), title);
  check("まとめて出力の説明に「月の選択に関係なく、すべての月の分」", (await page.textContent("#reportBulkPanel")).includes("月の選択に関係なく、すべての月の分"));

  check("月の切り替え・日報を開く・まとめて印刷の後も、日報のデータは変わらない", (await snap()) === before);

  // 日報の無い現場
  await page.goto(`${BASE}#/sites/${ids.empty}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(400);
  check("日報の無い現場: 年月の欄は出さず「まだ日報がありません」", await page.evaluate(() => document.getElementById("reportMonthBar").hidden && getComputedStyle(document.getElementById("reportListEmpty")).display !== "none"));
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();

  // iPad の縦・横（WebKit）: 横にはみ出さない・ボタンが 44px 以上
  for (const [label, vp] of [["縦", { width: 820, height: 1180 }], ["横", { width: 1180, height: 820 }]]) {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "report-month-wk-"));
    const c2 = await webkit.launchPersistentContext(d2, { viewport: vp, deviceScaleFactor: 2, hasTouch: true });
    const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
    await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
    const i2 = await setup(p2);
    await p2.goto(`${BASE}#/sites/${i2.site}`); await p2.waitForSelector("#reportMonthBar:not([hidden])"); await p2.waitForTimeout(500);
    await p2.tap("#reportMonthPrev"); await p2.waitForTimeout(200);
    const m = await p2.evaluate(() => { const bar = document.getElementById("reportMonthBar").getBoundingClientRect(); const btns = ["reportMonthPrev", "reportMonthNext", "reportMonthSelect"].map((id) => document.getElementById(id).getBoundingClientRect()); return { overflow: document.documentElement.scrollWidth - window.innerWidth, barRight: bar.right, w: window.innerWidth, minH: Math.min(...btns.map((b) => b.height)), month: document.getElementById("reportMonthSelect").value }; });
    check(`iPad ${label}（WebKit）: 年月の欄が画面の幅に収まり、ボタン・選択欄は44px以上、タップで前の月へ`, m.overflow <= 0 && m.barRight <= m.w && m.minH >= 44 && m.month === "2026-09", JSON.stringify(m));
    await c2.close(); fs.rmSync(d2, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
