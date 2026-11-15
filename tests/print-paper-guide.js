// ブラウザの印刷を使う画面で、用紙・向きの案内（「印刷時は、用紙サイズをA3、印刷の向きを横に設定してください。」）を出す（2026-11-01）
//   案内は印刷用HTMLの用紙（@page）から作る（printSupport.js の paperGuideOf）。架空データ・隔離したプロファイル・同梱の03-2
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const A3 = "印刷時は、用紙サイズをA3、印刷の向きを横に設定してください。";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-guide-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const unit = await page.evaluate(async () => {
    const { paperGuideOf } = await import("/js/printSupport.js");
    const g = (css) => paperGuideOf(`<style>@page { size: ${css}; margin: 8mm; }</style>`)?.text || null;
    return { mm: g("420mm 297mm"), a3: g("A3 landscape"), a4: g("A4"), a4l: g("A4 landscape"), none: paperGuideOf("<p>x</p>") };
  });
  check("判定: 420mm×297mm・「A3 landscape」は A3 横の案内（指定の文言どおり）", unit.mm === "印刷時は、用紙サイズをA3、印刷の向きを横に設定してください。" && unit.a3 === unit.mm, JSON.stringify(unit));
  check("判定: A4 は縦、A4 landscape は横、用紙の指定が無ければ案内なし", unit.a4 === "印刷時は、用紙サイズをA4、印刷の向きを縦に設定してください。" && unit.a4l.includes("A4、印刷の向きを横") && unit.none === null, JSON.stringify(unit));

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const site = await createSite({ name: "印刷の案内の試験", startDate: "2026-10-01", endDate: "2026-10-31" });
    const mk = (date) => createReport({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", companies: [{ companyId: "c1", companyName: "アオバ塗装工業", occupation: "塗装", actualWorkerCount: "2", workContent: "外壁塗装" }] });
    const a = await mk("2026-10-02"); await mk("2026-10-03");
    return { site: site.id, report: a.id };
  });
  const dialogNote = async () => { await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(400); const r = { note: await page.textContent("#reportPrintNote"), toggle: (await page.isVisible("#reportPrintBrowserToggle")) ? await page.textContent("#reportPrintBrowserToggle") : "", open: await page.isVisible("#reportPrintOpenBtn") }; await page.click("#reportPrintCloseBtn"); return r; };

  // 日報画面: ［印刷］（ブラウザの印刷）と［工事日報PDFを出力］（アプリがPDFを作る）
  await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.report}`); await page.waitForSelector("#reportPrintBtn"); await page.waitForTimeout(400);
  await page.click("#reportPrintBtn"); const p1 = await dialogNote();
  check("日報の［印刷］: 印刷の前に A3 横の案内と、ブラウザの印刷画面で選ぶ（アプリからは設定できない）ことを表示", p1.note.includes(A3) && p1.note.includes("アプリからは設定できません") && p1.open, p1.note.slice(0, 200));
  check("日報の［印刷］: PDFが必要なときは［工事日報PDFを出力］を使うこと（PDFと印刷の違い）を表示", p1.note.includes("［工事日報PDFを出力］") && p1.note.includes("A3横・1ページのPDFをアプリが作ります"));
  await page.click("#reportPdfBtn"); const p2 = await dialogNote();
  check("日報の［工事日報PDFを出力］: アプリが PDF を作るので本文に用紙の案内は出さず、奥のブラウザの印刷のボタンに案内を付ける", !p2.note.includes(A3) && p2.toggle.includes(A3) && !p2.open, `${p2.note.slice(0, 80)} / ${p2.toggle}`);

  // 現場詳細: まとめて印刷・台帳の印刷・現場掲示の A3
  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#bulkPrintBtn"); const p3 = await dialogNote();
  check("まとめて印刷: A3 横の案内", p3.note.includes(A3), p3.note.slice(0, 120));
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#ledgerPrintBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open, null, { timeout: 60000 }); const p4 = await dialogNote();
  check("台帳を印刷・PDF（ブラウザの印刷）: A3 横の案内（以前は案内が無かった）・「帳票の設定に従います」の文は出さない", p4.note.includes(A3) && !p4.note.includes("従います"), p4.note.slice(0, 160));
  const boardBtn = await page.$('#siteDashboard button:has-text("現場掲示をA3印刷")');
  await boardBtn.click(); const p5 = await dialogNote();
  check("現場掲示をA3印刷: A3 横の案内", p5.note.includes(A3), p5.note.slice(0, 160));

  // 帳票出力画面: PDF／印刷のプレビュー → 案内
  await page.goto(`${BASE}#/report-output?siteId=${ids.site}&reportId=${ids.report}`); await page.waitForSelector("#view-report-output:not([hidden])"); await page.waitForTimeout(600);
  await page.selectOption("#outputFormatSelect", "pdf"); await page.dispatchEvent("#outputFormatSelect", "change");
  await page.click("#outputPreviewBtn"); await page.waitForSelector("#outputPrintBtn:not([hidden])", { timeout: 20000 });
  const g6 = await page.evaluate(() => { const el = document.getElementById("outputPrintGuide"); return el.hidden ? "" : el.textContent; });
  check("帳票出力画面の［印刷する］: 用紙・向きの案内（様式の用紙から）", g6.includes("印刷時は、用紙サイズを") && g6.includes("アプリからは設定できません"), g6);
  await page.selectOption("#outputFormatSelect", "excel"); await page.dispatchEvent("#outputFormatSelect", "change"); await page.click("#outputPreviewBtn"); await page.waitForTimeout(500);
  check("帳票出力画面: Excel のプレビューでは用紙の案内を隠す", await page.evaluate(() => document.getElementById("outputPrintGuide").hidden));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
