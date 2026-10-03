// 請求人工の月次管理（現場×業者×月）を確かめる（架空データ・Chromium）。
//   ・月間請求人工＝その月の日報の業者ごとの請求人工の合計（業者名ごと。工種が違っても1社）。月をまたいで足さない・未来の日付は入れない
//   ・日報カレンダーの月を切り替えると請求の一覧もその月に切り替わる（前の月の合計・請求状況は残る）
//   ・請求状況（未確認／請求あり／請求なし）は別に保存（請求人工が入っていても自動で請求ありにしない・請求なしでも0にしない）
//   ・請求あり・請求人工未入力は確認事項に出す。稼働人数・人工を変えても請求人工は変わらない。03-2・A3は変わらない
//   ・バックアップ・復元で請求状況・月間合計が保たれる
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-monthly-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 8月（例の「10月」）・9月（例の「11月」）・10月（今月。10/5 は未来の日付）
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const ids = await page.evaluate(async (today) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "月次管理の確認現場", startDate: "2026-08-01", endDate: "2026-12-31" });
    const row = (id, name, trade, n, billing) => ({ companyId: id, companyName: name, occupation: trade, actualWorkerCount: String(n), workHours: "08:00～17:00", billingManDays: billing });
    const mk = (date, companies) => stampNew({ siteId: site.id, date, dayStatus: "work", companies });
    const plusDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const list = [
      mk("2026-08-01", [row("a1", "ナダカ工業", "塗装", 3, "2.0"), row("k1", "協栄工業", "足場", 3, "")]),
      mk("2026-08-05", [row("a2", "ナダカ工業", "外壁下地補修", 3, "3.5"), row("a3", "ナダカ工業", "防水", 1, "1.0")]),
      mk("2026-08-10", [row("a4", "ナダカ工業", "塗装", 4, "4.0"), row("n1", "野本建装工業", "塗装", 3, "3.0")]),
      mk("2026-08-20", [row("a5", "ナダカ工業", "塗装", 5, "5.0")]),
      mk("2026-08-31", [row("a6", "ナダカ工業", "塗装", 3, "3.0")]),
      mk("2026-09-01", [row("a7", "ナダカ工業", "塗装", 2, "2.0")]),
      mk("2026-09-05", [row("a8", "ナダカ工業", "塗装", 3, "3.0"), row("s1", "西原建設", "足場", 2, "")]),
      mk(`${today.slice(0, 7)}-01`, [row("a9", "ナダカ工業", "塗装", 2, "1.5")]),
      mk(plusDays(today, 2), [row("a10", "ナダカ工業", "塗装", 9, "9.0")]) // 未来の日付（今月なら合計に入れない）
    ];
    for (const r of list) await dbPut("reports", r);
    return { siteId: site.id, aug10: list[2].id, aug1: list[0].id };
  }, today);
  const reportsBefore = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id))));

  const openSite = async () => {
    // 同じアドレスへの移動では画面が作り直されないので、いったん現場一覧を開いてから現場を開く
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  };
  const goMonth = async (month) => {
    for (let i = 0; i < 24; i++) {
      const cur = await page.$eval("#reportCalendar .billing-monthly", (s) => s.dataset.billingMonth);
      if (cur === month) return;
      await page.click(`#reportCalendar .cal-nav[data-shift='${cur > month ? -1 : 1}']`); await page.waitForTimeout(200);
    }
  };
  const billing = () => page.evaluate(() => {
    const sec = document.querySelector("#reportCalendar .billing-monthly");
    return {
      month: sec.dataset.billingMonth,
      title: sec.querySelector("h4").textContent,
      summary: sec.querySelector(".billing-summary").textContent.replace(/\s+/g, " "),
      rows: Object.fromEntries([...sec.querySelectorAll("tr[data-billing-row]")].map((tr) => [tr.dataset.billingRow, { manDays: tr.cells[1].childNodes[0].textContent.trim(), status: tr.querySelector("select").value, last: tr.cells[3].textContent.trim(), warn: tr.textContent.includes("請求あり・請求人工未入力") }])),
      close: sec.querySelector(".billing-close-status").value
    };
  });
  const setStatus = async (vendor, status) => {
    await page.selectOption(`#reportCalendar .billing-status[data-billing-vendor="${vendor}"]`, status);
    await page.waitForFunction(({ vendor, status }) => document.querySelector(`#reportCalendar .billing-status[data-billing-vendor="${vendor}"]`)?.value === status, { vendor, status });
    await page.waitForTimeout(300);
  };

  // ---- 1〜2・9〜11 8月（例の「10月」）----
  await openSite(); await goMonth("2026-08");
  const aug = await billing();
  check("1・2 8月の月間請求人工: ナダカ工業 2.0+3.5+1.0+4.0+5.0+3.0＝18.5・最終入力日 8/31", aug.rows["ナダカ工業"]?.manDays === "18.5" && aug.rows["ナダカ工業"].last === "8/31", JSON.stringify(aug.rows));
  check("9・11 複数業者（ナダカ工業・野本建装工業・協栄工業）。ナダカ工業は3工種でも1社として合計", Object.keys(aug.rows).join() === ["協栄工業", "ナダカ工業", "野本建装工業"].sort((a, b) => a.localeCompare(b, "ja")).join() && aug.rows["野本建装工業"].manDays === "3");
  check("10・請求人工未入力: 協栄工業は「未入力」（稼働人数から計算しない）", aug.rows["協栄工業"].manDays === "未入力");
  check("13 請求状況の初期値は全業者「未確認」（日報に出た＝請求ありとしない）", Object.values(aug.rows).every((r) => r.status === "unconfirmed") && aug.summary.includes("請求あり 0社・未確認 3社・請求なし 0社"));
  await setStatus("ナダカ工業", "billed"); await setStatus("野本建装工業", "none"); await setStatus("協栄工業", "billed");
  await page.selectOption("#reportCalendar .billing-close-status", "closed"); await page.waitForTimeout(400);
  const aug2 = await billing();
  check("14・15 請求あり（ナダカ工業）・請求なし（野本建装工業）を保存。請求なしでも請求人工は3.0のまま（0にしない）", aug2.rows["ナダカ工業"].status === "billed" && aug2.rows["野本建装工業"].status === "none" && aug2.rows["野本建装工業"].manDays === "3" && aug2.summary.includes("請求あり 2社・未確認 0社・請求なし 1社"));
  check("16 請求あり＋請求人工未入力（協栄工業）は「請求あり・請求人工未入力」と表示", aug2.rows["協栄工業"].warn && aug2.summary.includes("請求あり・請求人工未入力 1社"));
  check("月の締め（締め済み）を保存", aug2.close === "closed");

  // ---- 3〜6・12 9月（例の「11月」）へ切り替え ----
  await goMonth("2026-09");
  const sep = await billing();
  check("3・4 カレンダーを9月に切り替えると請求の一覧も9月（8月の18.5を引き継がない・請求状況は未確認から）", sep.title.includes("2026年9月") && sep.rows["ナダカ工業"].manDays === "5" && Object.values(sep.rows).every((r) => r.status === "unconfirmed") && sep.close === "open", JSON.stringify(sep.rows));
  check("12 月をまたぐ同じ業者: 8/31の3.0は8月、9/1の2.0は9月（5.0にしない）・9月は 2.0+3.0＝5.0", aug.rows["ナダカ工業"].manDays === "18.5" && sep.rows["ナダカ工業"].manDays === "5");
  await setStatus("ナダカ工業", "billed");
  const sep2 = await billing();
  check("5・6 9月の請求状況を保存（ナダカ工業 請求あり・西原建設は未確認・請求人工未入力）", sep2.rows["ナダカ工業"].status === "billed" && sep2.rows["西原建設"].status === "unconfirmed" && sep2.rows["西原建設"].manDays === "未入力");

  // ---- 7・8・21 8月へ戻る ----
  await goMonth("2026-08");
  const aug3 = await billing();
  check("7・8・21 8月へ戻ると8月の合計（18.5）・請求状況・締めがそのまま", aug3.rows["ナダカ工業"].manDays === "18.5" && aug3.rows["ナダカ工業"].status === "billed" && aug3.rows["野本建装工業"].status === "none" && aug3.close === "closed");

  // ---- 今月: 未来の日付は入れない ----
  await goMonth(today.slice(0, 7));
  const cur = await billing();
  check("今月の途中: 今日より後の日報（9.0）は合計に入れない（1日の1.5だけ）", cur.rows["ナダカ工業"].manDays === "1.5", JSON.stringify(cur.rows));

  // ---- ダッシュボードの「今月の請求状況」・確認事項（表示日 8/31）----
  await page.fill("#siteDashboard .dash-date-input", "2026-08-31"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  const dash = await page.evaluate(() => ({ card: document.querySelector("#siteDashboard .dash-billing-card")?.textContent.replace(/\s+/g, " ") || "", att: [...document.querySelectorAll("#siteDashboard .dash-attention li")].map((l) => l.textContent.replace(/\s+/g, " ")), board: document.querySelector("#siteDashboard [data-panel=board]").textContent }));
  check("ダッシュボード: 今月の請求状況（8月）請求あり2社・未確認0社・請求なし1社・月間請求人工 21.5・締め済み", dash.card.includes("8月") && /請求あり\s*2社/.test(dash.card) && /未確認\s*0社/.test(dash.card) && /請求なし\s*1社/.test(dash.card) && dash.card.includes("21.5") && dash.card.includes("締め済み"), dash.card);
  check("16 確認事項に「請求 請求あり・請求人工未入力 1社（協栄工業）」", dash.att.some((a) => a === "請求 請求あり・請求人工未入力 1社（協栄工業）"), dash.att.join(" / "));
  check("19（A3） 現場掲示（画面）には請求の情報を出さない", !dash.board.includes("請求"));
  await page.click("#siteDashboard [data-action=billing]"); await page.waitForTimeout(500);
  check("「詳細を見る」でカレンダーと請求人工（月次）が8月になる", (await page.$eval("#reportCalendar .billing-monthly", (s) => s.dataset.billingMonth)) === "2026-08");

  // ---- 17〜20 データの整合 ----
  const sheetOf = async (id, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (rid) => (await import("/js/reportPrint.js")).exportReportExcel(rid), id)]);
    const f = path.join(dir, name); await dl.saveAs(f);
    return page.evaluate(async (b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer); const s = (await pkg.listSheets())[0];
      const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
      const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
      return JSON.stringify([...L.cells].filter(([, c]) => c.text).map(([r, c]) => [r, c.text]));
    }, fs.readFileSync(f).toString("base64"));
  };
  const a3Of = (date) => page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((r) => r.siteId === sid), signatures: [], date, kySubmissions: [] })).replace(/<span class="ver">[^<]*<\/span>/, "");
  }, { sid: ids.siteId, date });
  // 稼働人数を変える（請求人工は変わらない）
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].actualWorkerCount = "7"; await dbPut("reports", r); }, ids.aug1);
  await openSite(); await goMonth("2026-08");
  check("17・18 稼働人数（＝人工）を変えても請求人工の合計は変わらない（18.5）", (await billing()).rows["ナダカ工業"].manDays === "18.5");
  // 請求人工を変える（03-2・A3は変わらない）。比べる前の状態は稼働人数を変えた後で取る
  const x0 = await sheetOf(ids.aug10, "x0.xlsx"); const a30 = await a3Of("2026-08-10");
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); r.companies[0].billingManDays = "6.0"; await dbPut("reports", r); }, ids.aug10);
  await openSite(); await goMonth("2026-08");
  const fixed = await billing();
  check("過去の日報の請求人工を直すと、その月の合計に反映（4.0→6.0 で 20.5）", fixed.rows["ナダカ工業"].manDays === "20.5", JSON.stringify(fixed.rows));
  const x1 = await sheetOf(ids.aug10, "x1.xlsx"); const a31 = await a3Of("2026-08-10");
  check("19 請求人工を変えても03-2（1日分のExcel）は変わらない", x1 === x0);
  const diffAt = [...a31].findIndex((ch, i) => ch !== a30[i]);
  check("20 請求人工を変えてもA3は変わらない・A3に請求の情報は無い", a31 === a30 && !a31.includes("請求"), `長さ ${a30.length}/${a31.length} 請求=${a31.includes("請求")} ${diffAt >= 0 ? a30.slice(diffAt - 80, diffAt + 40) + " → " + a31.slice(diffAt - 80, diffAt + 40) : ""} ${(a31.match(/.{0,40}請求.{0,40}/) || [""])[0]}`);
  await goMonth("2026-09");
  check("21 8月の日報を直しても9月の合計は変わらない（5.0）", (await billing()).rows["ナダカ工業"].manDays === "5");

  // 請求状況の変更で日報は変わらない
  const reportsNow = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.date, r.companies.map((c) => [c.companyName, c.billingManDays])])));
  const expected = JSON.stringify(JSON.parse(reportsBefore).map((r) => [r.id, r.date, r.companies.map((c) => [c.companyName, r.id === ids.aug10 && c.companyId === "a4" ? "6.0" : c.billingManDays])]));
  check("請求状況・締めを変えても日報（請求人工）は変わらない（変えたのは試験で直した1件だけ）", reportsNow === expected);

  // ---- 22 バックアップ・復元 ----
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "billing-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 9, null, { timeout: 20000 });
  const restored = await p3.evaluate(async (sid) => {
    const { dbGetAll, dbGet } = await import("/js/db.js"); const { buildMonthlyBilling } = await import("/js/billing/billingMonthly.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((r) => r.siteId === sid);
    const pick = (m) => { const b = buildMonthlyBilling({ reports, site, month: m, today: "2026-12-31" }); return Object.fromEntries(b.rows.map((r) => [r.vendor, `${r.manDays}/${r.status}`]).concat([["close", b.closeStatus]])); };
    return { aug: pick("2026-08"), sep: pick("2026-09") };
  }, ids.siteId);
  check("22 バックアップ→復元で8月・9月の請求状況・締め・月間合計が保たれる", restored.aug["ナダカ工業"] === "20.5/billed" && restored.aug["野本建装工業"] === "3/none" && restored.aug["協栄工業"] === "null/billed" && restored.aug.close === "closed" && restored.sep["ナダカ工業"] === "5/billed" && restored.sep["西原建設"] === "null/unconfirmed", JSON.stringify(restored));
  await ctx2.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
