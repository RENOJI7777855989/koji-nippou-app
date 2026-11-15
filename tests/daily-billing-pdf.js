// 業者別稼働・請求人工一覧（A4横のPDF。朝礼入力の［📄 業者別稼働・請求人工 PDF出力］。2026-11-15）
//   架空データ・隔離したプロファイル・Chromium（PDFの中身）＋WebKit（iPad の縦・横の画面）
//   ・業者の行ごとの稼働人数・請求人工（小数）・合計（別々に）・未入力は「未入力」で合計に入れない・件数
//   ・請求人工の読み方: billingManDays が有ればそれだけ（空欄を含む）、無いときだけ以前の版の manDays。二重に足さない
//   ・同じ業者で職種が違う行は別の行・業者名を変えても companyId の行のまま
//   ・保存していない変更があればPDFを作らない（「先に保存してください」）。保存済みの日報から作る
//   ・A4横（842×595pt）・業者が多ければ複数ページ（各ページに工事名・帳票名・見出し・n／総ページ数、合計は最後のページで業者の行と一緒）
//   ・表の文字が欄・紙面からはみ出さない・日本語の文字（字形）が描かれている・PDFの画像は印刷用HTMLの紙面と同じ
//   ・データを書き換えない・現場掲示の画面とA3に請求人工が出ない（従来どおり）
//   iPad 実機の共有メニュー・ファイルに保存・プリントは自動テストでは確かめられない（navigator.share に渡したファイルを記録する）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const D1 = "2026-09-15";
const D2 = "2026-09-16";
const OUT = process.env.TEST_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "daily-billing-out-"));
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const SHARE_STUB = () => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length && d.files.every((f) => f instanceof File);
  navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); window.__shared.push({ name: f.name, type: f.type, size: f.size, b64: btoa(s) }); };
};

const VENDORS = ["アオバ塗装工業", "イズミ足場工業", "ウエノ建設", "エノキ建装", "オリーブ警備", "カエデ美装工業", "キタノ土建", "クスノキ設備", "ケヤキ緑地"];
async function seed(page) {
  return page.evaluate(async ([d1, d2, vendors]) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "照合の確認現場", startDate: "2026-09-01", endDate: "2026-12-20", constructionNumber: "K-2026-15" });
    const row = (id, name, trade, actual, extra = {}) => ({ companyId: id, companyName: name, occupation: trade, plannedWorkerCount: "3", actualWorkerCount: actual, workHours: "08:00～17:00", workContent: trade + "の作業", ...extra });
    const r1 = stampNew({ siteId: site.id, date: d1, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], remarks: "連絡",
      companies: [
        row("a1", "アオバ塗装工業", "外壁下地補修", "5", { billingManDays: "5" }),
        row("a2", "アオバ塗装工業", "塗装", "3", { billingManDays: "2.5" }),
        row("k1", "キタノ土建", "土工", "2", { billingManDays: "0.1" }),
        row("k2", "キタノ土建", "土工（はつり）", "1", { billingManDays: "0.2" }),
        row("i1", "イズミ足場工業", "足場", "4", { billingManDays: "" }),           // 請求人工 未入力
        row("u1", "ウエノ建設", "足場", "2", { manDays: "1.75" }),                  // 以前の版の manDays だけ
        row("e1", "エノキ建装", "内装", "", { billingManDays: "", manDays: "3" }),  // 両方ある: billingManDays（空欄）だけを読む＝未入力。人数も未入力
        row("o1", "オリーブ警備", "警備", "1", { billingManDays: "1e2" })           // 決まりに合わない古い値 → 要確認
      ] });
    await dbPut("reports", r1);
    const many = Array.from({ length: 40 }, (_, i) => row(`m${i}`, `${vendors[i % vendors.length]}（${i + 1}班）`, ["塗装", "足場", "土工", "防水"][i % 4], String((i % 5) + 1), { billingManDays: i % 7 === 6 ? "" : String(((i % 4) + 1) * 0.25 + 1) }));
    const r2 = stampNew({ siteId: site.id, date: d2, dayStatus: "work", weather: "曇り", siteSupervisorNames: [], companies: many });
    await dbPut("reports", r2);
    return { siteId: site.id, r1: r1.id, r2: r2.id };
  }, [D1, D2, VENDORS]);
}
const openDash = async (page, ids, date) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, date);
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, date); await page.waitForTimeout(300);
};
const openChorei = async (page) => { await page.click('#siteDashboard [data-action="chorei"]'); await page.waitForFunction(() => document.getElementById("choreiDialog").open); await page.waitForTimeout(200); };
// ［PDF出力］→ 作成 →［共有］に渡されたPDF
const makePdf = async (page) => {
  const n = await page.evaluate(() => window.__shared.length);
  await page.click("#choreiPdfBtn");
  await page.waitForFunction(() => document.getElementById("boardPdfDialog").open && /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 60000 });
  const ui = await page.evaluate(() => ({ heading: document.getElementById("boardPdfHeading").textContent, status: document.getElementById("boardPdfStatus").textContent, source: document.getElementById("boardPdfSource").textContent, share: !document.getElementById("boardPdfShareBtn").hidden, print: !document.getElementById("boardPdfPrintBtn").hidden, preview: document.getElementById("boardPdfPreview").naturalWidth }));
  await page.click("#boardPdfShareBtn"); await page.waitForFunction((k) => window.__shared.length > k, n);
  const shared = await page.evaluate(() => window.__shared[window.__shared.length - 1]);
  return { ui, shared, pdf: Buffer.from(shared.b64, "base64") };
};
// pdf.js で開き、ページ数・用紙の大きさ・各ページの画像（PNG）
const pdfPages = (page, pdf) => page.evaluate(async (b64) => {
  const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ data: u }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p); const vp1 = pg.getViewport({ scale: 1 }); const vp = pg.getViewport({ scale: 1.6 });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 128) ink++;
    out.push({ w: Math.round(vp1.width), h: Math.round(vp1.height), ink, png: c.toDataURL("image/png").split(",")[1] });
  }
  return out;
}, pdf.toString("base64"));
// 印刷用HTMLの紙面ごとの検査（はみ出し・内容）
const inspectHtml = (page, html) => page.evaluate(async (h) => {
  const f = document.createElement("iframe"); f.style.cssText = "position:fixed;left:-30000px;top:0;width:1700px;height:1300px;border:0"; document.body.appendChild(f);
  await new Promise((r) => { f.onload = r; f.srcdoc = h; }); const doc = f.contentDocument; try { await doc.fonts.ready; } catch {}
  const sheets = [...doc.querySelectorAll(".sheet")].map((s) => {
    const sb = s.getBoundingClientRect();
    const cells = [...s.querySelectorAll("td, th")];
    const over = cells.filter((c) => c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1).map((c) => c.textContent.trim().slice(0, 20));
    const outside = [...s.querySelectorAll("table, .notes, .ft, .hd")].filter((el) => { const b = el.getBoundingClientRect(); return b.bottom > sb.bottom + 0.5 || b.right > sb.right + 0.5; }).map((el) => el.className || el.tagName);
    return { text: s.innerText.replace(/\s+/g, " "), rows: s.querySelectorAll("tbody tr:not(.total)").length, total: !!s.querySelector("tr.total"), thead: s.querySelectorAll("thead th").length, over, outside, mm: [Math.round(sb.width / 96 * 25.4), Math.round(sb.height / 96 * 25.4)],
      // 日本語の字形: 「業」の幅が、字形の無い文字（豆腐）と違う＝字形がある
      // 日本語の字形: 見出しの字体で「業」と字形の無い文字（私用領域の外の未定義の文字）を描き、画素が違う＝字形がある
      glyph: (() => { const draw = (ch) => { const c = document.createElement("canvas"); c.width = 60; c.height = 60; const x = c.getContext("2d"); x.font = getComputedStyle(s.querySelector("h1")).font.replace(/\d+(\.\d+)?px/, "40px"); x.fillText(ch, 5, 45); return Array.from(x.getImageData(0, 0, 60, 60).data.filter((_, i) => i % 4 === 3)); }; const a = draw("業"), b = draw("\u{10FFFD}"), k = draw("働"); const d = (p, q) => p.reduce((t, v, i) => t + Math.abs(v - q[i]), 0); return { ink: a.filter((v) => v > 0).length, vsTofu: d(a, b), vsOther: d(a, k) }; })() };
  });
  f.remove(); return sheets;
}, html);
const htmlOf = (page, id) => page.evaluate(async (reportId) => {
  const { getReport } = await import("/js/reports.js"); const { getSite } = await import("/js/sites.js"); const m = await import("/js/billing/dailyBillingSheet.js");
  const r = await getReport(reportId); const site = await getSite(r.siteId);
  const model = m.buildDailyBillingSheet({ site, report: r, generatedAt: new Date(2026, 8, 15, 9, 0) });
  return { html: m.buildDailyBillingSheetHtml(model), totals: model.totals, pages: model.pages.map((p) => p.length), rows: model.rows.map((x) => [x.companyId, x.vendor, x.trade, x.count.state, x.count.value, x.billing.state, x.billing.value]) };
}, id);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-billing-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(SHARE_STUB);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);
  const snap = () => page.evaluate(async (s) => JSON.stringify((await (await import("/js/reports.js")).listReportsBySite(s)).map((r) => [r.id, r.updatedAt, r.companies])), ids.siteId);

  // ===== 集計（モデル）=====
  const m1 = await htmlOf(page, ids.r1);
  const byId = Object.fromEntries(m1.rows.map((r) => [r[0], r]));
  check("1. 業者の行ごとの稼働人数（実績人数）", byId.a1[4] === 5 && byId.a2[4] === 3 && byId.i1[4] === 4 && byId.e1[3] === "blank", JSON.stringify(m1.rows));
  check("2. 業者の行ごとの請求人工（小数そのまま: 2.5・0.1・0.2）", byId.a1[6] === "5" && byId.a2[6] === "2.5" && byId.k1[6] === "0.1" && byId.k2[6] === "0.2");
  check("3. 請求人工の読み方: manDays だけの行は manDays（1.75）、billingManDays（空欄）と manDays（3）が両方ある行は billingManDays だけ＝未入力（二重に足さない）", byId.u1[5] === "ok" && byId.u1[6] === "1.75" && byId.e1[5] === "blank");
  check("4. 稼働人数の合計 18人（未入力の行は入れない）・入力済み 7／8行・未入力 1行", m1.totals.count === 18 && m1.totals.countEntered === 7 && m1.totals.countBlank === 1, JSON.stringify(m1.totals));
  check("5. 請求人工の合計 9.55人工（5+2.5+0.1+0.2+1.75。小数の誤差なし）・未入力 2行・要確認 1行（1e2）は合計に入れない", m1.totals.billing === "9.55" && m1.totals.billingBlank === 2 && m1.totals.billingInvalid === 1 && m1.totals.billingEntered === 5, JSON.stringify(m1.totals));
  check("6. 同じ業者でも職種が違う行は別の行（アオバ塗装工業 2行・キタノ土建 2行。まとめない）・並びは日報の行の順", m1.rows.filter((r) => r[1] === "アオバ塗装工業").length === 2 && m1.rows.filter((r) => r[1] === "キタノ土建").length === 2 && m1.rows.map((r) => r[0]).join() === "a1,a2,k1,k2,i1,u1,e1,o1");

  // ===== 画面: 未保存の変更があれば作らない → 保存 → PDF =====
  const before = await snap();
  await openDash(page, ids, D1); await openChorei(page);
  check("7. 朝礼入力に［📄 業者別稼働・請求人工 PDF出力］", await page.isVisible("#choreiPdfBtn") && (await page.textContent("#choreiPdfBtn")).includes("業者別稼働・請求人工 PDF出力"));
  await page.fill(".chorei-row >> nth=1 >> .chorei-billing", "2.75");
  await page.click("#choreiPdfBtn"); await page.waitForTimeout(600);
  const toast = await page.evaluate(() => document.body.innerText);
  check("8. 保存していない変更があると、PDFを作らず「先に［保存］を押してください」", !(await page.evaluate(() => document.getElementById("boardPdfDialog").open)) && /先に［保存］を押してください/.test(toast) && (await page.evaluate(() => window.__shared.length)) === 0);
  await page.click("#choreiSaveBtn"); await page.waitForFunction(() => !document.getElementById("choreiDialog").open); await page.waitForTimeout(300);
  await openChorei(page);
  // 業者名を変えても（データ上）、companyId の行の値のまま
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const x = await dbGet("reports", id); x.companies = x.companies.map((c) => (c.companyId === "a2" ? { ...c, companyName: "アオバ塗装工業（改称）" } : c)); await dbPut("reports", x); }, ids.r1);
  const r1 = await makePdf(page);
  check("9. 保存してからPDFを作成: 見出し・A4横・1ページ・見本・［共有］［印刷］", r1.ui.heading.includes("業者別稼働・請求人工一覧") && /A4横・1ページ/.test(r1.ui.status) && r1.ui.preview > 0 && r1.ui.share && r1.ui.print, JSON.stringify(r1.ui));
  check("10. 共有に渡すファイル: application/pdf・ファイル名 業者別稼働請求人工_照合の確認現場_2026-09-15.pdf", r1.shared.type === "application/pdf" && r1.shared.name === "業者別稼働請求人工_照合の確認現場_2026-09-15.pdf" && r1.pdf.subarray(0, 5).toString() === "%PDF-", r1.shared.name);
  const p1 = await pdfPages(page, r1.pdf);
  fs.writeFileSync(path.join(OUT, "daily-billing-1page.png"), Buffer.from(p1[0].png, "base64"));
  check("11. PDFは A4横（842×595pt）・1ページ（pdf.js で開いて確認）・中身が描かれている", p1.length === 1 && p1[0].w === 842 && p1[0].h === 595 && p1[0].ink > 2000, JSON.stringify(p1.map((x) => [x.w, x.h, x.ink])));
  const m1b = await htmlOf(page, ids.r1);
  const s1 = await inspectHtml(page, m1b.html);
  const t1 = s1[0].text;
  check("12. 保存した値（2.75）がPDFの元に入り、保存前の値（2.5）は無い・改称した業者名の行に 2.75", t1.includes("アオバ塗装工業（改称）") && /アオバ塗装工業（改称） 塗装 3人 2\.75人工/.test(t1) && !/2\.5人工/.test(t1), t1.slice(0, 400));
  check("13. 上部に帳票名・工事名・工事番号・対象日（2026年9月15日（火））", ["業者別稼働・請求人工一覧", "照合の確認現場", "K-2026-15", "2026年9月15日（火）"].every((w) => t1.includes(w)));
  check("14. 合計の行: 稼働人数 18人・請求人工 9.8人工（保存後の値）。注記に未入力・要確認の件数と「合計に含めていません」", /合計（8行） 18人 9\.8人工/.test(t1) && /稼働人数: 入力済み 7／8行・未入力 1行（合計に含めていません）/.test(t1) && /請求人工: 入力済み 5／8行・未入力 2行・要確認 1行（合計に含めていません。未入力を0人工として扱っていません）/.test(t1), (t1.match(/合計（.{0,40}/) || [""])[0]);
  check("15. 未入力は「未入力」、決まりに合わない値は「要確認（1e2）」と表示（0と表示しない）", /エノキ建装 内装 未入力 未入力/.test(t1) && /イズミ足場工業 足場 4人 未入力/.test(t1) && t1.includes("要確認（1e2）"));
  check("16. 日本語の字形が描かれている（字形の無い文字と幅が違う）・表の文字が欄からはみ出さない・紙面の外に出ない（A4横の余白の内側 277×190mm）", s1[0].glyph.ink > 100 && s1[0].glyph.vsTofu > 1000 && s1[0].glyph.vsOther > 1000 && s1[0].over.length === 0 && s1[0].outside.length === 0 && s1[0].mm[0] === 277 && s1[0].mm[1] === 190, JSON.stringify({ g: s1[0].glyph, over: s1[0].over, out: s1[0].outside, mm: s1[0].mm }));
  // PDFの画像は印刷用HTMLの紙面から作ったもの（アプリと同じ処理で作った画像と一致）
  const same = await page.evaluate(async (h) => { const { renderSheetsHtmlToJpegs } = await import("/js/ui/board-pdf.js"); return (await renderSheetsHtmlToJpegs(h)).length; }, m1b.html);
  check("17. 印刷用HTMLの紙面の数＝PDFのページ数", same === p1.length);
  await page.click("#boardPdfCloseBtn");

  // ［印刷］→ 既存の印刷ダイアログ（同じHTML・A4横の案内）
  await page.click("#choreiPdfBtn"); await page.waitForFunction(() => document.getElementById("boardPdfDialog").open && /作成しました/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 60000 });
  await page.click("#boardPdfPrintBtn");
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const pr = await page.evaluate(() => ({ note: document.getElementById("reportPrintNote").textContent, title: document.getElementById("reportPrintTitle").textContent, html: document.getElementById("reportPrintFrame").srcdoc, pdfOpen: document.getElementById("boardPdfDialog").open }));
  check("18. ［印刷］: PDFのダイアログを閉じ、既存の印刷ダイアログで同じ帳票を開く（用紙 A4・横の案内）", !pr.pdfOpen && pr.html.includes("業者別稼働・請求人工一覧") && /@page \{ size: A4 landscape/.test(pr.html) && pr.note.includes("用紙サイズをA4、印刷の向きを横"), pr.note.slice(0, 120));
  await page.click("#reportPrintCloseBtn"); await page.click("#choreiCloseBtn");

  // ===== 業者が多い日（40行）: 複数ページ =====
  const m2 = await htmlOf(page, ids.r2);
  check("19. 40行は 18・18・4行の3ページ（最後のページにも業者の行があり、合計はそのページ）", JSON.stringify(m2.pages) === "[18,18,4]", JSON.stringify(m2.pages));
  const s2 = await inspectHtml(page, m2.html);
  check("20. どのページにも帳票名・工事名・表の見出し・「n／3ページ」", s2.length === 3 && s2.every((s, i) => s.text.includes("業者別稼働・請求人工一覧") && s.text.includes("照合の確認現場") && s.thead === 5 && s.text.includes(`${i + 1}／3ページ`)), JSON.stringify(s2.map((s) => [s.thead, s.rows])));
  check("21. 合計の行は最後のページだけ（1・2ページ目は「次のページへ続きます」）", !s2[0].total && !s2[1].total && s2[2].total && s2[0].text.includes("次のページへ続きます") && !s2[2].text.includes("次のページへ続きます"));
  const sumCount = m2.rows.reduce((s, r) => s + (r[4] || 0), 0);
  const sumCents = m2.rows.reduce((s, r) => s + (r[5] === "ok" ? Math.round(Number(r[6]) * 100) : 0), 0);
  check("22. 複数ページでも合計＝全ページの業者の行の合計（人数・請求人工それぞれ）", m2.totals.count === sumCount && Math.round(Number(m2.totals.billing) * 100) === sumCents && s2[2].text.includes(`${sumCount}人`) && s2[2].text.includes(`${m2.totals.billing}人工`), JSON.stringify({ c: m2.totals.count, b: m2.totals.billing }));
  check("23. 複数ページのどのページも文字が欄からはみ出さず、紙面の外に出ない", s2.every((s) => s.over.length === 0 && s.outside.length === 0), JSON.stringify(s2.map((s) => [s.over, s.outside])));
  await openDash(page, ids, D2); await openChorei(page);
  const r2 = await makePdf(page);
  const p2 = await pdfPages(page, r2.pdf);
  p2.forEach((p, i) => fs.writeFileSync(path.join(OUT, `daily-billing-40rows-p${i + 1}.png`), Buffer.from(p.png, "base64")));
  check("24. 40行のPDF: A4横・3ページ（どのページも 842×595pt で中身あり）・状態に「3ページ」", p2.length === 3 && p2.every((p) => p.w === 842 && p.h === 595 && p.ink > 2000) && /A4横・3ページ/.test(r2.ui.status), JSON.stringify(p2.map((x) => [x.w, x.h, x.ink])));
  await page.click("#boardPdfCloseBtn"); await page.click("#choreiCloseBtn");

  // ページ分けの境目（15・16・18・19行）
  const split = await page.evaluate(async () => {
    const m = await import("/js/billing/dailyBillingSheet.js");
    const mk = (n) => m.buildDailyBillingSheet({ site: { name: "x" }, report: { date: "2026-09-15", dayStatus: "work", companies: Array.from({ length: n }, (_, i) => ({ companyId: "c" + i, companyName: "業者" + i, occupation: "塗装", actualWorkerCount: "1", billingManDays: "1" })) } }).pages.map((p) => p.length);
    return { 0: mk(0), 15: mk(15), 16: mk(16), 18: mk(18), 19: mk(19), 33: mk(33), 34: mk(34) };
  });
  check("25. ページの境目: 0行→1ページ（業者なしの表示）・15行→1ページ・16〜18行→2ページ（最後のページに1行以上）・33行→2ページ・34行→3ページ", JSON.stringify(split) === JSON.stringify({ 0: [0], 15: [15], 16: [15, 1], 18: [17, 1], 19: [18, 1], 33: [18, 15], 34: [18, 15, 1] }), JSON.stringify(split));

  // ===== 影響が無いこと =====
  const after = await snap();
  const pick = (json, id) => JSON.parse(json).find((x) => x[0] === id);
  const b1 = pick(before, ids.r1), a1 = pick(after, ids.r1), b2 = pick(before, ids.r2), a2 = pick(after, ids.r2);
  check("26. PDFの作成・印刷では日報を書き換えない（40行の日報は更新日時も中身も同じ。1日目は朝礼入力で保存した 1行（a2）だけが変わる）", a2[1] === b2[1] && JSON.stringify(a2[2]) === JSON.stringify(b2[2]) && a1[2].filter((c, i) => JSON.stringify(c) !== JSON.stringify(b1[2][i])).map((c) => c.companyId).join() === "a2");
  await openDash(page, ids, D1);
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
  const board = await page.$eval("#siteDashboard [data-panel=board]", (el) => el.textContent);
  await page.click("#siteDashboard [data-action=print]");
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const a3 = (await page.$eval("#reportPrintFrame", (f) => f.srcdoc)).replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
  await page.click("#reportPrintCloseBtn");
  check("27. 現場掲示の画面・A3印刷には従来どおり請求人工が出ない（「請求」の文字・9.8 が無い）", !board.includes("請求") && !a3.includes("請求") && !a3.includes("9.8"));
  check("28. ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // ===== iPad の縦・横（WebKit）: ボタン・PDFのダイアログ =====
  for (const [label, vp] of [["縦", { width: 820, height: 1180 }], ["横", { width: 1180, height: 820 }]]) {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "daily-billing-wk-"));
    const c2 = await webkit.launchPersistentContext(d2, { viewport: vp, deviceScaleFactor: 2, hasTouch: true });
    await c2.addInitScript(SHARE_STUB);
    const p2w = await c2.newPage(); p2w.on("dialog", (d) => d.accept());
    await p2w.goto(BASE); await p2w.waitForSelector("#view-site-list:not([hidden])");
    const i2 = await seed(p2w);
    await openDash(p2w, i2, D2); await openChorei(p2w);
    const btn = await p2w.$eval("#choreiPdfBtn", (b) => { const r = b.getBoundingClientRect(); return { h: r.height, right: r.right, w: window.innerWidth }; });
    await p2w.tap("#choreiPdfBtn");
    await p2w.waitForFunction(() => document.getElementById("boardPdfDialog").open && /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 60000 });
    const st = await p2w.evaluate(() => { const d = document.getElementById("boardPdfDialog").getBoundingClientRect(); return { status: document.getElementById("boardPdfStatus").textContent, inside: d.left >= 0 && d.right <= window.innerWidth, share: !document.getElementById("boardPdfShareBtn").hidden, preview: document.getElementById("boardPdfPreview").naturalWidth, overflow: document.documentElement.scrollWidth - window.innerWidth }; });
    await p2w.tap("#boardPdfShareBtn"); await p2w.waitForFunction(() => window.__shared.length > 0);
    const sh = await p2w.evaluate(() => ({ name: window.__shared[0].name, type: window.__shared[0].type, size: window.__shared[0].size }));
    check(`29. iPad ${label}（WebKit）: ボタンは44px以上で画面内・PDF（3ページ）を作成して見本を表示・共有に PDF を渡す`, btn.h >= 44 && btn.right <= btn.w && /A4横・3ページ/.test(st.status) && st.inside && st.share && st.preview > 0 && st.overflow <= 0 && sh.type === "application/pdf" && sh.size > 10000, JSON.stringify({ btn, st, sh }));
    await c2.close(); fs.rmSync(d2, { recursive: true, force: true });
  }

  console.log(`PDFの各ページの画像: ${OUT}`);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
