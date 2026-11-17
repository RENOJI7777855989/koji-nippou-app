// 請求人工 月間明細の所長印（2026-11-17、v83）。架空データ・Chromium＋WebKit（iPad の縦）
//   ・1ページ目の見出しの欄の右に「所長」欄。押印していなければ空欄、押印すれば名前の赤い丸印（SVG）と日付
//   ・押印は業者×月ごとに現場の記録（site.billingMonths[月].seals）に残る。取り消し・押し直しができる。請求人工・日報は変わらない
//   ・PDF（紙面を画像にしたもの）に印が描かれる。業者別稼働PDF・照合表には欄を出さない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const MONTH = "2026-10";
const OUT = process.env.TEST_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "billing-seal-out-"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const SHARE_STUB = () => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length;
  navigator.share = async (d) => { const out = []; for (const f of d.files) { const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); out.push({ name: f.name, b64: btoa(s) }); } window.__shared.push(out); };
};

const seed = (page) => page.evaluate(async () => {
  const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
  const s = await createSite({ name: "所長印の確認現場", startDate: "2026-09-01", endDate: "2026-12-20", constructionNumber: "K-2026-17" });
  for (const [d, n] of [["2026-10-01", "3"], ["2026-10-02", "2.5"]]) await dbPut("reports", stampNew({ siteId: s.id, date: d, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [
    { companyId: `a${d}`, companyName: "アオバ塗装工業", occupation: "塗装", actualWorkerCount: "3", billingManDays: n },
    { companyId: `k${d}`, companyName: "キタノ土建", occupation: "土工", actualWorkerCount: "2", billingManDays: "2" }] }));
  return s.id;
});
const openPdfSection = async (page, siteId) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])");
  await page.selectOption("#vendorMgmtMonth", MONTH); await page.waitForTimeout(300);
  await page.click('[data-vm-tab="reconcile"]'); await page.waitForTimeout(300);
};
const sheetOf = (page, siteId) => page.evaluate(async ([s, m]) => {
  const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const v = await import("/js/billing/vendorMonthSheets.js"); const bm = await import("/js/billing/billingMonthly.js");
  const site = await getSite(s); const reports = await listReportsBySite(s); const vs = v.monthVendors({ site, reports, month: m, today: "2026-11-17" });
  const a = vs.find((x) => x.vendorName === "アオバ塗装工業");
  const seal = bm.billingSealOf(site, m, [a.vendorId, ...a.names.map((n) => `name:${n}`)]);
  const html = v.buildVendorBillingSheet({ site, reports, month: m, today: "2026-11-17", vendorId: a.vendorId, seal }).html;
  const act = v.buildVendorActivitySheet({ site, reports, month: m, today: "2026-11-17", vendorId: a.vendorId }).html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { seal, boxes: doc.querySelectorAll(".sealbox:not(.sealbox-blank)").length, label: doc.querySelector(".sealbox .sl")?.textContent, svgText: doc.querySelector(".sealbox svg")?.textContent || "", date: doc.querySelector(".sealbox .sd")?.textContent || "", actHasSeal: !!new DOMParser().parseFromString(act, "text/html").querySelector(".sealbox"), months: site.billingMonths?.[m] };
}, [siteId, MONTH]);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-seal-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(SHARE_STUB);
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const siteId = await seed(page);
  const before = await page.evaluate(async (s) => JSON.stringify((await (await import("/js/reports.js")).listReportsBySite(s)).map((r) => [r.id, r.updatedAt, r.companies])), siteId);

  let sh = await sheetOf(page, siteId);
  check("1. 押印前: 請求人工 月間明細の1ページ目に「所長」欄（空欄）", sh.boxes === 1 && sh.label === "所長" && sh.svgText === "" && !sh.seal, JSON.stringify(sh));
  check("2. 業者別稼働PDFには所長欄を出さない", sh.actHasSeal === false);
  await openPdfSection(page, siteId);
  const sum = await page.textContent(".vm-seal-sum");
  check("3. 業者を選ぶ前は押印済みの件数（0／2業者）", /押印済み 0／2業者/.test(sum), sum);
  await page.selectOption(".vm-pdf-vendor-select", { label: "アオバ塗装工業" }); await page.waitForTimeout(300);
  check("4. 業者を選ぶと「所長印 未押印」と名前の欄・［押印する］", /所長印 未押印/.test(await page.textContent(".vm-seal-state")) && await page.isVisible(".vm-seal-stamp"));
  await page.fill(".vm-seal-name", "山 田"); await page.click(".vm-seal-stamp"); await page.waitForTimeout(600);
  sh = await sheetOf(page, siteId);
  check("5. 押印: 現場の記録に名前（空白を除く）と日時・PDFの所長欄に「山田」の印（SVG）と日付", sh.seal?.name === "山田" && !!sh.seal?.stampedAt && /山田/.test(sh.svgText) && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(sh.date) && /押印済み（山田/.test(await page.textContent(".vm-seal-state")), JSON.stringify(sh));
  check("6. 業者の選択肢に「（所長印 押印済み）」・ほかの業者（キタノ土建）は押印されない", (await page.$$eval(".vm-pdf-vendor-select option", (os) => os.map((o) => o.textContent))).some((t) => t === "アオバ塗装工業（所長印 押印済み）") && Object.keys(sh.months.seals).length === 1);
  // PDF に印が描かれる（印の赤い画素がある）
  await page.click('.vm-pdf-btn[data-pdf="billing"]');
  await page.waitForFunction(() => document.getElementById("boardPdfDialog").open && /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 90000 });
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 1);
  const red = await page.evaluate(async () => {
    const f = window.__shared[0][0]; const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const bin = atob(f.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pg = await (await pdfjs.getDocument({ data: u }).promise).getPage(1); const vp = pg.getViewport({ scale: 1.5 });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0, top = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) { n++; if (((i / 4) / c.width) < c.height * 0.2) top++; }
    return { name: f.name, w: Math.round(vp.width / 1.5), h: Math.round(vp.height / 1.5), red: n, top, png: c.toDataURL("image/png").split(",")[1] };
  });
  fs.writeFileSync(path.join(OUT, "billing-seal-page1.png"), Buffer.from(red.png, "base64"));
  check("7. PDF（A4縦）の1ページ目の上部に印の赤い画素がある", red.w === 595 && red.h === 842 && red.red > 200 && red.top >= red.red * 0.9, JSON.stringify({ ...red, png: undefined }));
  await page.click("#boardPdfCloseBtn");
  // 取り消し
  await page.click(".vm-seal-clear"); await page.waitForTimeout(600);
  sh = await sheetOf(page, siteId);
  check("8. 押印を取り消すと記録が消え、PDFの所長欄は空欄に戻る", !sh.seal && sh.svgText === "" && /所長印 未押印/.test(await page.textContent(".vm-seal-state")));
  const after = await page.evaluate(async (s) => JSON.stringify((await (await import("/js/reports.js")).listReportsBySite(s)).map((r) => [r.id, r.updatedAt, r.companies])), siteId);
  check("9. 押印・取り消し・PDFの作成で日報（請求人工を含む）は変わらない", after === before);
  check("10. ページエラーが無い", errors.length === 0, errors.join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // iPad の縦（WebKit）: 押印の欄が画面に収まる
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "billing-seal-wk-"));
  const c2 = await webkit.launchPersistentContext(d2, { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
  await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
  const s2 = await seed(p2); await openPdfSection(p2, s2);
  await p2.selectOption(".vm-pdf-vendor-select", { label: "アオバ塗装工業" }); await p2.waitForTimeout(300);
  await p2.fill(".vm-seal-name", "山田"); await p2.tap(".vm-seal-stamp"); await p2.waitForTimeout(600);
  const lay = await p2.evaluate(() => { const bs = [...document.querySelectorAll(".vm-seal button, .vm-seal-name")].map((b) => b.getBoundingClientRect()); return { minH: Math.min(...bs.map((b) => b.height)), out: bs.filter((b) => b.right > window.innerWidth).length, overflow: document.documentElement.scrollWidth - window.innerWidth, svg: !!document.querySelector(".vm-seal-preview svg") }; });
  check("11. iPad 縦（WebKit）: 押印の欄のボタン・入力は44px以上で画面内・見本に印", lay.minH >= 44 && lay.out === 0 && lay.overflow <= 0 && lay.svg, JSON.stringify(lay));
  await c2.close(); fs.rmSync(d2, { recursive: true, force: true });

  console.log(`PDFの画像: ${OUT}`);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
