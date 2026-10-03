// 新規日報の巡回点検の初期値と、日の状態との組み合わせを確かめる（架空データ・Chromium）。
//   ・新規の通常作業は33項目すべて「良」（○）。現場作業なし・休工日・雨天作業不可日・事務作業日は33項目すべて空欄（未確認）
//   ・日の状態を変えると初期値の「良」だけが空欄⇔良に切り替わり、監督が選んだ値（不良など）はそのまま
//   ・空欄のまま保存した休工日・作業なし・事務作業日は「未実施（…）」＋03-2の斜線、通常作業は ○ ＋斜線なし
//   ・既存の日報は開いても保存し直しても巡回点検の値が変わらない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const ROWS = Array.from({ length: 33 }, (_, i) => 7 + i); // 03-2 の巡回点検の欄 L7〜L39

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-initial-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 既存の日報（○・×・－・空欄・是正指示が混ざったもの）を1件用意
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "巡回点検初期値の確認現場", startDate: "2026-09-01", endDate: "2026-09-30" });
    const old = stampNew({ siteId: site.id, date: "2026-09-20", dayStatus: "work", companies: [{ companyId: "x", companyName: "既存工業", occupation: "とび", actualWorkerCount: "2" }],
      patrolChecklist: { morningMeeting: "good", qualificationCheck: "good", warningSigns: "bad", helmetWear: "na" }, patrolComment: "標識を付け直すこと" });
    await dbPut("reports", old);
    return { siteId: site.id, old: old.id };
  });
  const oldBefore = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGet("reports", id))), ids.old);

  const values = () => page.$$eval("#patrolChecklistContainer .patrol-item-row select", (ss) => ss.map((s) => s.value));
  const newForm = async (date, dayStatus) => {
    await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${date}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
    if (dayStatus) await page.selectOption("#dayStatus", dayStatus);
  };
  const save = async (date) => {
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
    return page.evaluate(async ({ sid, date }) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === date), { sid: ids.siteId, date });
  };
  const nonEmpty = (pc) => Object.entries(pc || {}).filter(([, v]) => v);

  // ---- 1〜4 新規日報の初期値 ----
  const init = {};
  for (const [label, st, want] of [["通常作業", "work", "good"], ["休工日", "holiday", ""], ["作業なし", "nowork", ""], ["雨天作業不可日", "rain", ""], ["事務作業日", "office", ""]]) {
    await newForm("2026-09-25", st);
    const v = await values();
    const blankText = await page.$eval('#patrolChecklistContainer select option[value=""]', (o) => o.textContent);
    init[label] = v.length === 33 && v.every((x) => x === want) && blankText === (st === "work" ? "未確認" : "未実施");
  }
  check("1〜5 新規日報の巡回点検33項目: 通常作業はすべて「良」、休工日・作業なし・雨天作業不可日・事務作業日はすべて空欄で、選択欄は「未実施」と表示", Object.values(init).every(Boolean), JSON.stringify(init));
  // 日の状態を途中で変えても、監督が選んだ値は書き換えない
  await newForm("2026-09-25", "work");
  await page.selectOption('#patrolChecklistContainer .patrol-item-row[data-key="scaffoldBridge"] select', "bad");
  await page.selectOption("#dayStatus", "holiday");
  const toHoliday = await values();
  await page.selectOption("#dayStatus", "work");
  const backWork = await values();
  const iBad = await page.$$eval("#patrolChecklistContainer .patrol-item-row", (rs) => rs.findIndex((r) => r.dataset.key === "scaffoldBridge"));
  check("8 通常作業で「不良」に変えてから休工日に変えると、初期値の「良」だけ空欄になり「不良」は残る。通常作業に戻すと「良」に戻る", toHoliday[iBad] === "bad" && toHoliday.filter((x) => x === "").length === 32 && backWork[iBad] === "bad" && backWork.filter((x) => x === "good").length === 32, `休工日: 空欄${toHoliday.filter((x) => x === "").length}／通常作業: 良${backWork.filter((x) => x === "good").length}`);

  // ---- 11 不具合の再現ケース: 新規の事務作業日を何も選ばずに保存 ----
  await newForm("2026-09-02", "office");
  const office = await save("2026-09-02");
  check("11 新規の事務作業日を空欄のまま保存 → 巡回点検に ○ が保存されない（以前は33項目すべて○になっていた）", nonEmpty(office.patrolChecklist).length === 0, JSON.stringify(nonEmpty(office.patrolChecklist)).slice(0, 80));

  // ---- 5〜9 保存 ----
  await newForm("2026-09-03", "work");
  const blank = await save("2026-09-03");
  check("1 通常作業を初期値のまま保存 → 33項目すべて「良」で保存", nonEmpty(blank.patrolChecklist).length === 33 && Object.values(blank.patrolChecklist).every((v) => v === "good") && !blank.patrolComment);
  await newForm("2026-09-07", "work");
  await page.selectOption('#patrolChecklistContainer .patrol-item-row[data-key="morningMeeting"] select', "good");
  await page.selectOption('#patrolChecklistContainer .patrol-item-row[data-key="scaffoldBridge"] select', "bad");
  await page.selectOption('#patrolChecklistContainer .patrol-item-row[data-key="restArea"] select', "na");
  const part = await save("2026-09-07");
  const pe = nonEmpty(part.patrolChecklist);
  check("7 ×・－に変えて保存 → その項目は ×・－、他は「良」", pe.length === 33 && part.patrolChecklist.morningMeeting === "good" && part.patrolChecklist.scaffoldBridge === "bad" && part.patrolChecklist.restArea === "na" && pe.filter(([, v]) => v === "good").length === 31, JSON.stringify(pe.filter(([, v]) => v !== "good")));
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${part.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const rv = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#patrolChecklistContainer .patrol-item-row")].map((r) => [r.dataset.key, r.querySelector("select").value])));
  check("9 開き直すと同じ結果（×・－・他は「良」）", rv.morningMeeting === "good" && rv.scaffoldBridge === "bad" && rv.restArea === "na" && Object.values(rv).filter((v) => v === "good").length === 31);

  // ---- 10〜15 日の状態との組み合わせ（画面から作った日報で）----
  await newForm("2026-09-04", "holiday"); const hol = await save("2026-09-04");
  await newForm("2026-09-05", "nowork"); const now = await save("2026-09-05");
  await newForm("2026-09-06", "rain"); await page.fill("#rainCancelledWork", "外壁塗装"); const rain = await save("2026-09-06");
  await newForm("2026-09-08", "holiday");
  await page.selectOption('#patrolChecklistContainer .patrol-item-row[data-key="morningMeeting"] select', "good");
  const holRec = await save("2026-09-08");
  const status = await page.evaluate(async (list) => {
    const { patrolStatusOf } = await import("/js/patrolChecklist.js"); const { dbGet } = await import("/js/db.js");
    const out = {}; for (const [k, id] of list) out[k] = patrolStatusOf(await dbGet("reports", id)).label; return out;
  }, [["hol", hol.id], ["now", now.id], ["rain", rain.id], ["office", office.id], ["blank", blank.id], ["part", part.id], ["holRec", holRec.id]]);
  // A3（現場掲示）
  const a3 = async (date) => page.evaluate(async ({ sid, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const { dbGetAll, dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: (await dbGetAll("reports")).filter((x) => x.siteId === sid), signatures: [], date, kySubmissions: [] })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }, { sid: ids.siteId, date });
  // 03-2（1日分のExcel）の斜線の数
  const diag = async (id, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (rid) => (await import("/js/reportPrint.js")).exportReportExcel(rid), id)]);
    const f = path.join(dir, name); await dl.saveAs(f);
    return page.evaluate(async ({ b64, rows }) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer);
      const { parseSharedStrings, readSheetLayout, parseXlsxStyles } = await import("/js/report-output/xlsxSheetReader.js");
      const styles = parseXlsxStyles(await pkg.getText("xl/styles.xml")); const sh = (await pkg.listSheets())[0];
      const L = readSheetLayout(await pkg.getText(sh.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
      return { n: rows.filter((r) => { const c = L.cells.get(`L${r}`); return c && styles.resolveStyle(c.styleIndex).border.diagonalDown; }).length, l7: L.cells.get("L7")?.text || "", l14: L.cells.get("L14")?.text || "", all: [...L.cells.values()].map((c) => c.text || "").join("|") };
    }, { b64: fs.readFileSync(f).toString("base64"), rows: ROWS });
  };
  const xRain = await diag(rain.id, "rain.xlsx");
  const xHol = await diag(hol.id, "hol.xlsx"), xNow = await diag(now.id, "now.xlsx"), xOff = await diag(office.id, "office.xlsx"), xBlank = await diag(blank.id, "blank.xlsx"), xPart = await diag(part.id, "part.xlsx"), xHolRec = await diag(holRec.id, "holrec.xlsx");
  const aHol = await a3("2026-09-04"), aNow = await a3("2026-09-05"), aOff = await a3("2026-09-02"), aBlank = await a3("2026-09-03"), aPart = await a3("2026-09-07"), aHolRec = await a3("2026-09-08");
  check("10 休工日＋空欄 → 未実施（休工日）・A3にも表示・03-2は L7〜L39 斜線", status.hol === "未実施（休工日）" && aHol.includes("巡回点検： 未実施（休工日）") && xHol.n === 33 && !xHol.l7);
  check("11 作業なし＋空欄 → 未実施（現場作業なし）・A3にも表示・03-2斜線", status.now === "未実施（現場作業なし）" && aNow.includes("未実施（現場作業なし）") && xNow.n === 33);
  check("12 事務作業日＋空欄（画面で新規作成）→ 未実施（事務作業日）・A3にも表示・03-2斜線（不具合の再現ケースの修正後）", status.office === "未実施（事務作業日）" && aOff.includes("巡回点検： 未実施（事務作業日）") && xOff.n === 33 && !xOff.l7);
  check("13 通常作業＋初期値の「良」→ 実施・03-2は ○ で斜線なし", status.blank === "実施" && aBlank.includes("巡回点検： 実施") && xBlank.n === 0 && xBlank.l7 === "○");
  check("14 通常作業＋実際の ○・× → 実記録（×があるので要確認）・03-2に ○・× を書き斜線なし", status.part === "要確認" && aPart.includes("巡回点検・要確認") && xPart.n === 0 && xPart.l7 === "○" && xPart.l14 === "×");
  check("15 休工日＋実際の点検記録（○1項目）→ 記録を優先（実施）・03-2は斜線なしで ○", status.holRec === "実施" && aHolRec.includes("巡回点検： 実施") && xHolRec.n === 0 && xHolRec.l7 === "○");

  check("4・13 雨天作業不可日＋空欄（画面で新規作成）→ 未実施（雨天作業不可日）・03-2斜線", status.rain === "未実施（雨天作業不可日）" && xRain.n === 33 && !xRain.l7);
  check("15 Excel（03-2）に「未実施」「未確認」の文字が出ない（作業しない日4種・通常作業）", [xHol, xNow, xOff, xRain, xBlank].every((x) => !x.all.includes("未実施") && !x.all.includes("未確認")));
  const pdfHtml = async (id) => page.evaluate(async (rid) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(rid)).html, id);
  const grad = (h) => (h.match(/linear-gradient\(to top right/g) || []).length;
  const hBlank = await pdfHtml(blank.id), hHol = await pdfHtml(hol.id), hRain = await pdfHtml(rain.id), hOff = await pdfHtml(office.id), hNow = await pdfHtml(now.id);
  const circles = (h) => (h.replace(/<[^>]+>/g, " ").match(/○/g) || []).length;
  check("16 PDF（03-2・通常作業の初期値）→ 巡回点検は ○、斜線なし", grad(hBlank) === 0 && circles(hBlank) >= 33, `○${circles(hBlank)}`);
  check("17 PDF（03-2・現場作業なし・休工日・雨天作業不可日・事務作業日）→ 巡回点検の33セルが斜線", [hHol, hNow, hRain, hOff].every((h) => grad(h) === 33), [hHol, hNow, hRain, hOff].map(grad).join(","));
  check("18 PDFに「未実施」「未確認」の文字が出ない", [hBlank, hHol, hNow, hRain, hOff].every((h) => !h.includes("未実施") && !h.includes("未確認")));
  const att = await page.evaluate(async ({ sid, dates }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    const site = await dbGet("sites", sid); const reports = (await dbGetAll("reports")).filter((x) => x.siteId === sid);
    return dates.map((d) => { const m = buildDashboardModel({ site, reports, signatures: [], date: d, kySubmissions: [] }); return { d, warn: m.attention.filter((c) => c.label.includes("巡回点検")).length, bad: m.patrol?.bad || 0, label: m.patrolStatus.label }; });
  }, { sid: ids.siteId, dates: ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-02", "2026-09-10"] });
  check("6・9 「未実施」は不良・要確認に数えない（作業しない日4種は巡回点検の要確認0件・不良0）。日報なしの日は「記録なし」", att.slice(0, 4).every((a) => a.warn === 0 && a.bad === 0 && a.label.startsWith("未実施")) && att[4].label === "記録なし", JSON.stringify(att));

  // ---- 16・17 既存の日報 ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.old}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const ov = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#patrolChecklistContainer .patrol-item-row")].map((r) => [r.dataset.key, r.querySelector("select").value])));
  check("16 既存の日報を開くと保存済みの巡回点検（○2・×1・－1・他は空欄）のまま", ov.morningMeeting === "good" && ov.qualificationCheck === "good" && ov.warningSigns === "bad" && ov.helmetWear === "na" && Object.values(ov).filter(Boolean).length === 4);
  check("16 開いただけでは保存データは変わらない", (await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGet("reports", id))), ids.old)) === oldBefore);
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const resaved = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), ids.old);
  const o = JSON.parse(oldBefore);
  check("17 既存の日報を保存し直しても巡回点検の値（○・×・－・空欄）と是正指示は変わらない", Object.keys({ ...o.patrolChecklist, ...resaved.patrolChecklist }).every((k) => (o.patrolChecklist[k] || "") === (resaved.patrolChecklist[k] || "")) && resaved.patrolComment === o.patrolComment, JSON.stringify(nonEmpty(resaved.patrolChecklist)));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
