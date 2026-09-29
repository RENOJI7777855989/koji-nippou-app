// 印刷の「何も起きない」対策の検証（実ブラウザ・実IndexedDB・画面操作）
// ・印刷画面が開いた形跡が無いとき、必ず案内を出す（何も起きない状態にしない）
// ・印刷画面が開いたとき（print() が印刷画面を閉じるまで戻らない／beforeprint の合図）は案内を出さない
// ・「共有メニューから印刷」（共有できない環境では「印刷用ファイルを保存」）が常にある
// ・対象: 日報の印刷・PDF（03-2 会社様式）、A3「今日の現場シート」、帳票出力画面、見積比較
// ・データ（日報・署名・搬入・搬出・見積）と 03-2 の出力に影響しない
// 注意: 自動テストでは実際の印刷画面・共有メニューは出せないため、print()/share() の結果を再現して確かめる。
//       iPad 実機（特にホーム画面アプリ）で印刷できるかは、このテストでは確認できない。
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/print-fallback.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 枠（iframe）の print() を置き換える: "none"=何も起きない / "event"=印刷の合図だけ / "block"=印刷画面が開いて閉じるまで戻らない / "throw"=エラー
async function stubFramePrint(page, frameSelector, behavior) {
  await page.evaluate(({ sel, behavior }) => {
    const w = document.querySelector(sel).contentWindow;
    w.print = () => {
      if (behavior === "throw") throw new Error("print blocked");
      if (behavior === "event") { w.dispatchEvent(new Event("beforeprint")); w.dispatchEvent(new Event("afterprint")); }
      if (behavior === "block") { const t = Date.now(); while (Date.now() - t < 500) { /* 印刷画面が開いている間は戻らない */ } }
    };
  }, { sel: frameSelector, behavior });
}

async function runBrowser(name, browserType) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-fallback-"));
  const ctx = await browserType.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  const N = (t) => `${name}: ${t}`;

  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  // 03-2（同梱テンプレート）を登録（鍵がある環境のみ）
  const key = (() => { try { return require("./helpers/templateKey.js").loadKey(); } catch { return null; } })();
  if (key) {
    await page.goto(`${BASE}#setup=${key}`); await page.waitForSelector("#view-site-list:not([hidden])");
    await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  }
  // 現場と日誌（業者・署名・搬入・搬出・見積）を用意
  const ids = await page.evaluate(async (today) => {
    const { createSite } = await import("/js/sites.js");
    const { dbPut } = await import("/js/db.js");
    const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "印刷確認現場", startDate: today, clientName: "" });
    const report = stampNew({ siteId: site.id, date: today, weather: "晴れ",
      companies: [{ companyId: "c1", companyName: "印刷確認工業", occupation: "型枠工", actualWorkerCount: "3", workContent: "型枠建込" }],
      timeline: [{ id: "t1", time: "08:00", title: "朝礼", kind: "meeting", status: "done", note: "" }],
      deliveries: [{ id: "d1", direction: "in", time: "10:00", item: "鉄筋", status: "plan" }, { id: "d2", direction: "out", time: "15:00", item: "残土", status: "plan" }] });
    await dbPut("reports", report);
    const canvas = document.createElement("canvas"); canvas.width = 60; canvas.height = 30; canvas.getContext("2d").fillRect(5, 5, 40, 10);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await dbPut("signatures", stampNew({ reportId: report.id, companyId: "c1", role: "foreman", roleLabel: "職長", imageBlob: blob, signedAt: new Date().toISOString() }));
    await dbPut("estimateItems", stampNew({ siteId: site.id, estimateBatchId: "b1", category: "仮設", itemName: "足場", quantity: 10, unit: "m2", unitPrice: 1000, amount: 10000 }));
    return { siteId: site.id, reportId: report.id };
  }, local(new Date()));
  const snapshot = () => page.evaluate(async () => {
    const { dbGetAll } = await import("/js/db.js");
    const r = await dbGetAll("reports");
    return JSON.stringify({ reports: r.map((x) => [x.id, x.deliveries?.length, x.companies?.length, x.timeline?.length]), sig: (await dbGetAll("signatures")).map((s) => [s.id, s.imageBlob?.size]), est: (await dbGetAll("estimateItems")).length, vq: (await dbGetAll("vendorQuoteItems")).length, sites: (await dbGetAll("sites")).length });
  });
  const before = await snapshot();

  // ===== ① 工事日報を開き ② 印刷画面を開く =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.reportId}`); await page.waitForSelector("#view-report-form:not([hidden])");
  await page.evaluate(() => document.getElementById("reportPrintBtn").click());
  await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.childElementCount > 0);
  const frameText = await page.evaluate(() => document.getElementById("reportPrintFrame").contentDocument.body.textContent);
  check(N("③ 日報の印刷用内容がプレビューに表示される"), frameText.includes("印刷確認工業"));
  const fallback = await page.evaluate(() => ({ share: !document.getElementById("reportPrintShareBtn").hidden, save: !document.getElementById("reportPrintSaveBtn").hidden, text: document.querySelector("#reportPrintDialog .print-fallback-hint").textContent }));
  check(N("⑥ 「共有メニューから印刷」（共有できない環境では「印刷用ファイルを保存」）が常に表示される"), (fallback.share || fallback.save) && fallback.text.includes("印刷画面が開かない場合"), JSON.stringify({ share: fallback.share, save: fallback.save }));

  // ④⑤ 何も起きない場合 → 案内が出る
  await stubFramePrint(page, "#reportPrintFrame", "none");
  await page.click("#reportPrintOpenBtn");
  await page.waitForFunction(() => !document.getElementById("reportPrintStatus").hidden, null, { timeout: 5000 });
  const warn = await page.evaluate(() => ({ text: document.getElementById("reportPrintStatus").textContent, warn: document.getElementById("reportPrintStatus").classList.contains("is-warn"), record: !document.getElementById("reportPrintRecordArea").hidden }));
  check(N("⑤ 印刷画面が開いた形跡が無いとき、案内（開けなかった可能性・共有メニュー／ファイル保存から印刷）が出る"), warn.warn && warn.text.includes("印刷画面を開けなかった可能性があります") && (warn.text.includes("共有メニューから印刷") || warn.text.includes("印刷用ファイルを保存")), warn.text.slice(0, 60));
  check(N("④ 印刷操作に反応する（紙に印刷できたかの記録欄が出る）"), warn.record);
  // エラーで印刷できない場合も案内
  await stubFramePrint(page, "#reportPrintFrame", "throw");
  await page.click("#reportPrintOpenBtn");
  await page.waitForFunction(() => document.getElementById("reportPrintStatus").classList.contains("is-warn"));
  check(N("⑤ 印刷の命令がエラーになっても案内が出る（何も起きない状態にしない）"), true);
  // 印刷画面が開いた場合 → 案内は出ない
  for (const behavior of ["event", "block"]) {
    await stubFramePrint(page, "#reportPrintFrame", behavior);
    await page.click("#reportPrintOpenBtn");
    await page.waitForTimeout(1900);
    const st = await page.evaluate(() => ({ hidden: document.getElementById("reportPrintStatus").hidden, warn: document.getElementById("reportPrintStatus").classList.contains("is-warn") }));
    check(N(`② 印刷画面が開いたとき（${behavior === "event" ? "印刷の合図あり" : "閉じるまで戻らない"}）は「開けなかった」と出さない`), st.hidden && !st.warn, JSON.stringify(st));
  }

  // ⑥ 共有メニューから印刷／印刷用ファイルを保存
  if (fallback.share) {
    await page.evaluate(() => { window.__shared = null; navigator.share = async (data) => { window.__shared = { name: data.files[0].name, type: data.files[0].type, text: await data.files[0].text() }; }; });
    await page.click("#reportPrintShareBtn");
    await page.waitForFunction(() => window.__shared);
    const shared = await page.evaluate(() => ({ ...window.__shared, text: window.__shared.text.length, hasContent: window.__shared.text.includes("印刷確認工業"), status: document.getElementById("reportPrintStatus").textContent, record: !document.getElementById("reportPrintRecordArea").hidden }));
    check(N("⑥ 「共有メニューから印刷」で、印刷用ファイル（HTML・日報の内容入り）が共有メニューへ渡される"), shared.type === "text/html" && /\.html$/.test(shared.name) && shared.hasContent && shared.record, `${shared.name} ${shared.text}文字`);
    await page.evaluate(() => { navigator.share = async () => { throw new DOMException("cancel", "AbortError"); }; });
    await page.click("#reportPrintShareBtn"); await page.waitForTimeout(300);
    check(N("⑥ 共有をキャンセルしたとき、やり直せる案内が出る"), (await page.textContent("#reportPrintStatus")).includes("やり直せます"));
  } else {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#reportPrintSaveBtn")]);
    const f = path.join(dir, "print.html"); await dl.saveAs(f);
    check(N("⑥ 共有メニューが使えない環境では「印刷用ファイルを保存」で印刷用HTMLを保存できる"), /\.html$/.test(dl.suggestedFilename()) && fs.readFileSync(f, "utf8").includes("印刷確認工業"), dl.suggestedFilename());
  }
  await page.click("#reportPrintCloseBtn");

  // ===== 03-2（会社様式）の印刷用HTML: A3横のまま =====
  if (key) {
    await page.evaluate(() => document.getElementById("reportPdfBtn").click());
    await page.waitForSelector("#reportPrintDialog[open]");
    const html = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
    const size = /@page\s*\{\s*size:\s*([\d.]+)mm\s+([\d.]+)mm/.exec(html);
    check(N("⑦⑧ 03-2 の印刷用HTMLは従来どおり会社様式（A3横 420×297mm）"), size && Math.round(size[1]) === 420 && Math.round(size[2]) === 297 && html.includes("印刷確認工業"), size ? `${size[1]}×${size[2]}mm` : "用紙指定なし");
    await page.click("#reportPrintCloseBtn");
  }

  // ===== A3「今日の現場シート」 =====
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard [data-action=print]"); await page.waitForSelector("#reportPrintDialog[open]");
  const a3 = await page.evaluate(() => ({ html: document.getElementById("reportPrintFrame").srcdoc, fb: !document.getElementById("reportPrintShareBtn").hidden || !document.getElementById("reportPrintSaveBtn").hidden }));
  check(N("⑦ A3「今日の現場シート」も同じ印刷ダイアログ（A3横の指定・共有メニューの導線あり）"), /@page \{ size: A3 landscape/.test(a3.html) && a3.fb);
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.childElementCount > 0);
  await stubFramePrint(page, "#reportPrintFrame", "none");
  await page.click("#reportPrintOpenBtn");
  await page.waitForFunction(() => !document.getElementById("reportPrintStatus").hidden, null, { timeout: 5000 });
  check(N("⑤ A3シートでも、印刷画面が開かないときは案内が出る"), (await page.textContent("#reportPrintStatus")).includes("印刷画面を開けなかった可能性があります"));
  await page.click("#reportPrintCloseBtn");
  check(N("⑬ ダッシュボードが表示される（搬入・搬出）"), (await page.textContent("#siteDashboard")).includes("搬入1件・搬出1件"));

  // ===== 帳票出力画面の印刷ボタン =====
  await page.goto(`${BASE}#/report-output?siteId=${ids.siteId}&reportId=${ids.reportId}`); await page.waitForSelector("#view-report-output:not([hidden])");
  await page.waitForTimeout(500);
  await page.selectOption("#outputFormatSelect", "pdf");
  const outIds = await page.evaluate(() => ({ site: document.getElementById("outputSiteSelect")?.value, report: document.getElementById("outputReportSelect")?.value }));
  if (outIds.site && outIds.report) {
    await page.click("#outputPreviewBtn");
    await page.waitForSelector("#outputPrintBtn:not([hidden])");
    const shareShown = await page.isVisible("#outputPrintShareBtn");
    check(N("⑥ 帳票出力画面: 印刷ボタンの横に「共有メニューから印刷／印刷用ファイルを保存」がある"), shareShown, await page.textContent("#outputPrintShareBtn"));
    await page.waitForFunction(() => document.getElementById("outputPreviewFrame").contentDocument?.body?.childElementCount > 0);
    await stubFramePrint(page, "#outputPreviewFrame", "none");
    await page.click("#outputPrintBtn");
    await page.waitForFunction(() => document.body.textContent.includes("印刷画面を開けなかった可能性があります"), null, { timeout: 5000 });
    check(N("⑤ 帳票出力画面: 印刷画面が開かないときは案内が出る"), true);
  } else {
    check(N("帳票出力画面の選択欄が見つからない"), false, JSON.stringify(outIds));
  }

  // ===== 見積比較の印刷ボタン =====
  await page.evaluate(async (siteId) => {
    const { createVendorQuoteBatch } = await import("/js/vendorQuote/vendorQuoteBatches.js");
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const b = await createVendorQuoteBatch({ siteId, vendorName: "印刷確認業者", sourceFileName: "quote.csv", sourceFileType: "csv" });
    await dbPut("vendorQuoteItems", stampNew({ siteId, vendorQuoteBatchId: b.id, category: "仮設", itemName: "足場", quantity: 10, unit: "m2", unitPrice: 1100, amount: 11000 }));
  }, ids.siteId);
  const beforeCmp = await snapshot();
  await page.goto(`${BASE}#/sites/${ids.siteId}/vendor-quotes/compare`); await page.waitForSelector("#view-comparison:not([hidden])");
  await page.waitForTimeout(800);
  await page.click("#comparisonExportPdfBtn");
  await page.waitForSelector("#comparisonPrintBtn:not([hidden])");
  check(N("⑥ 見積比較: 印刷ボタンの横に「共有メニューから印刷／印刷用ファイルを保存」がある"), await page.isVisible("#comparisonPrintShareBtn"), await page.textContent("#comparisonPrintShareBtn"));
  await page.waitForFunction(() => document.getElementById("comparisonPdfPreviewFrame").contentDocument?.body?.childElementCount > 0);
  await stubFramePrint(page, "#comparisonPdfPreviewFrame", "none");
  await page.click("#comparisonPrintBtn");
  await page.waitForFunction(() => document.body.textContent.includes("印刷画面を開けなかった可能性があります"), null, { timeout: 5000 });
  check(N("⑤ 見積比較: 印刷画面が開かないときは案内が出る"), true);
  check(N("⑪ 見積比較の印刷操作で見積データが変わらない"), beforeCmp === (await snapshot()));

  // ===== データが残っている =====
  const after = await snapshot();
  const strip = (j) => { const o = JSON.parse(j); delete o.vq; return JSON.stringify(o); }; // 業者見積はこのテストで途中に追加している
  check(N("⑨⑩⑪⑫ 日報・署名・見積・搬入・搬出・流れのデータが印刷操作の前後で変わらない"), strip(before) === strip(after));
  check(N("コンソールエラー・ページエラーが無い"), errors.length === 0, errors.slice(0, 3).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await runBrowser("Chromium", chromium);
  await runBrowser("WebKit", webkit);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
