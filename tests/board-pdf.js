// 現場掲示の「📄 PDF保存・共有」（A3横・1ページのPDFを作って共有メニュー／保存）を確かめる（架空データ・Chromium＋WebKit）。
//   ・PDFは「🖨 現場掲示をA3印刷」と同じ印刷用HTMLから作る（PDFの画像と、印刷用HTMLを表示した画像を画素で比べる）
//   ・A3横・1ページ（同梱の pdf.js で開いて確認）。ファイル名 現場掲示_現場名_日付.pdf
//   ・日報を変えると（流れの追加・削除、搬入搬出の変更）PDFも変わる。請求人工は入らない
//   ・共有メニュー（Web Share）へPDFファイルを渡す／共有できない環境は保存（ダウンロード）
//   実際のiPadの共有メニュー・LINEでの送信は自動テストでは確認できない（navigator.share の呼び出しを記録して確かめる）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const T = "2026-09-15";

// 共有メニューの代わり: navigator.share に渡されたファイルを記録する
const SHARE_STUB = () => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length && d.files.every((f) => f instanceof File);
  navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); window.__shared.push({ name: f.name, type: f.type, size: f.size, title: d.title, b64: btoa(s) }); };
};

const seed = async (page) => page.evaluate(async (date) => {
  const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js"); const { defaultWorkdayTimeline } = await import("/js/dashboard/dailyFlow.js");
  const site = await createSite({ name: "PDF共有の確認現場", startDate: "2026-09-01", endDate: "2026-12-20", constructionNumber: "K-777" });
  const r = stampNew({ siteId: site.id, date, dayStatus: "work", weather: "曇り", temperature: "21", progressPercent: 55, siteSupervisorNames: [],
    timeline: defaultWorkdayTimeline().map((x, i) => ({ ...x, id: "t" + i })),
    companies: [
      { companyId: "a", companyName: "ナダカ工業", occupation: "外壁塗装", plannedWorkerCount: "4", actualWorkerCount: "4", workHours: "08:00～17:00", workContent: "外壁中塗り", safetyNotes: "足場上の墜落注意", foremanName: "山田", billingManDays: "9.5" },
      { companyId: "b", companyName: "協栄工業", occupation: "足場", plannedWorkerCount: "2", actualWorkerCount: "2", workHours: "08:30～16:30", workContent: "足場盛替え", safetyNotes: "資材の落下注意", foremanName: "佐藤", billingManDays: "7.25" }],
    deliveries: [{ id: "d1", direction: "in", time: "09:00", item: "塗料", quantity: "12缶", vendor: "サンプル商事", status: "plan" }, { id: "d2", direction: "out", time: "15:30", item: "空缶", quantity: "1式", vendor: "サンプル運送", status: "plan" }],
    remarks: "連絡テスト：午後から車両通行止め", tomorrowPlan: "上塗り", patrolChecklist: { morningMeeting: "good" } });
  await dbPut("reports", r);
  return { siteId: site.id, reportId: r.id };
}, T);

const openBoard = async (page, ids) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, T);
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, T); await page.waitForTimeout(300);
};
// 「🖨 現場掲示をA3印刷」で印刷画面に渡るHTML
const printHtml = async (page) => {
  await page.click('#siteDashboard [data-action="print"]');
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const html = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
  await page.click("#reportPrintCloseBtn");
  return html;
};
// 「📄 PDF保存・共有」→ 作成 →［共有］で渡されたPDF
const makeAndShare = async (page) => {
  await page.click('#siteDashboard [data-action="pdf"]');
  await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 30000 });
  const ui = await page.evaluate(() => ({ status: document.getElementById("boardPdfStatus").textContent, shareShown: !document.getElementById("boardPdfShareBtn").hidden, preview: !document.getElementById("boardPdfPreview").hidden && document.getElementById("boardPdfPreview").naturalWidth }));
  const n = await page.evaluate(() => window.__shared.length);
  if (ui.shareShown) { await page.click("#boardPdfShareBtn"); await page.waitForFunction((k) => window.__shared.length > k, n); }
  const shared = await page.evaluate(() => window.__shared[window.__shared.length - 1] || null);
  await page.click("#boardPdfCloseBtn");
  return { ui, shared, pdf: shared ? Buffer.from(shared.b64, "base64") : null };
};
const jpegOf = (pdf) => { const s = pdf.toString("latin1"); const i = s.indexOf("stream\n", s.indexOf("/DCTDecode")) + 7; const j = s.indexOf("\nendstream", i); return pdf.subarray(i, j); };
// PDFを pdf.js で開く（ページ数・用紙の大きさ）
const pdfInfo = (page, pdf) => page.evaluate(async (b64) => {
  const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ data: u }).promise; const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
  return { pages: doc.numPages, w: Math.round(vp.width), h: Math.round(vp.height) };
}, pdf.toString("base64"));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-pdf-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(SHARE_STUB);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);

  // 印刷用HTMLを表示した紙面の画像（PDFの画像と比べる）。PDFの画像を同じ大きさに縮めて、画素の差の平均（0〜255）を求める
  // PDFの画像と同じ倍率（2.5倍）で撮る
  const shotBrowser = await chromium.launch(); const shotDefault = await shotBrowser.newPage({ deviceScaleFactor: 2.5 });
  // 比較用の画面だけ、紙面を左上（0,0）にそろえて撮る（中央寄せだと半画素ずれて文字の輪郭の差が出るため。アプリの表示は変えない）
  const sheetPng = async (html, shot = shotDefault) => {
    await shot.setViewportSize({ width: 1700, height: 1300 }); await shot.setContent(html);
    await shot.addStyleTag({ content: "html,body{margin:0!important;padding:0!important}.sheet{margin:0!important;box-shadow:none!important}" });
    await shot.waitForTimeout(400);
    const r = await shot.$eval(".sheet", (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; });
    return shot.screenshot({ clip: { x: 0, y: 0, width: r.w, height: r.h } });
  };
  const diff = (imgA, imgB) => page.evaluate(async ([a, b]) => {
    const load = async (b64) => { const img = new Image(); img.src = `data:${b64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${b64}`; await img.decode(); return img; };
    const A = await load(a), B = await load(b);
    // 400px幅に縮めて（数画素の位置のずれをならす）、20×14の区画ごとの画素の差の平均を求め、いちばん大きい区画の値を返す（一部の欄が違えば大きくなる）
    const w = 400, h = Math.round(1200 * B.naturalHeight / B.naturalWidth);
    const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
    const p = px(A), q = px(B); const GX = 20, GY = 14; const sum = new Float64Array(GX * GY), cnt = new Float64Array(GX * GY);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const k = Math.min(GY - 1, Math.floor(y * GY / h)) * GX + Math.min(GX - 1, Math.floor(x * GX / w)); sum[k] += (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3; cnt[k]++; }
    let max = 0, all = 0; for (let k = 0; k < sum.length; k++) { max = Math.max(max, sum[k] / cnt[k]); all += sum[k]; }
    return { mean: +(all / (w * h)).toFixed(2), max: +max.toFixed(2) };
  }, [Buffer.from(imgA).toString("base64"), Buffer.from(imgB).toString("base64")]);
  // アプリと同じ処理（board-pdf.js）で、印刷用HTMLから画像を作る
  const renderJpeg = async (html) => Buffer.from(await page.evaluate(async (h) => { const { renderSheetHtmlToJpeg } = await import("/js/ui/board-pdf.js"); const { jpeg } = await renderSheetHtmlToJpeg(h); let s = ""; for (let i = 0; i < jpeg.length; i++) s += String.fromCharCode(jpeg[i]); return btoa(s); }, html), "base64");

  // ===== 1 PDF生成・A3横1ページ・ファイル名 =====
  await openBoard(page, ids);
  const btns = await page.$$eval("#siteDashboard .dash-actions button", (bs) => bs.map((b) => b.textContent.trim()));
  check("「🖨 現場掲示をA3印刷」はそのまま、その隣に「📄 PDF保存・共有」", btns.includes("🖨 現場掲示をA3印刷") && btns.includes("📄 PDF保存・共有"), btns.join(" / "));
  const html1 = await printHtml(page);
  const r1 = await makeAndShare(page);
  check("PDFを作成し、見本（PDFの画像）を表示・［共有］ボタンが出る", r1.ui.status.includes("作成しました") && r1.ui.shareShown && r1.ui.preview > 0, r1.ui.status);
  check("共有メニューへPDFファイルを渡す（application/pdf・ファイル名 現場掲示_PDF共有の確認現場_2026-09-15.pdf）", r1.shared?.type === "application/pdf" && r1.shared.name === "現場掲示_PDF共有の確認現場_2026-09-15.pdf" && r1.pdf.subarray(0, 5).toString() === "%PDF-", JSON.stringify({ name: r1.shared?.name, type: r1.shared?.type, size: r1.shared?.size }));
  const info1 = await pdfInfo(page, r1.pdf);
  check("A3横（1191×842pt）・1ページ（pdf.js で開いて確認）", info1.pages === 1 && info1.w === 1191 && info1.h === 842, JSON.stringify(info1));
  const png1 = await sheetPng(html1);
  const ref1 = await renderJpeg(html1);
  const s1 = await diff(jpegOf(r1.pdf), ref1);
  check("PDFの画像は「A3印刷」で印刷画面に渡るHTMLから作ったもの（同じHTMLから作った画像と一致）", s1.max < 1, JSON.stringify(s1));
  const d1 = await diff(jpegOf(r1.pdf), png1);
  check("PDFの画像は、印刷用HTMLを画面に表示した紙面と同じ見た目（画素の差が小さい。欄の中身が違うと区画の差は19程度になる）", d1.mean < 2 && d1.max < 12, JSON.stringify(d1));
  const text1 = html1.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const want = ["PDF共有の確認現場", "K-777", "2026/09/15", "55%", "曇り", "21℃", "08:00", "朝礼", "08:20", "12:00", "昼休憩", "16:45", "片付け開始", "17:00", "作業終了", "塗料", "空缶", "ナダカ工業", "外壁塗装", "協栄工業", "足場", "08:00～17:00", "08:30～16:30", "足場上の墜落注意", "資材の落下注意", "山田", "連絡テスト：午後から車両通行止め", "上塗り"];
  const missing = want.filter((w) => !text1.includes(w));
  check("PDF（＝A3印刷の内容）に現場名・工事番号・日付・進捗率・天気・気温・流れ・搬入搬出・業者・工種・作業時間・職長・安全注意事項・連絡事項・明日の予定", missing.length === 0, missing.join(","));
  check("人数・人工（4人・2人、合計6）が入る", /6人/.test(text1) && text1.includes("4 / 4") && text1.includes("2 / 2"));
  check("請求人工は入らない（「請求」の文字も、請求人工の値 9.5・7.25 も無い）", !text1.includes("請求") && !text1.includes("9.5") && !text1.includes("7.25"));

  // ===== 2 データ連動（流れの追加・削除、搬入搬出の変更、日報の変更）=====
  await page.evaluate(async (id) => {
    const { getReport, updateReport } = await import("/js/reports.js");
    const r = await getReport(id);
    const timeline = r.timeline.filter((f) => f.time !== "15:00").concat([{ id: "add", time: "13:30", kind: "patrol", title: "3階巡回", status: "plan", note: "" }]);
    const deliveries = r.deliveries.map((d) => (d.id === "d1" ? { ...d, time: "10:30", item: "シーラー" } : d));
    await updateReport(id, { timeline, deliveries, remarks: "連絡を変更しました", progressPercent: 60 });
  }, ids.reportId);
  await openBoard(page, ids);
  const html2 = await printHtml(page);
  const r2 = await makeAndShare(page);
  const text2 = html2.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const ref2 = await renderJpeg(html2);
  const dNew = await diff(jpegOf(r2.pdf), ref2), dOld = await diff(jpegOf(r2.pdf), ref1);
  check("日報を変えると（流れ 13:30 追加・15:00 削除、搬入 09:00 塗料→10:30 シーラー、連絡事項・進捗率）A3印刷の内容が変わる", text2.includes("13:30") && text2.includes("3階巡回") && !text2.includes("15:00") && text2.includes("シーラー") && text2.includes("10:30") && !text2.includes("塗料") && text2.includes("連絡を変更しました") && text2.includes("60%"));
  check("PDFも変更後の内容（変更後の紙面と一致し、変更前の紙面とは違う）", dNew.max < 1 && dOld.max > 5, `変更後のHTMLとの差 ${JSON.stringify(dNew)}／変更前のHTMLとの差 ${JSON.stringify(dOld)}`);
  check("PDFは変更後もA3横・1ページ", JSON.stringify(await pdfInfo(page, r2.pdf)) === JSON.stringify({ pages: 1, w: 1191, h: 842 }));

  // ===== 3 共有できない環境 → 保存（ダウンロード）=====
  const ctxNo = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "board-pdf-noshare-")), { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  await ctxNo.addInitScript(() => { window.__shared = []; Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true }); Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); });
  const pn = await ctxNo.newPage(); pn.on("dialog", (d) => d.accept());
  await pn.goto(BASE); await pn.waitForSelector("#view-site-list:not([hidden])");
  const idsN = await seed(pn);
  await openBoard(pn, idsN);
  await pn.click('#siteDashboard [data-action="pdf"]');
  await pn.waitForFunction(() => document.getElementById("boardPdfStatus").textContent.includes("作成しました"), null, { timeout: 30000 });
  const noShare = await pn.evaluate(() => ({ shareHidden: document.getElementById("boardPdfShareBtn").hidden, note: document.getElementById("boardPdfNote").textContent }));
  const [dl] = await Promise.all([pn.waitForEvent("download"), pn.click("#boardPdfSaveBtn")]);
  const dlPath = path.join(dir, "dl.pdf"); await dl.saveAs(dlPath);
  const dlBuf = fs.readFileSync(dlPath);
  check("共有に対応しない環境では［共有］を出さず、［PDFを保存］でPDFファイルを保存できる", noShare.shareHidden && noShare.note.includes("保存") && dl.suggestedFilename() === "現場掲示_PDF共有の確認現場_2026-09-15.pdf" && dlBuf.subarray(0, 5).toString() === "%PDF-" && JSON.stringify(await pdfInfo(page, dlBuf)) === JSON.stringify({ pages: 1, w: 1191, h: 842 }), dl.suggestedFilename());
  await ctxNo.close();

  // ===== 4 WebKit（Safariと同じエンジン）でも作れる・共有メニューへ渡せる =====
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "board-pdf-wk-"));
  const wctx = await webkit.launchPersistentContext(wdir, { viewport: { width: 1180, height: 820 }, hasTouch: true });
  await wctx.addInitScript(SHARE_STUB);
  const wp = wctx.pages()[0] || await wctx.newPage(); const werr = []; wp.on("pageerror", (e) => werr.push(e.message)); wp.on("dialog", (d) => d.accept());
  await wp.goto(BASE); await wp.waitForSelector("#view-site-list:not([hidden])");
  const idsW = await seed(wp);
  await openBoard(wp, idsW);
  const htmlW = await printHtml(wp);
  const rw = await makeAndShare(wp);
  // WebKitの画面表示は表の細い罫線（0.2mm）を描かないことがあるため、見た目はChromiumで表示した紙面と比べる（エンジンの文字の描き方の差がある）
  const pngW = await sheetPng(htmlW);
  // 出どころ: WebKitで同じHTMLから同じ処理で作った画像と一致するか
  const refW = Buffer.from(await wp.evaluate(async (h) => { const { renderSheetHtmlToJpeg } = await import("/js/ui/board-pdf.js"); const { jpeg } = await renderSheetHtmlToJpeg(h); let s = ""; for (let i = 0; i < jpeg.length; i++) s += String.fromCharCode(jpeg[i]); return btoa(s); }, htmlW), "base64");
  const sW = rw.pdf ? await diff(jpegOf(rw.pdf), refW) : { max: 99 };
  const dW = rw.pdf ? await diff(jpegOf(rw.pdf), pngW) : { mean: 99, max: 99 };
  check("WebKit: PDFを作成して共有メニューへ渡せる（A3横・1ページ・印刷用HTMLから作った画像）", rw.ui.status.includes("作成しました") && rw.shared?.type === "application/pdf" && JSON.stringify(await pdfInfo(page, rw.pdf)) === JSON.stringify({ pages: 1, w: 1191, h: 842 }) && sW.max < 1 && dW.mean < 3 && dW.max < 20, `${rw.ui.status} 出どころの差 ${JSON.stringify(sW)}・Chromiumの表示との差 ${JSON.stringify(dW)}`);
  check("WebKit: ページエラーが無い", werr.length === 0, werr.slice(0, 2).join(" / "));
  await wctx.close();

  // ===== 5 データを変えない =====
  const afterPdf = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.reportId);
  await openBoard(page, ids); await makeAndShare(page);
  check("PDFを作っても日報は書き換えない", (await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.reportId)) === afterPdf);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await shotBrowser.close();
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
