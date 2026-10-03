// 日報 → 03-2（Excel・PDF・台帳）→ ダッシュボードのデータ連携の検証（実ブラウザ・実IndexedDB。データは架空）
//   ・稼動人数表: 業種の当てはめ（塗装＝塗装工事・警備＝警備員・とび＝鳶工事）、様式に無い業種は空き行へ業種名つき、
//     その日の人数・累計・計（社員を含む）・延労働時間（計×8）
//   ・資材・機材搬入（ＡＭ／ＰＭ）、本日の重点指示、作業間の連絡・調整
//   ・PDF: 縦書きのセル（巡回点検の分類名）を縦書きで表示、A3横・1ページ・収まらないセル無し
//   ・台帳: その日の人数・空き行の業種名を各頁に書き、累計・計・延労働時間は様式の数式で計算
//   ・日誌: 本日の重点指示・作業間の連絡・調整・人工（請求用）の入力と保存、以前の作業時間「8:00から17:00」の読み込み
//   ・ダッシュボード: 業者別 稼働状況（稼働人数と人工を別に）、本日の重点指示・作業間の連絡・調整、累計（社員を含む）
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/diary-to-03-2.js（鍵ファイルが必要）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-to-03-2-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 工期 2026-09-01〜2026-09-10。1日目・2日目の日報（2日目は画面で入力）
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js");
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "連携確認現場", startDate: "2026-09-01", endDate: "2026-09-10" });
    const d1 = stampNew({ siteId: site.id, date: "2026-09-01", weather: "晴れ", siteSupervisorNames: ["監督A"],
      companies: [
        { companyId: "a", companyName: "サンプル塗装", occupation: "塗装工事", actualWorkerCount: "3", workHours: "8:00から17:00" },
        { companyId: "b", companyName: "サンプル緑化", occupation: "植栽工事", actualWorkerCount: "4", workHours: "8:30〜17:00" },
        { companyId: "c", companyName: "サンプル警備", occupation: "警備", actualWorkerCount: "1", workHours: "8:00" }
      ],
      deliveries: [{ id: "x1", direction: "in", time: "08:30", item: "塗料", quantity: "20缶", vendor: "サンプル商事", status: "done" }, { id: "x2", direction: "out", time: "15:00", item: "残材", status: "plan" }, { id: "x3", direction: "in", time: "16:00", item: "足場材", status: "cancelled" }] });
    await dbPut("reports", d1);
    return { siteId: site.id, d1: d1.id };
  });

  // ---- 日誌（2日目）を画面で入力 ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=2026-09-02`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const fill = async (i, f) => { const r = page.locator(".company-row").nth(i); for (const [cls, v] of Object.entries(f)) await r.locator(`.${cls}`).fill(v); };
  await fill(0, { companyName: "サンプル塗装", occupation: "塗装", actualWorkerCount: "2" }); await page.locator(".company-row").nth(0).locator(".workStart").selectOption("08:00");
  await page.click("#addCompanyBtn"); await fill(1, { companyName: "サンプル足場", occupation: "とび", actualWorkerCount: "4", billingManDays: "3.5" });
  await page.locator(".company-row").nth(1).locator(".workStart").selectOption("08:00"); await page.locator(".company-row").nth(1).locator(".workEnd").selectOption("12:00");
  await page.click("#addCompanyBtn"); await fill(2, { companyName: "サンプル緑化", occupation: "植栽工事", actualWorkerCount: "2" });
  await page.click("#addSiteSupervisorBtn"); await page.locator(".siteSupervisorNameInput").last().fill("監督A");
  for (const [t, item, q, v] of [["07:30", "鋼管", "100本", "サンプルリース"], ["09:00", "クランプ", "200個", ""], ["10:00", "足場板", "50枚", ""], ["11:00", "ネット", "10枚", ""], ["13:00", "塗料", "10缶", "サンプル商事"]]) {
    await page.click("#addDeliveryBtn"); const r = page.locator(".delivery-row").last();
    await r.locator(".dlvTime").fill(t); await r.locator(".dlvItem").fill(item); await r.locator(".dlvQuantity").fill(q); if (v) await r.locator(".dlvVendor").fill(v);
  }
  await page.fill("#focusInstructions", "開口部の養生確認を徹底\n重機作業時は誘導員を配置");
  await page.fill("#workCoordination", "午後は塗装と足場解体が同じ区画\n時間をずらす\n3行目\n4行目\n5行目\n6行目\n7行目");
  // 不正な請求人工
  await page.locator(".company-row").nth(0).locator(".billingManDays").fill("-1");
  await page.click("#reportSaveBtn"); await page.waitForTimeout(300);
  check("日誌: 請求人工にマイナスは保存できない", (await page.isVisible("#view-report-form")) && (await page.textContent("#message")).includes("請求人工は0以上"));
  await page.locator(".company-row").nth(0).locator(".billingManDays").fill("");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const d2 = await page.evaluate(async (sid) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === "2026-09-02"), ids.siteId);
  check("日誌: 本日の重点指示・作業間の連絡・調整・請求人工（足場3.5）・現場監督を保存", d2.siteSupervisorNames.join() === "監督A" && d2.focusInstructions.startsWith("開口部の養生") && d2.workCoordination.includes("7行目") && d2.companies[1].billingManDays === "3.5");
  check("人工 ケース2: 稼働人数4人＋請求人工3.5 → 稼働人数4のまま・請求人工3.5を別の項目として保存", d2.companies[1].actualWorkerCount === "4" && d2.companies[1].billingManDays === "3.5" && d2.companies[1].manDays === undefined);
  check("人工 ケース3: 請求人工が未入力 → 空のまま保存（稼働人数から推測して入れない）", d2.companies[0].billingManDays === "" && d2.companies[2].billingManDays === "", JSON.stringify(d2.companies.map((c) => c.billingManDays)));
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${d2.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const re = await page.evaluate(() => ({ f: document.getElementById("focusInstructions").value, w: document.getElementById("workCoordination").value, m: document.querySelectorAll(".company-row .billingManDays")[1].value, m0: document.querySelectorAll(".company-row .billingManDays")[0].value, ph: document.querySelectorAll(".company-row .billingManDays")[0].placeholder }));
  check("日誌: 開き直すと重点指示・連絡調整・請求人工が残っている", re.f.includes("重機作業時") && re.w.includes("時間をずらす") && re.m === "3.5");
  check("人工 ケース3: 請求人工が未入力の業者は欄が空で「未入力」と表示", re.m0 === "" && re.ph === "未入力");
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.d1}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const legacy = await page.evaluate(() => [...document.querySelectorAll(".company-row")].map((r) => `${r.querySelector(".workStart").value}-${r.querySelector(".workEnd").value}`));
  check("日誌: 以前の作業時間「8:00から17:00」「8:30〜17:00」「8:00」を開始・終了として読み込む", legacy.join() === "08:00-17:00,08:30-17:00,08:00-", legacy.join());

  // ---- 1日分のExcel（2日目）----
  const readXlsx = (file, sheetIndex = 0) => page.evaluate(async ({ b64, sheetIndex }) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[sheetIndex];
    const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
    const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
    const o = {}; for (const [ref, c] of L.cells) if (c.text) o[ref] = c.text; return { name: s.name, cells: o };
  }, { b64: fs.readFileSync(file).toString("base64"), sheetIndex });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => { window.__w = (await (await import("/js/reportPrint.js")).exportReportExcel(id)).warnings; }, d2.id)]);
  const xf = path.join(dir, "d2.xlsx"); await dl.saveAs(xf);
  const x = (await readXlsx(xf)).cells;
  check("Excel 稼動人数: 塗装→塗装工事の行（人数2・累計5）、とび→鳶工事の行（4・4）、警備→警備員の行（累計1）", x.O33 === "2" && x.P33 === "5" && x.O7 === "4" && x.P7 === "4" && !x.O49 && x.P49 === "1", JSON.stringify({ O33: x.O33, P33: x.P33, O7: x.O7, P7: x.P7, P49: x.P49 }));
  check("人工 ケース6・7: 03-2には稼働人数だけ（足場 稼働4人・請求人工3.5 → 鳶工事の行に4。3.5はどのセルにも書かない）", x.O7 === "4" && !Object.values(x).some((v) => v.includes("3.5")), JSON.stringify({ O7: x.O7 }));
  check("Excel 稼動人数: 様式に無い業種（植栽工事）は空き行（26行目）に業種名つきで（人数2・累計6）", x.M26 === "植栽工事" && x.O26 === "2" && x.P26 === "6", JSON.stringify({ M26: x.M26, O26: x.O26, P26: x.P26 }));
  const sup2 = d2.siteSupervisorNames?.filter(Boolean).length || 0;
  const todayTotal = 2 + 4 + 2 + sup2; const cumTotal = 8 + 1 + todayTotal;
  check(`Excel 稼動人数: 計（社員を含む ${todayTotal}・累計${cumTotal}）と延労働時間（計×8）`, x.O51 === String(todayTotal) && x.P51 === String(cumTotal) && x.O52 === String(todayTotal * 8) && x.P52 === String(cumTotal * 8), JSON.stringify({ O51: x.O51, P51: x.P51, O52: x.O52, P52: x.P52 }));
  check("Excel 資材・機材搬入: ダッシュボードと同じ搬入・搬出を、午前は37〜39行目（3行を超えた分は「ほか」）、午後はF37", x.A37?.startsWith("07:30 搬入 鋼管 100本（サンプルリース）") && x.A38?.startsWith("09:00 搬入 クランプ") && x.A39?.includes("ほか1件") && x.F37?.startsWith("13:00 搬入 塗料 10缶（サンプル商事）"), JSON.stringify({ A37: x.A37, A39: x.A39, F37: x.F37 }));
  check("Excel 本日の重点指示（41行目〜）・作業間の連絡・調整（47行目〜。6行を超えた分は最後の行に続ける）", x.A41 === "開口部の養生確認を徹底" && x.A42 === "重機作業時は誘導員を配置" && x.A47 === "午後は塗装と足場解体が同じ区画" && x.A52 === "6行目　7行目", JSON.stringify({ A41: x.A41, A47: x.A47, A52: x.A52 }));
  const [dl1] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), ids.d1)]);
  const xf1 = path.join(dir, "d1.xlsx"); await dl1.saveAs(xf1); const x1 = (await readXlsx(xf1)).cells;
  check("Excel（1日目）: ＡＭに搬入「08:30 搬入 塗料 20缶」、ＰＭに搬出「15:00 搬出 残材」・中止「16:00 搬入 足場材（中止）」（ダッシュボードと同じ）・塗装工事3人", x1.A37?.startsWith("08:30 搬入 塗料 20缶") && x1.F37 === "15:00 搬出 残材" && x1.F38 === "16:00 搬入 足場材（中止）" && x1.O33 === "3" && x1.P33 === "3", JSON.stringify({ A37: x1.A37, F37: x1.F37, F38: x1.F38 }));

  // ---- PDF（2日目）----
  const html = await page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, d2.id);
  const p2 = await ctx.newPage(); await p2.setContent(html); await p2.waitForTimeout(300);
  const pm = await p2.evaluate(() => { dispatchEvent(new Event("beforeprint")); const v = [...document.querySelectorAll(".xc.xc-vert")].map((c) => c.textContent); const wm = getComputedStyle(document.querySelector(".xc.xc-vert > span")).writingMode; const t = document.body.textContent; return { v, wm, clipped: window.__xlsxCellsClipped, has: ["植栽工事", "07:30 搬入 鋼管", "開口部の養生確認を徹底", "午後は塗装と足場解体"].every((s) => t.includes(s)) }; });
  const pdf = Buffer.from(await p2.pdf({ preferCSSPageSize: true })).toString("latin1"); await p2.close();
  check("PDF: 巡回点検の分類名（管理・環境・仮設設備…）を縦書きで表示", ["管理", "環境", "仮設設備", "墜落防止", "建設機械関連", "崩壊防止", "その他"].every((w) => pm.v.includes(w)) && pm.wm === "vertical-rl", `${pm.v.join("・")} ${pm.wm}`);
  check("PDF: Excelと同じ内容（稼動人数・搬入・重点指示・連絡調整）・A3横・1ページ・収まらないセル無し", pm.has && pm.clipped === 0 && (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf));

  // ---- 台帳 ----
  const [ldl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (sid) => (await import("/js/reportPrint.js")).exportSiteLedgerExcel(sid), ids.siteId)]);
  const lf = path.join(dir, "ledger.xlsx"); await ldl.saveAs(lf); const lg = (await readXlsx(lf)).cells;
  // 1日目＝1頁目（1〜52行）、2日目＝2頁目（53〜104行。同じ欄は +52行）
  check("台帳: 1日目の頁に塗装工事3・植栽工事（空き行）4・警備員1、2日目の頁に塗装工事2・鳶工事4・植栽工事2", lg.O33 === "3" && lg.M26 === "植栽工事" && lg.O26 === "4" && lg.O49 === "1" && lg.O85 === "2" && lg.O59 === "4" && lg.O78 === "2" && lg.M78 === "植栽工事", JSON.stringify({ O33: lg.O33, O26: lg.O26, O85: lg.O85, O59: lg.O59, O78: lg.O78 }));
  check("台帳: 累計・計・延労働時間は様式の数式で計算される（2日目の塗装累計5・植栽累計6）", lg.P85 === "5" && lg.P78 === "6" && Number(lg.O103) === todayTotal && Number(lg.O104) === todayTotal * 8, JSON.stringify({ P85: lg.P85, P78: lg.P78, O103: lg.O103, O104: lg.O104 }));
  check("台帳: 2日目の頁に資材・機材搬入・重点指示・連絡調整", lg.A89?.startsWith("07:30 搬入 鋼管") && lg.A93 === "開口部の養生確認を徹底" && lg.A99 === "午後は塗装と足場解体が同じ区画");
  const lhtml = await page.evaluate(async (sid) => (await (await import("/js/reportPrint.js")).buildSiteLedgerPrintHtml(sid)).html, ids.siteId);
  check("台帳の印刷: 縦書きのセルに縦書きの指定が入る", /writing-mode:vertical-rl/.test(lhtml) && lhtml.includes('<span class="tx">管理</span>'));

  // ---- ダッシュボード（2日目）----
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-09-02"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(600);
  const rows = await page.$$eval("#siteDashboard .dash-vendors tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|")));
  check("人工 ケース1: 業者別稼働状況の人工＝稼働人数（1人＝1人工）。塗装2人→2・足場4人→4（請求人工3.5は使わない）・累計人工＝累計の稼働人数", rows[0] === "サンプル塗装|塗装|2人|08:00～17:009時間|2|5" && rows[1] === "サンプル足場|とび|4人|08:00～12:004時間|4|4" && rows[2] === "サンプル緑化|植栽工事|2人|-|2|6", rows.join(" / "));
  const heads = await page.$$eval("#siteDashboard .dash-vendors thead th", (ths) => ths.map((t) => t.textContent.trim()));
  const dashText0 = await page.textContent("#siteDashboard");
  check("人工 ケース8: ダッシュボードは稼働人数・作業時間・人工を表示し、請求人工は表示しない", heads.join() === "業者,工種,稼働人数,作業時間,人工,累計人工" && !dashText0.includes("請求") && !dashText0.includes("3.5"), heads.join());
  const foot = await page.$eval("#siteDashboard .dash-vendors tfoot tr", (tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|"));
  check("ダッシュボード 業者別稼働状況の合計: 稼働人数8人・人工8", foot === "合計（3社・3工種）|8人||8|", foot);
  const dash = (await page.textContent("#siteDashboard")).replace(/\s+/g, " ");
  check("ダッシュボード: 本日の重点指示・作業間の連絡・調整・資材搬入・巡回点検・累計（社員を含む）", dash.includes("開口部の養生確認を徹底") && dash.includes("時間をずらす") && dash.includes("鋼管") && dash.includes("巡回点検") && dash.includes(`累計（社員を含む）${cumTotal}人`), (dash.match(/累計（社員を含む）\d+人/) || [""])[0]);

  // ---- 人工 ケース4・5: 請求人工を変えても、稼働人数・人工・03-2は変わらない ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${d2.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.locator(".company-row").nth(1).locator(".billingManDays").fill("2");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const d2b = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)), d2.id);
  await page.fill("#siteDashboard .dash-date-input", "2026-09-02"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(600);
  const rowsB = await page.$$eval("#siteDashboard .dash-vendors tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|")));
  check("人工 ケース4: 請求人工を3.5→2に変更しても稼働人数（4人）・人工（4）は変わらない", d2b.companies[1].billingManDays === "2" && d2b.companies[1].actualWorkerCount === "4" && rowsB[1] === rows[1], rowsB[1]);
  const [dlB] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), d2.id)]);
  const xfB = path.join(dir, "d2b.xlsx"); await dlB.saveAs(xfB); const xB = (await readXlsx(xfB)).cells;
  check("人工 ケース5: 請求人工・人工を変えても03-2の人数は変わらない（変更前と全セルが同じ・鳶工事4）", JSON.stringify(xB) === JSON.stringify(x) && xB.O7 === "4");
  // 以前の版で「人工（請求用）」として保存した manDays は請求人工として読み、ダッシュボード・03-2には使わない
  const legacyId = await page.evaluate(async (sid) => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const r = stampNew({ siteId: sid, date: "2026-09-03", companies: [{ companyId: "z", companyName: "サンプル内装", occupation: "内装", actualWorkerCount: "3", manDays: "1.5" }] });
    await dbPut("reports", r); return r.id;
  }, ids.siteId);
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${legacyId}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const legacyBilling = await page.inputValue(".company-row .billingManDays");
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-09-03"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(600);
  const rowL = await page.$$eval("#siteDashboard .dash-vendors tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, "")).join("|")));
  const legacyRec = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).companies[0], legacyId);
  check("以前の版の「人工（請求用）」1.5: 請求人工欄に1.5と表示・ダッシュボードの人工は稼働人数の3・保存データは書き換えない", legacyBilling === "1.5" && rowL[0]?.startsWith("サンプル内装|内装|3人|-|3|") && legacyRec.manDays === "1.5" && legacyRec.billingManDays === undefined, `${legacyBilling} / ${rowL[0]}`);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
