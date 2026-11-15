// 読み込めるもの・通信先の制限（CSP。2026-11-01。index.html の meta、js/printScripts.js）
//   ・index.html の指紋（SHA-256）が、印刷用HTMLの中のスクリプトの本文と一致する
//   ・実際に作った印刷用HTML（1日分・まとめて・台帳・現場掲示・アプリ独自のPDF）の中のスクリプトは、すべて許可されている
//   ・各画面の流れで CSP の違反が0件、縮小のスクリプトは実際に動く（Chromium・WebKit）
//   ・わざと差し込んだイベント属性（onerror）は CSP で止まる（対照）
//   架空データ・隔離したプロファイル・同梱の03-2。iPad の Safari 実機は未確認
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

async function run(browserType, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `csp-${label}-`));
  const ctx = await browserType.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  // すべての枠（印刷の srcdoc を含む）で CSP の違反を集める
  await ctx.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => { try { (top.__csp = top.__csp || []).push(`${e.violatedDirective} ${e.blockedURI || ""} ${String(e.sample || "").slice(0, 40)}`); } catch (_) {} });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const takeViolations = () => page.evaluate(() => { const v = window.__csp || []; window.__csp = []; return v; });

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const site = await createSite({ name: "CSPの試験", startDate: "2026-10-01", endDate: "2026-10-31" });
    const mk = (date) => createReport({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", companies: [{ companyId: "c1", companyName: "アオバ塗装工業", occupation: "塗装", actualWorkerCount: "2", workContent: "外壁塗装" }] });
    const a = await mk("2026-10-02"); const b = await mk("2026-10-03");
    return { site: site.id, a: a.id, b: b.id };
  });

  // 指紋と、実際の印刷用HTMLの中のスクリプト
  const hashes = await page.evaluate(async (ids) => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const allowed = [...meta.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
    const sha = async (s) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
    const { PRINT_SCRIPTS } = await import("/js/printScripts.js");
    const fromBodies = await Promise.all(PRINT_SCRIPTS.map(sha));
    const rp = await import("/js/reportPrint.js"); const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js").catch(() => ({}));
    const htmls = {
      "1日分（会社様式）": (await rp.buildReportPrintHtml(ids.a)).html,
      "まとめて印刷": (await rp.buildReportsPrintHtml([ids.a, ids.b], "まとめて")).html,
      "台帳の印刷": (await rp.buildSiteLedgerPrintHtml(ids.site)).html,
      "アプリ独自のPDF": (await generateReportOutput({ reportId: ids.a, format: "pdf", pdfVariant: "original" })).html
    };
    const out = {};
    for (const [k, html] of Object.entries(htmls)) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const scripts = [...doc.querySelectorAll("script")].filter((s) => !s.type || /javascript/.test(s.type));
      const hs = await Promise.all(scripts.map((s) => sha(s.textContent)));
      out[k] = { n: scripts.length, ok: hs.every((h) => allowed.includes(h)) };
    }
    return { allowed: allowed.length, bodiesMatch: fromBodies.every((h) => allowed.includes(h)) && fromBodies.length === allowed.length, out, meta };
  }, ids);
  check(`${label}: index.html の指紋は、印刷用HTMLのスクリプトの本文（4つ）と一致する`, hashes.bodiesMatch, `指紋${hashes.allowed}件`);
  for (const [k, v] of Object.entries(hashes.out)) check(`${label}: ${k}の印刷用HTMLの中のスクリプト（${v.n}件）はすべて許可されている`, v.n > 0 && v.ok);
  check(`${label}: CSP は 'unsafe-inline' のスクリプト・eval を許さず、外部の通信先は api.anthropic.com だけ（ほかは自分のサイトと端末の中の data:・blob:）`, !/script-src[^;]*unsafe-(inline|eval)/.test(hashes.meta) && /connect-src 'self' data: blob: https:\/\/api\.anthropic\.com;/.test(hashes.meta) && (hashes.meta.match(/https?:\/\/[^\s;']+/g) || []).every((u) => u === "https://api.anthropic.com") && /object-src 'none'/.test(hashes.meta));

  // 画面の流れ: 日報の工事日報PDF（ダイアログの枠で縮小が動く・1ページのPDF）・印刷・まとめて・台帳・現場掲示・PDF保存
  await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.a}`); await page.waitForSelector("#reportPdfBtn"); await page.waitForTimeout(500);
  await page.click("#reportPdfBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(1500);
  const fitRan = await page.evaluate(() => { const d = document.getElementById("reportPrintFrame").contentDocument; const w = d.querySelector(".xlsx-sheet-wrap"); return !!(w && w.style.width && d.querySelector(".xc")); });
  check(`${label}: 印刷・PDFの枠の中で、縮小のスクリプトが動く（紙面の幅が設定される）`, fitRan);
  // 対照: 枠にイベント属性を差し込んでも、CSP で動かない
  const injected = await page.evaluate(async () => { const d = document.getElementById("reportPrintFrame").contentDocument; window.__x = 0; const div = d.createElement("div"); div.innerHTML = '<img src="data:," onerror="top.__x=1">'; d.body.appendChild(div); await new Promise((r) => setTimeout(r, 600)); return window.__x; });
  const ctl = await takeViolations();
  check(`${label}: 対照: 印刷の枠に差し込んだイベント属性（onerror）は CSP で止まり、違反として報告される`, injected === 0 && ctl.some((v) => /script-src/.test(v)), JSON.stringify(ctl).slice(0, 120));
  await page.click("#reportOnePageBtn"); await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("reportPrintStatus").textContent), null, { timeout: 60000 });
  check(`${label}: 1ページのPDF（A3）を作れる`, (await page.textContent("#reportPrintStatus")).includes("作成しました"), (await page.textContent("#reportPrintStatus")).slice(0, 60));
  await page.click("#reportPrintCloseBtn");
  await page.click("#reportPrintBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(800); await page.click("#reportPrintCloseBtn");
  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(800);
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#bulkPdfBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(1000); await page.click("#reportPrintCloseBtn");
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#ledgerPrintBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open, null, { timeout: 60000 }); await page.waitForTimeout(1500);
  const ledgerFit = await page.evaluate(() => { const d = document.getElementById("reportPrintFrame").contentDocument; const w = d.querySelector(".ledger-page"); return !!(w && w.style.width); });
  check(`${label}: 台帳の印刷の枠でも、縮小のスクリプトが動く`, ledgerFit);
  await page.click("#reportPrintCloseBtn");
  await (await page.$('#siteDashboard button:has-text("現場掲示をA3印刷")')).click(); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(1000); await page.click("#reportPrintCloseBtn");
  const pdfBtn = await page.$('#siteDashboard button:has-text("PDF保存・共有")'); if (pdfBtn) { await pdfBtn.click(); await page.waitForTimeout(500); const make = await page.$("#boardPdfMakeBtn, #boardPdfDialog button:has-text(\"PDFを作成\")"); if (make) { await make.click(); await page.waitForTimeout(4000); } await page.keyboard.press("Escape"); }
  // 帳票出力画面・バックアップ管理・積算の一覧
  await page.goto(`${BASE}#/report-output?siteId=${ids.site}&reportId=${ids.a}`); await page.waitForSelector("#view-report-output:not([hidden])"); await page.waitForTimeout(500);
  await page.selectOption("#outputFormatSelect", "pdf"); await page.dispatchEvent("#outputFormatSelect", "change"); await page.click("#outputPreviewBtn"); await page.waitForTimeout(1500);
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#view-backup:not([hidden])"); await page.waitForTimeout(500);
  await page.goto(`${BASE}#/sites/${ids.site}/estimates`); await page.waitForTimeout(800);
  // pdf.js（ワーカー）で PDF を読む
  const pdfjsOk = await page.evaluate(async () => { try { const { readPdf } = await import("/js/estimate/pdfWorkbookReader.js"); const res = await fetch("/icons/icon-32.png"); return typeof readPdf === "function" && res.ok; } catch (e) { return e.message; } });
  const pdfRead = await page.evaluate(async () => {
    // 架空のPDF（文字入り）を作って pdf.js で読む: アプリの1ページのPDFは画像なので、ここでは最小のテキストPDFを手で作る
    const txt = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 50 Td (CSP test) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
    try { const { readPdf } = await import("/js/estimate/pdfWorkbookReader.js"); const wb = await readPdf(new TextEncoder().encode(txt).buffer); return wb.sheetNames.length; } catch (e) { return `エラー: ${e.message}`; }
  });
  check(`${label}: pdf.js（積算・業者見積のPDFの取込）が CSP の下でも動く`, pdfjsOk === true && pdfRead === 1, `${pdfjsOk} / ${pdfRead}`);
  const v = await takeViolations();
  check(`${label}: 画面の流れ（工事日報PDF・1ページのPDF・印刷・まとめて・台帳・現場掲示・PDF保存・帳票出力・バックアップ・積算・pdf.js）で CSP の違反は0件`, v.length === 0, JSON.stringify(v).slice(0, 300));
  check(`${label}: ページエラーが無い`, errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await run(chromium, "Chromium");
  await run(webkit, "WebKit");
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
