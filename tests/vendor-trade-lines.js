// 請求人工・業者別稼働の「業者×職種」の明細（2026-10-25。架空データ・隔離したプロファイル）
//   ・明細は業者名＋日報に保存された職種の名前（前後の空白だけ除く）。似た名前（洗浄と屋根洗浄、外壁補修と外壁下地補修、
//     塗装と塗装屋根洗浄、防水と屋上防水）はまとめない。業者合計＝明細の合計。どの業者にも同じ決まり（特定の業者名の例外は無い）
//   ・明細の［日報］から根拠の日付を選び、日報を開くと該当の業者の行が目立つ。日報を直して保存すると業者管理に戻り、集計し直される
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  // 7: アプリのコードに特定の業者名が書かれていない（業者名で分岐しない）
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "vendor" ? [] : walk(path.join(d, e.name))) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
  const appCode = walk(path.join(__dirname, "..", "js")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  check("7 アプリのコードに業者名（アオバ塗装工業・イズミ足場・エノキ・ウエノなど）が書かれていない", !/アオバ塗装|イズミ足場|エノキ|ウエノ|カエデ美装|オリーブ警備/.test(appCode));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-lines-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const month = today.slice(0, 7);
  const ids = await page.evaluate(async (month) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "業者×職種の明細の試験", startDate: `${month}-01` });
    let n = 0;
    const c = (companyName, occupation, actual, billing) => ({ companyId: `c${++n}`, companyName, occupation, plannedWorkerCount: actual, actualWorkerCount: actual, billingManDays: billing, workContent: `${occupation}の作業`, workHours: "08:00～17:00" });
    const d = (day) => `${month}-${String(day).padStart(2, "0")}`;
    const mk = (day, companies, extra = {}) => stampNew({ siteId: site.id, date: d(day), dayStatus: "work", companies, ...extra });
    const r1 = mk(1, [c("アオバ塗装工業", "洗浄", "2", "2"), c("アオバ塗装工業", "屋根洗浄", "1", "1"), c("アオバ塗装工業", "外壁補修", "3", "3"), c("A社", "防水", "2", "2")]);
    const r2 = mk(2, [c("アオバ塗装工業", "洗浄", "2", "2.5"), c("アオバ塗装工業", "塗装", "4", "4"), c("アオバ塗装工業", "外壁下地補修", "1", "1"), c("A社", "屋上防水", "1", "1"), c("A社", "シーリング", "2", "")]);
    const r3 = mk(3, [c("アオバ塗装工業", "洗浄", "3", "3"), c("アオバ塗装工業", " 塗装屋根洗浄 ", "2", "2"), c("アオバ塗装工業", "塗装", "1", "1"), c("A社", "外壁補修", "1", "1")]);
    const r4 = mk(4, [c("アオバ塗装工業", "洗浄", "5", "5")], { dayStatus: "holiday" }); // 休工日: 稼働には数えない（請求人工は入力されていれば数える）
    for (const r of [r1, r2, r3, r4]) await dbPut("reports", r);
    return { site: site.id, r1: r1.id, r2: r2.id, r3: r3.id };
  }, month);

  // 純粋関数（請求人工・業者別稼働）
  const data = await page.evaluate(async ([siteId, month, today]) => {
    const { dbGetAll } = await import("/js/db.js"); const { getSite } = await import("/js/sites.js"); const bm = await import("/js/billing/billingMonthly.js");
    const reports = (await dbGetAll("reports")).filter((r) => r.siteId === siteId); const site = await getSite(siteId);
    const b = bm.buildMonthlyBilling({ reports, site, month, today });
    const a = bm.buildVendorActivity({ reports, month, today, startDate: site.startDate });
    const p = bm.buildVendorPeriodActivity({ reports, fromMonth: month, toMonth: month, today, startDate: site.startDate });
    const pick = (rows, vendor, key) => { const r = rows.find((x) => x.vendor === vendor); return r ? { total: r[key], lines: Object.fromEntries(r.lines.map((l) => [l.trade, l[key]])) } : null; };
    return { b: { アオバ塗装: pick(b.rows, "アオバ塗装工業", "manDays"), A: pick(b.rows, "A社", "manDays") }, a: { アオバ塗装: pick(a.rows, "アオバ塗装工業", "manDays"), A: pick(a.rows, "A社", "manDays"), cum: pick(a.rows, "アオバ塗装工業", "cumManDays") }, p: { アオバ塗装: pick(p.rows, "アオバ塗装工業", "total") }, dates: b.rows.find((x) => x.vendor === "アオバ塗装工業").lines.find((l) => l.trade === "洗浄").entries.map((e) => e.date) };
  }, [ids.site, month, today]);
  const sum = (o) => Math.round(Object.values(o).reduce((s, v) => s + v, 0) * 100) / 100;
  const nb = data.b.アオバ塗装, na = data.a.アオバ塗装;
  check("1 請求人工: アオバ塗装工業の洗浄・屋根洗浄・外壁補修・塗装が別の明細（洗浄は3日分で 2＋2.5＋3＋休工日の5）", nb && nb.lines["洗浄"] === 12.5 && nb.lines["屋根洗浄"] === 1 && nb.lines["外壁補修"] === 3 && nb.lines["塗装"] === 5, JSON.stringify(nb));
  check("2 請求人工: 似た名前はまとめない（外壁下地補修・塗装屋根洗浄は別。名前の前後の空白だけ除く）", nb.lines["外壁下地補修"] === 1 && nb.lines["塗装屋根洗浄"] === 2 && Object.keys(nb.lines).length === 6, JSON.stringify(Object.keys(nb.lines)));
  check("3 請求人工: 業者合計＝明細の合計（アオバ塗装工業 24.5）", nb.total === 24.5 && sum(nb.lines) === nb.total, `${nb.total} / ${sum(nb.lines)}`);
  check("4 業者別稼働: アオバ塗装工業の職種ごとの明細（休工日は数えない: 洗浄 2＋2＋3＝7）", na && na.lines["洗浄"] === 7 && na.lines["屋根洗浄"] === 1 && na.lines["外壁補修"] === 3 && na.lines["塗装"] === 5 && na.lines["外壁下地補修"] === 1 && na.lines["塗装屋根洗浄"] === 2, JSON.stringify(na));
  check("5 業者別稼働: 業者合計＝明細の合計（アオバ塗装工業 19）・累計・期間の集計も明細の合計と一致", na.total === 19 && sum(na.lines) === 19 && data.a.cum.total === sum(data.a.cum.lines) && data.p.アオバ塗装.total === sum(data.p.アオバ塗装.lines), JSON.stringify({ a: na.total, cum: data.a.cum.total, p: data.p.アオバ塗装.total }));
  check("6 新しい業者（A社）も同じ決まり: 防水・屋上防水・シーリング・外壁補修は別の明細、業者合計＝明細の合計", data.a.A && data.a.A.lines["防水"] === 2 && data.a.A.lines["屋上防水"] === 1 && data.a.A.lines["シーリング"] === 2 && data.a.A.lines["外壁補修"] === 1 && data.a.A.total === 6 && data.b.A.total === 4 && !("シーリング" in data.b.A.lines), JSON.stringify({ a: data.a.A, b: data.b.A }));

  // 画面: 請求人工管理の明細 → 日報の日付 → 日報（該当の業者の行が目立つ）→ 修正・保存 → 業者管理に戻り集計し直す
  await page.goto(`${BASE}#/sites/${ids.site}/vendors`); await page.waitForSelector("#vendorMgmtMonth"); await page.waitForTimeout(300);
  const actLines = await page.evaluate(() => [...document.querySelectorAll(".vm-activity tbody tr.vm-line")].map((tr) => tr.cells[0].textContent.replace(/\s+/g, "")));
  check("業者別稼働の画面: 業者の行（業者合計）の下に職種ごとの明細が出る", actLines.some((t) => t.startsWith("└洗浄")) && actLines.some((t) => t.startsWith("└屋根洗浄")) && actLines.some((t) => t.startsWith("└防水")) && actLines.some((t) => t.startsWith("└屋上防水")), JSON.stringify(actLines));
  // 9: 業者別稼働から日報へ
  const key = (kind, v, t) => `${kind}|${v}|${t}`;
  await page.click(`[data-vm-line="${key("activity", "アオバ塗装工業", "外壁補修")}"]`);
  await page.waitForSelector(".vm-line-dates .vm-line-report");
  await page.click(".vm-line-dates .vm-line-report"); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500);
  const hl1 = await page.evaluate(() => [...document.querySelectorAll(".company-row.is-line-highlight")].map((r) => `${r.querySelector(".companyName").value}／${r.querySelector(".occupation").value}`));
  check("9 業者別稼働の明細から元の日報を開き、該当の業者の行（アオバ塗装工業／外壁補修）が目立つ", JSON.stringify(hl1) === JSON.stringify(["アオバ塗装工業／外壁補修"]) && (await page.evaluate(() => location.hash)).includes(`/report/`), JSON.stringify(hl1));
  await page.click("#reportCancelBtn"); await page.waitForTimeout(500);
  check("日報をキャンセルすると業者管理に戻る", await page.isVisible("#view-vendor-management"));
  // 8・10: 請求人工の明細（洗浄は3日）→ 日付を選ぶ
  await page.click('[data-vm-tab="billing"]'); await page.waitForTimeout(300);
  await page.click(`[data-vm-line="${key("billing", "アオバ塗装工業", "洗浄")}"]`); await page.waitForSelector(".vm-line-dates .vm-line-report");
  const dateBtns = await page.evaluate(() => [...document.querySelectorAll(".vm-line-dates .vm-line-report")].map((b) => b.textContent));
  check("10 複数の日に当たる明細は日付を選べる（アオバ塗装工業／洗浄: 4日分の日報）", dateBtns.length === 4 && data.dates.length === 4, JSON.stringify(dateBtns));
  await page.click(".vm-line-dates .vm-line-report:nth-of-type(3)"); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500);
  const hl2 = await page.evaluate(() => ({ date: document.getElementById("reportDate")?.value || document.querySelector("#reportForm input[type=date]")?.value, rows: [...document.querySelectorAll(".company-row.is-line-highlight")].map((r) => `${r.querySelector(".companyName").value}／${r.querySelector(".occupation").value}`) }));
  check("8 請求人工の明細から選んだ日（3日目）の日報を開き、アオバ塗装工業／洗浄の行が目立つ", hl2.date === `${month}-03` && JSON.stringify(hl2.rows) === JSON.stringify(["アオバ塗装工業／洗浄"]), JSON.stringify(hl2));
  // 11: 日報で職種を「屋根洗浄」に直して保存 → 業者管理に戻り、明細が変わる
  await page.fill(".company-row.is-line-highlight .occupation", "屋根洗浄");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-vendor-management:not([hidden])"); await page.waitForTimeout(500);
  const after = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".billing-table tbody tr")].filter((tr) => tr.classList.contains("vm-line")).map((tr) => [tr.cells[0].textContent.replace(/\s+/g, "").replace(/日報.*$/, ""), tr.cells[1].textContent.replace(/\s+/g, "")])));
  const vendorTotal = await page.evaluate(() => document.querySelector('.billing-table tr[data-billing-row="アオバ塗装工業"] td:nth-child(2) b')?.textContent);
  check("11 日報を直して保存すると業者管理に戻り、集計し直される（洗浄 12.5→9.5・屋根洗浄 1→4、業者合計 24.5 のまま）", after["└洗浄"] === "9.5人工" && after["└屋根洗浄"] === "4人工" && vendorTotal === "24.5人工", JSON.stringify({ after, vendorTotal }));
  check("日報データは直した1行の職種だけが変わる（人数・請求人工はそのまま）", await page.evaluate(async (id) => { const r = await (await import("/js/reports.js")).getReport(id); const c = r.companies.find((x) => x.companyName === "アオバ塗装工業" && x.occupation === "屋根洗浄"); return !!c && c.actualWorkerCount === "3" && c.billingManDays === "3"; }, ids.r3));
  check("DB の版は 10 のまま", (await page.evaluate(async () => (await import("/js/db.js")).DB_VERSION)) === 10);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
