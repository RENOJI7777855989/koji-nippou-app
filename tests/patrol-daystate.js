// 巡回点検の状況（実施／要確認／未実施（休工日・現場作業なし・事務作業日）／未記入／記録なし）と、
// 03-2（1日分のExcel・PDF・台帳・台帳の印刷）の巡回点検の欄の斜線を確かめる（架空データ・Chromium）。
//   ・休工日・作業なし・事務作業日で点検記録が無い日 → 画面・A3は「未実施（…）」、03-2は L7〜L39 を斜線（文字は書かない）
//   ・実際の記録がある日 → 日の状態に関係なく記録を出し、斜線にしない
//   ・日報が無い日 → 「記録なし」、台帳のその頁は斜線にしない
//   ・×・是正指示は「巡回点検・要確認」、対応状況（未対応など）は出さない。データは書き換えない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const PATROL_ROWS = Array.from({ length: 33 }, (_, i) => 7 + i); // L7〜L39

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-daystate-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 9/1 全○ / 9/2 ×2＋是正指示 / 9/3 －と未記入 / 9/4 休工日（記録なし）/ 9/5 作業なし（記録なし）/ 9/6 事務作業日（記録なし）
  // 9/7 日報なし / 9/8 休工日だが記録あり（○） / 9/9 通常作業で記録なし
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { PATROL_CHECKLIST_ITEMS } = await import("/js/patrolChecklist.js");
    const all = (v) => Object.fromEntries(PATROL_CHECKLIST_ITEMS.map((i) => [i.key, v]));
    const site = await createSite({ name: "巡回点検確認現場", startDate: "2026-09-01", endDate: "2026-09-10" });
    const co = [{ companyId: "a", companyName: "サンプル工業", occupation: "とび", actualWorkerCount: "3", workHours: "08:00～17:00" }];
    const mk = (date, extra) => stampNew({ siteId: site.id, date, progressPercent: 10, companies: co, ...extra });
    const days = {
      d1: mk("2026-09-01", { dayStatus: "work", patrolChecklist: all("good") }),
      d2: mk("2026-09-02", { dayStatus: "work", patrolChecklist: { ...all("good"), scaffoldBridge: "bad", openingUsage: "bad" }, patrolComment: "足場の手すりを復旧すること" }),
      d3: mk("2026-09-03", { dayStatus: "work", patrolChecklist: { morningMeeting: "good", restArea: "na" } }),
      d4: mk("2026-09-04", { dayStatus: "holiday", companies: [] }),
      d5: mk("2026-09-05", { dayStatus: "nowork", companies: [] }),
      d6: mk("2026-09-06", { dayStatus: "office", companies: [] }),
      d8: mk("2026-09-08", { dayStatus: "holiday", companies: [], patrolChecklist: { morningMeeting: "good", helmetWear: "good" } }),
      d9: mk("2026-09-09", { dayStatus: "work" })
    };
    for (const r of Object.values(days)) await dbPut("reports", r);
    return { siteId: site.id, ...Object.fromEntries(Object.entries(days).map(([k, r]) => [k, r.id])) };
  });
  // 出力すると日報に出力日時・出力履歴が記録される（既存の仕様）ので、内容の項目だけを比べる
  const dumpReports = () => page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.date, r.dayStatus, r.patrolChecklist, r.patrolComment, r.companies])));
  const before = await dumpReports();

  // ---- 判定（純粋関数）----
  const st = await page.evaluate(async () => {
    const { patrolStatusOf, patrolSlashApplies } = await import("/js/patrolChecklist.js"); const { dbGetAll } = await import("/js/db.js");
    const rs = await dbGetAll("reports"); const by = (d) => rs.find((r) => r.date === d);
    const out = {};
    for (const d of ["01", "02", "03", "04", "05", "06", "07", "08", "09"]) { const r = by(`2026-09-${d}`); out[d] = { ...patrolStatusOf(r || null), slash: patrolSlashApplies(r || null) }; }
    return out;
  });
  check("判定: 全○→実施 / ×＋是正指示→要確認 / －と未記入→実施（記録あり）", st["01"].label === "実施" && st["02"].label === "要確認" && st["03"].label === "実施" && !st["01"].slash && !st["02"].slash && !st["03"].slash, JSON.stringify([st["01"], st["02"], st["03"]]));
  check("判定: 休工日・作業なし・事務作業日で記録なし → 未実施（休工日）・未実施（現場作業なし）・未実施（事務作業日）、斜線あり", st["04"].label === "未実施（休工日）" && st["05"].label === "未実施（現場作業なし）" && st["06"].label === "未実施（事務作業日）" && st["04"].slash && st["05"].slash && st["06"].slash);
  check("判定: 日報なし → 記録なし（未実施にしない・斜線にしない）", st["07"].label === "記録なし" && st["07"].state === "none" && !st["07"].slash);
  check("判定: 休工日でも実際の記録があれば記録を優先（実施・斜線なし）／通常作業で記録なし → 未記入（斜線なし）", st["08"].label === "実施" && !st["08"].slash && st["09"].label === "未記入" && !st["09"].slash);

  // ---- 画面（監督管理・現場掲示）と A3 ----
  const view = async (date) => {
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.fill("#siteDashboard .dash-date-input", date); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      manage: document.querySelector("#siteDashboard [data-panel=manage]").textContent.replace(/\s+/g, " "),
      board: document.querySelector("#siteDashboard [data-board-section=patrol]")?.textContent.replace(/\s+/g, " ") || "",
      att: [...document.querySelectorAll("#siteDashboard .dash-attention li")].map((l) => l.textContent.replace(/\s+/g, " "))
    }));
    const html = await page.evaluate(async ({ sid, date }) => {
      const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
      const { dbGetAll, dbGet } = await import("/js/db.js");
      return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((x) => x.siteId === sid), signatures: [], date, kySubmissions: [] }));
    }, { sid: ids.siteId, date });
    return { ...r, a3: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  };
  const v1 = await view("2026-09-01"), v2 = await view("2026-09-02"), v4 = await view("2026-09-04"), v5 = await view("2026-09-05"), v6 = await view("2026-09-06"), v7 = await view("2026-09-07"), v8 = await view("2026-09-08");
  check("11 通常作業・全○: 現場掲示・A3・監督管理に「巡回点検：実施」と件数（良好○ 33）", v1.board.includes("巡回点検：実施") && v1.board.includes("良好○ 33") && v1.a3.includes("巡回点検： 実施") && v1.a3.includes("良好○ 33") && v1.manage.includes("巡回点検：実施"), v1.board);
  check("12 ×＋是正指示: 現場掲示・A3に「巡回点検・要確認」と×の項目・是正指示、監督管理の要確認にも出る（未対応とは出さない）", v2.board.includes("巡回点検・要確認") && v2.board.includes("足場,桟橋") && v2.board.includes("足場の手すりを復旧すること") && v2.a3.includes("巡回点検・要確認") && v2.a3.includes("× 仮設設備：足場,桟橋") && v2.a3.includes("是正指示：足場の手すりを復旧すること") && v2.att.includes("巡回点検・要確認 × 2件・是正指示あり") && !(v2.board + v2.a3 + v2.manage).includes("未対応"));
  check("13〜15 休工日・作業なし・事務作業日（記録なし）: 現場掲示・A3・監督管理に「未実施（休工日／現場作業なし／事務作業日）」、件数は出さない", v4.board.includes("巡回点検：未実施（休工日）") && v4.a3.includes("巡回点検： 未実施（休工日）") && v5.a3.includes("未実施（現場作業なし）") && v6.a3.includes("未実施（事務作業日）") && v6.board.includes("未実施（事務作業日）") && v4.manage.includes("巡回点検：未実施（休工日）") && v6.manage.includes("巡回点検：未実施（事務作業日）") && !v4.a3.includes("良好○"), v4.board);
  check("16 日報なし: 現場掲示・A3は「巡回点検：記録なし」（未実施と出さない）", v7.board.includes("巡回点検：記録なし") && v7.a3.includes("巡回点検： 記録なし") && !v7.a3.includes("未実施") && !v7.board.includes("未実施"));
  check("休工日でも記録がある日（9/8）は記録を出す（実施・良好○ 2）", v8.a3.includes("巡回点検： 実施") && v8.a3.includes("良好○ 2"));

  // ---- 03-2 1日分のExcel ----
  const readSheet = (file) => page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer);
    const { parseSharedStrings, readSheetLayout, parseXlsxStyles } = await import("/js/report-output/xlsxSheetReader.js");
    const styles = parseXlsxStyles(await pkg.getText("xl/styles.xml")); const ss = parseSharedStrings(await pkg.getText("xl/sharedStrings.xml"));
    const out = [];
    for (const sh of await pkg.listSheets()) {
      const L = readSheetLayout(await pkg.getText(sh.path), ss);
      const cells = {}; for (const [ref, c] of L.cells) { const b = styles.resolveStyle(c.styleIndex).border; cells[ref] = { t: c.text, diag: !!b.diagonalDown, box: [b.top, b.bottom, b.left, b.right].filter(Boolean).length }; }
      out.push({ name: sh.name, cells, merges: (await pkg.getText(sh.path)).match(/<mergeCell /g)?.length || 0, all: Object.values(cells).map((c) => c.t).join("|") });
    }
    return out;
  }, fs.readFileSync(file).toString("base64"));
  const exportDay = async (reportId, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), reportId)]);
    const f = path.join(dir, name); await dl.saveAs(f); return (await readSheet(f))[0];
  };
  const x1 = await exportDay(ids.d1, "d1.xlsx"), x2 = await exportDay(ids.d2, "d2.xlsx"), x4 = await exportDay(ids.d4, "d4.xlsx"), x5 = await exportDay(ids.d5, "d5.xlsx"), x6 = await exportDay(ids.d6, "d6.xlsx"), x8 = await exportDay(ids.d8, "d8.xlsx");
  const diagRows = (x) => PATROL_ROWS.filter((r) => x.cells[`L${r}`]?.diag).length;
  check("13〜15 03-2 Excel: 休工日・作業なし・事務作業日（記録なし）は L7〜L39 の33セルすべて斜線で、文字（未実施など）は書かない", [x4, x5, x6].every((x) => diagRows(x) === 33 && PATROL_ROWS.every((r) => !x.cells[`L${r}`]?.t) && !x.all.includes("未実施")), [x4, x5, x6].map(diagRows).join(","));
  check("13 斜線は罫線を足すだけで、L列の元の罫線・結合の数は変わらない", PATROL_ROWS.every((r) => x4.cells[`L${r}`].box === x1.cells[`L${r}`].box) && x4.merges === x1.merges, `${x4.merges}/${x1.merges}`);
  check("11・12 通常作業（全○・×あり）は斜線なしで ○・× をそのまま書く（是正指示 F41）", diagRows(x1) === 0 && diagRows(x2) === 0 && x1.cells.L7.t === "○" && x2.cells.L14.t === "×" && x2.cells.F41?.t === "足場の手すりを復旧すること");
  check("休工日でも記録がある日（9/8）は斜線にせず ○ を書く", diagRows(x8) === 0 && x8.cells.L7.t === "○" && x8.cells.L10.t === "○");

  // ---- PDF（1日分の印刷用HTML）----
  const pdfHtml = async (id) => page.evaluate(async (rid) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(rid)).html, id);
  const h4 = await pdfHtml(ids.d4), h1 = await pdfHtml(ids.d1);
  const gradCount = (h) => (h.match(/linear-gradient\(to top right/g) || []).length;
  check("20 PDF（印刷用HTML）: 休工日は斜線のセルが33、通常作業は0。「未実施」の文字は無い", gradCount(h4) === 33 && gradCount(h1) === 0 && !h4.includes("未実施"), `${gradCount(h4)}/${gradCount(h1)}`);
  const p4 = await ctx.newPage(); await p4.setContent(h4); await p4.waitForTimeout(300);
  const pdf4 = Buffer.from(await p4.pdf({ preferCSSPageSize: true })).toString("latin1");
  await p4.screenshot({ path: path.join(process.env.TEST_OUT_DIR || dir, "patrol-slash-pdf.png"), fullPage: true }).catch(() => {});
  await p4.close();
  check("20 PDF: A3横・1ページ", (pdf4.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf4));

  // ---- 台帳 ----
  const [ld] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (sid) => (await import("/js/reportPrint.js")).exportSiteLedgerExcel(sid), ids.siteId)]);
  const lf = path.join(dir, "ledger.xlsx"); await ld.saveAs(lf);
  const lg = (await readSheet(lf))[0];
  const pageDiag = (dayIndex) => PATROL_ROWS.filter((r) => lg.cells[`L${r + 52 * dayIndex}`]?.diag).length;
  const perDay = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(pageDiag);
  check("台帳: 9/4・9/5・9/6 の頁だけ巡回点検の欄が斜線（33）。9/7（日報なし）・9/8（記録あり）・通常作業の頁は斜線なし", perDay.join(",") === "0,0,0,33,33,33,0,0,0", perDay.join(","));
  const lhtml = await page.evaluate(async (sid) => (await (await import("/js/reportPrint.js")).buildSiteLedgerPrintHtml(sid)).html, ids.siteId);
  // 台帳の印刷は書式ごとにクラスを作るので、斜線のクラスを使っているセルを数える
  const diagClasses = [...lhtml.matchAll(/td\.([\w-]+)\{[^}]*linear-gradient\(to top right/g)].map((m) => m[1]);
  const diagTds = diagClasses.reduce((n, c) => n + (lhtml.match(new RegExp(`<td class="${c}"`, "g")) || []).length, 0);
  check("台帳の印刷: 斜線のセルが 33×3 日分", diagTds === 99, `${diagTds}（クラス ${diagClasses.length}）`);

  // ---- 事務作業日の入力・カレンダー ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.d6}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const formDs = await page.evaluate(() => ({ v: document.getElementById("dayStatus").value, opts: [...document.querySelectorAll("#dayStatus option")].map((o) => o.textContent) }));
  check("日報の入力: 日の状態に「事務作業日」があり、保存済みの事務作業日が選ばれている", formDs.v === "office" && formDs.opts.join() === "通常作業,作業なし,事務作業日,休工日", formDs.opts.join());
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="2026-09-06"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  const cal = await page.evaluate(() => Object.fromEntries(["04", "05", "06", "07"].map((d) => [d, document.querySelector(`#reportCalendar .cal-cell[data-date="2026-09-${d}"]`)?.className.match(/cal-(?!cell)(\w+)/)?.[1]])));
  check("カレンダー: 9/4 休工日・9/5 作業なし・9/6 事務作業日・9/7 日報なし（別々の表示）", cal["04"] === "holiday" && cal["05"] === "nowork" && cal["06"] === "office" && cal["07"] === "none", JSON.stringify(cal));

  check("表示・出力の前後で日報（巡回点検の記録を含む）は変わらない（未実施などをDBに書かない）", (await dumpReports()) === before);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
