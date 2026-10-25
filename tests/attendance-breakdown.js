// 稼働人数の集計を現場ダッシュボードと 03-2（1日分のExcel・PDF）でそろえる（2026-10-25。架空データ・隔離したプロファイル）
//   ①同じ工種の複数の業者 ②同じ業者の複数の工種・棟 ③同じ業者名の2業者（見分ける項目が無ければ推測で分けない）
//   ④様式に無い新しい工種 ⑤ダッシュボードと 03-2 の一致 ⑥二重に数えない ⑦人数未入力・0人・業者名／工種の未入力
//   ⑧空き行が足りないとき、その日に稼働した工種を先に書く（以前は前の工種が空き行を使い切り、その日の工種が計にしか入らなかった）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 純粋関数
  const pure = await page.evaluate(async () => {
    const { attendanceBreakdown, workersOf, buildingsInText } = await import("/js/dashboard/attendanceBreakdown.js");
    const row = (companyName, occupation, n, workContent = "") => ({ companyName, occupation, actualWorkerCount: n, workContent });
    const today = [row("協栄工業", "足場", "6", "RK号棟 足場組立"), row("西原建設", "足場工事", "2", "RJ号棟 足場組立"),
      row("ナダカ工業", "外壁洗浄", "2", "RJ号棟 外壁洗浄"), row("ナダカ工業", "屋根洗浄", "1", "ＲＫ 号棟 屋根洗浄"), row("ナダカ工業", "外壁下地補修", "3", "RL号棟・RJ号棟 下地補修"),
      row("野本建装工業", "塗装", "3", "RJ号棟 塗装"), row("野本建装工業", "塗装工事", "2", "RK号棟 塗装")];
    const b = attendanceBreakdown({ todayCompanies: today, historyReports: [{ date: "2026-10-01", companies: [row("協栄工業", "足場", "4")] }, { date: "2026-10-02", companies: today }] });
    const split = attendanceBreakdown({ todayCompanies: [row("野本建装工業（A班）", "塗装", "3"), row("野本建装工業（B班）", "塗装", "2")], historyReports: [] });
    const odd = attendanceBreakdown({ todayCompanies: [row("甲", "塗装", ""), row("乙", "塗装", "0"), row("丙", "塗装", "abc"), row("丁", "塗装", "-2"), row("", "塗装", "2"), row("戊", "", "3"), row("己", "塗装", "１")], historyReports: [] });
    return {
      rows: b.rows.map((r) => `${r.vendor}|${r.trade}|${r.today}|${r.cumulative}|${r.buildingsToday.join(",")}`),
      trades: b.trades.map((t) => `${t.label}|${t.today}|${t.cumulative}|${t.vendorsToday.map((v) => `${v.vendor}${v.today}`).join(",")}`),
      totals: b.totals, split: split.rows.map((r) => `${r.vendor}|${r.today}`),
      odd: { rows: odd.rows.map((r) => `${r.vendor}|${r.trade}|${r.today}`), totals: odd.totals, noTrade: odd.noTrade },
      w: [workersOf({ actualWorkerCount: " 3 " }), workersOf({ actualWorkerCount: "2.5" }), workersOf({}), workersOf({ actualWorkerCount: "-1" })],
      bld: buildingsInText("RJ号棟・ｒｋ号棟 と 3号棟、RJ号棟")
    };
  });
  check("①足場: 協栄工業と西原建設は別の行（6人・2人）、工種の合計は8人（足場／足場工事の表記ゆれはそろえる）", pure.rows.includes("協栄工業|足場|6|10|RK号棟") && pure.rows.includes("西原建設|足場|2|2|RJ号棟") && pure.trades.includes("足場|8|12|協栄工業6,西原建設2"), JSON.stringify(pure.trades));
  check("②ナダカ工業: 外壁洗浄・屋根洗浄・外壁下地補修は別の工種の行で、作業内容の棟を保つ（1行に2つの棟でも人数は1回）", pure.rows.includes("ナダカ工業|外壁洗浄|2|2|RJ号棟") && pure.rows.includes("ナダカ工業|屋根洗浄|1|1|RK号棟") && pure.rows.includes("ナダカ工業|外壁下地補修|3|3|RL号棟,RJ号棟"), JSON.stringify(pure.rows));
  check("③野本建装工業: 業者名と工種しか無ければ同じ業者として数える（推測で分けない。2行の合計5人）", pure.rows.includes("野本建装工業|塗装|5|5|RJ号棟,RK号棟"));
  check("③業者名で見分けられれば（A班・B班）別々に数える", pure.split.join(" ") === "野本建装工業（A班）|3 野本建装工業（B班）|2", pure.split.join(" "));
  check("⑥合計は行の合計と同じ（その日19人・累計23人。二重に数えない）", pure.totals.today === 19 && pure.totals.cumulative === 23, JSON.stringify(pure.totals));
  check("⑦人数が空・0・数字でない・負は0人、全角の数字は読む、業者名未入力は「（業者名未入力）」、工種未入力も合計に入る", pure.odd.totals.today === 6 && pure.odd.noTrade.today === 3 && pure.odd.rows.includes("（業者名未入力）|塗装|2") && pure.odd.rows.includes("己|塗装|1") && !pure.odd.rows.some((r) => /^(甲|乙|丙|丁)\|/.test(r)), JSON.stringify(pure.odd));
  check("実績人数の読み方（前後の空白・小数・未入力・負）", JSON.stringify(pure.w) === "[3,2.5,0,0]", JSON.stringify(pure.w));
  check("棟の読み取り（全角・小文字・数字の棟、重複は1つ）", JSON.stringify(pure.bld) === '["RJ号棟","RK号棟","3号棟"]', JSON.stringify(pure.bld));

  // 現場の日報（様式に業種名の無い工種を7種類。前の日に6種類が空き行を使う）
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "稼働人数の集計の試験", startDate: "2026-10-01" });
    const c = (companyName, occupation, n, workContent = "") => ({ companyId: Math.random().toString(36).slice(2), companyName, occupation, plannedWorkerCount: n, actualWorkerCount: n, workContent, billingManDays: "9" });
    const day1 = stampNew({ siteId: site.id, date: "2026-10-01", dayStatus: "work", companies: [c("田尻土建", "多能工", "2"), c("大川緑地", "植栽工事", "3"), c("ビソー工業", "美装", "2"), c("協栄工業", "足場", "5"), c("ナダカ工業", "外壁補修", "2"), c("新和設備", "設備", "1")] });
    const day2 = stampNew({ siteId: site.id, date: "2026-10-02", dayStatus: "holiday", companies: [c("協栄工業", "足場", "9")] }); // 休工日は数えない
    const day3 = stampNew({ siteId: site.id, date: "2026-10-03", dayStatus: "work", companies: [
      c("協栄工業", "足場", "6", "RK号棟 足場組立"), c("西原建設", "足場工事", "2", "RJ号棟 足場組立"),
      c("ナダカ工業", "外壁洗浄", "2", "RJ号棟"), c("ナダカ工業", "屋根洗浄", "1", "RK号棟"), c("ナダカ工業", "外壁下地補修", "3", "RL号棟"),
      c("野本建装工業", "塗装", "3", "RJ号棟"), c("野本建装工業", "塗装", "2", "RK号棟"), c("グリーン警備", "警備", "1"), c("", "外壁シーリング", "2"), c("甲工業", "", "1"), c("乙工業", "塗装", "")] , staffCount: 1 });
    for (const r of [day1, day2, day3]) await dbPut("reports", r);
    return { site: site.id, day3: day3.id };
  });

  const compare = await page.evaluate(async (ids) => {
    const { dbGetAll } = await import("/js/db.js"); const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { getSite } = await import("/js/sites.js");
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js"); const rp = await import("/js/reportPrint.js");
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const xr = await import("/js/report-output/xlsxSheetReader.js"); const { normalizeTrade } = await import("/js/report-output/tradeAttendance.js");
    const site = await getSite(ids.site); const reps = (await dbGetAll("reports")).filter((r) => r.siteId === ids.site);
    const m = buildDashboardModel({ site, reports: reps, signatures: [], date: "2026-10-03" });
    const t = await rp.resolveCompanyTemplateForSite(site);
    const o = await generateReportOutput({ reportId: ids.day3, format: "excel", templateId: t?.templateId || null });
    const zip = loadZip(await o.blob.arrayBuffer()); const sheet = [...zip.entries.keys()].find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const lay = xr.readSheetLayout(await readZipEntryText(zip, sheet), xr.parseSharedStrings(await readZipEntryText(zip, "xl/sharedStrings.xml")));
    const cell = (ref) => lay.cells.get(ref)?.text ?? "";
    const sheetRows = []; for (let row = 7; row <= 49; row++) { const label = cell(`M${row}`) || cell(`N${row}`); if (cell(`O${row}`) || cell(`P${row}`)) sheetRows.push({ row, label, key: normalizeTrade(label), O: Number(cell(`O${row}`) || 0), P: Number(cell(`P${row}`) || 0) }); }
    const pdf = await generateReportOutput({ reportId: ids.day3, format: "pdf", pdfVariant: "company", templateId: t?.templateId || null });
    return {
      dash: m.staff.byOccupation.map((x) => ({ label: x.occupation, key: normalizeTrade(x.occupation), today: x.count, cum: x.cumulative, vendors: x.vendors.map((v) => `${v.vendor}${v.today}${v.buildings.join("")}`) })),
      dashTotal: m.staff.totalToday, dashCum: m.staff.cumulative, works: m.works.filter((w) => w.vendor === "野本建装工業").map((w) => w.actual),
      sheetRows, total: [Number(cell("O51")), Number(cell("P51")), Number(cell("O52"))], warnings: o.warnings || [], pdfHtml: pdf.html
    };
  }, ids);
  const sheetBy = new Map(compare.sheetRows.map((r) => [r.key, r]));
  const dashBy = new Map(compare.dash.map((d) => [d.key, d]));
  check("④様式に無い新しい工種（外壁シーリング・外壁洗浄・屋根洗浄・外壁下地補修）がダッシュボードと03-2に出る", ["外壁シーリング", "外壁洗浄", "屋根洗浄", "外壁下地補修"].every((k) => dashBy.has(k) && sheetBy.has(k)), JSON.stringify(compare.sheetRows.map((r) => r.label)));
  const mismatch = compare.dash.filter((d) => d.label !== "（工種未入力）" && !(sheetBy.get(d.key)?.O === d.today && sheetBy.get(d.key)?.P === d.cum));
  check("⑤その日に稼働した工種は、ダッシュボードと03-2で人数・累計が同じ", mismatch.length === 0 && compare.dash.length >= 8, JSON.stringify(mismatch));
  check("⑤計（監督・職員を含む）・累計・延労働時間がダッシュボードと同じ", compare.total[0] === compare.dashTotal && compare.total[1] === compare.dashCum && compare.total[2] === compare.dashTotal * 8, `${compare.total} / ${compare.dashTotal},${compare.dashCum}`);
  check("①ダッシュボードの足場は業者ごとの内訳（協栄工業6・西原建設2）と棟、03-2の足場は8人・累計13人（休工日の9人は数えない）", JSON.stringify(dashBy.get("足場")?.vendors) === JSON.stringify(["協栄工業6RK号棟", "西原建設2RJ号棟"]) && sheetBy.get("足場")?.O === 8 && sheetBy.get("足場")?.P === 13, JSON.stringify(dashBy.get("足場")));
  check("③同じ業者名の2行は本日の作業では2行のまま（3人・2人）、工種の集計では5人", JSON.stringify(compare.works) === "[3,2]" && dashBy.get("塗装")?.today === 5 && sheetBy.get("塗装")?.O === 5);
  check("⑦工種未入力の1人はダッシュボードに「（工種未入力）」として出て、03-2では計にだけ入る（警告あり）", compare.dash.find((d) => d.label === "（工種未入力）")?.today === 1 && compare.warnings.some((w) => /工種が未入力/.test(w)), JSON.stringify(compare.warnings));
  check("⑧空き行は、その日に稼働した工種を先に使う（前の日の工種で埋まっていても、その日の工種は全部書く）", ["外壁シーリング", "外壁洗浄", "屋根洗浄", "外壁下地補修", "足場"].every((k) => sheetBy.get(k)?.O > 0));
  check("⑧空き行に入らない前の日の工種は、書けないことを警告する（累計の計には入る）", compare.warnings.some((w) => /累計.*行が足りない/.test(w)), JSON.stringify(compare.warnings));
  check("会社様式の印刷用HTML（PDF）にも新しい工種が出る", ["外壁シーリング", "外壁洗浄", "屋根洗浄", "外壁下地補修"].every((k) => compare.pdfHtml.includes(`>${k}<`)));

  // 台帳: 計・累計・延労働時間（各頁の O51・O52・P51・P52）は業種の行の合計ではなく、ダッシュボードと同じ全体の人数＋社員（2026-10-25）
  const ledger = await page.evaluate(async (ids) => {
    const { dbGetAll } = await import("/js/db.js"); const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { getSite } = await import("/js/sites.js");
    const rp = await import("/js/reportPrint.js"); const { generateLedgerWorkbook } = await import("/js/report-output/ledger/generateLedgerOutput.js");
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const xr = await import("/js/report-output/xlsxSheetReader.js");
    const site = await getSite(ids.site); const reps = (await dbGetAll("reports")).filter((r) => r.siteId === ids.site);
    const t = await rp.resolveCompanyTemplateForSite(site);
    const led = await generateLedgerWorkbook({ siteId: ids.site, templateId: t.templateId });
    const zip = loadZip(await led.blob.arrayBuffer());
    const wb = await readZipEntryText(zip, "xl/workbook.xml"); const rels = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
    const first = /<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1]; const sheetPath = "xl/" + new RegExp(`Id="${first}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?xl\//, "");
    const xml = await readZipEntryText(zip, sheetPath);
    const lay = xr.readSheetLayout(xml, xr.parseSharedStrings(await readZipEntryText(zip, "xl/sharedStrings.xml")));
    const v = (ref) => Number(lay.cells.get(ref)?.text || 0);
    const pages = [];
    for (const [d, date] of [[0, "2026-10-01"], [1, "2026-10-02"], [2, "2026-10-03"]]) {
      const off = d * 52; const m = buildDashboardModel({ site, reports: reps, signatures: [], date });
      let rowsSum = 0; for (let r = 7; r <= 50; r++) rowsSum += v(`O${r + off}`);
      const formulaLeft = ["O51", "O52", "P51", "P52"].some((c) => { const ref = c.replace(/\d+/, (n) => String(Number(n) + off)); return new RegExp(`<c r="${ref}"[^>]*>\\s*<f`).test(xml); });
      pages.push({ date, ledger: [v(`O${51 + off}`), v(`P${51 + off}`), v(`O${52 + off}`), v(`P${52 + off}`)], dash: [m.staff.totalToday, m.staff.cumulative, m.staff.totalToday * 8, m.staff.cumulative * 8], rowsSum, formulaLeft });
    }
    const p51 = /<c r="P51"[^>]*>/.test(xml), p7 = /<c r="P7"[^>]*>\s*<f/.test(xml) || /<c r="P59"[^>]*>\s*<f/.test(xml);
    return { pages, rowFormulasKept: p7 && p51, warnings: led.warnings.filter((w) => /行|工種/.test(w)) };
  }, ids);
  check("台帳: 計・累計・延労働時間がダッシュボードと同じ（3日分。休工日の頁は0人・累計はそのまま）", ledger.pages.every((p) => JSON.stringify(p.ledger) === JSON.stringify(p.dash)), JSON.stringify(ledger.pages.map((p) => [p.date, p.ledger, p.dash])));
  const lp3 = ledger.pages[2];
  check("台帳: 行に入りきらない工種・工種未入力の人数も計に入る（業種の行の合計より多い）", lp3.ledger[0] > lp3.rowsSum && lp3.ledger[0] === lp3.dash[0], `計${lp3.ledger[0]}・行の合計${lp3.rowsSum}`);
  check("台帳: 計・延労働時間の4つのセルは値（数式を置き換え）、業種の行の累計の数式は残す", ledger.pages.every((p) => !p.formulaLeft) && ledger.rowFormulasKept);
  check("台帳: 行に入りきらない工種は「業種の行には出していません（人数は計・累計に含めています）」と警告", ledger.warnings.some((w) => /業種の行には出していません（人数は計・累計に含めています）/.test(w)), JSON.stringify(ledger.warnings));

  // 画面: ダッシュボードの職種別の人数に業者ごとの内訳
  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.goto(`${BASE}#/sites`); await page.waitForTimeout(200);
  await page.evaluate((siteId) => { window.__dashboardDate = { siteId, date: "2026-10-03" }; }, ids.site);
  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForTimeout(800);
  await page.click('[data-dash-tab="board"], [data-tab="board"]').catch(() => {});
  const dashText = await page.evaluate(() => document.getElementById("siteDashboard")?.textContent.replace(/\s+/g, " ") || "");
  check("画面のダッシュボードに足場の業者ごとの内訳が出る（請求人工は出ない）", /協栄工業 6人（RK号棟）・西原建設 2人（RJ号棟）/.test(dashText) && !/請求人工/.test(dashText), dashText.slice(0, 160));
  check("DB の版は 10 のまま", (await page.evaluate(async () => (await import("/js/db.js")).DB_VERSION)) === 10);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
