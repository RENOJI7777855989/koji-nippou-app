// 請求人工と実稼働の照合・業者ごとの請求人工PDF／業者別稼働PDF・業者名の確認・棟の使用設定（2026-11-16）
//   架空データ・隔離したプロファイル。Chromium（集計・画面・PDFの中身）＋WebKit（iPad の縦・横の画面）
//   ・同じ業者名はまとまる／表記違いは確認するまで別（業者名確認待ち）・確認後は同じ業者／別の業者の記録・解除
//   ・同じ業者の棟ごと・業者別は全棟の合計・棟別・業者・棟別・職種別
//   ・棟の無い現場・棟を使う現場の棟未入力（棟未設定）・日報画面の棟の欄
//   ・請求人工PDFと業者別稼働PDFは別のファイル・業者ごとのファイル・まとめて共有／ZIP・複数ページ
//   ・照合表の合計・差異・日付ごとの明細・未入力を0にしない・日報を書き換えない
//   iPad 実機の共有メニュー・ファイルに保存・プリントは自動テストでは確かめられない（navigator.share に渡したファイルを記録する）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const MONTH = "2026-10";
const OUT = process.env.TEST_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "vendor-reconcile-out-"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const SHARE_STUB = () => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length && d.files.every((f) => f instanceof File);
  navigator.share = async (d) => {
    const files = [];
    for (const f of d.files) { const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); files.push({ name: f.name, type: f.type, size: f.size, b64: btoa(s) }); }
    window.__shared.push(files);
  };
};

async function seed(page) {
  return page.evaluate(async () => {
    const { createSite, updateSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const a = await createSite({ name: "照合の確認現場", startDate: "2026-09-01", endDate: "2026-12-20", constructionNumber: "K-2026-16" });
    await updateSite(a.id, { buildings: [{ id: "bTA", name: "TA号棟", active: true, order: 0 }, { id: "bTB", name: "TB号棟", active: true, order: 1 }] });
    const row = (id, b, name, trade, actual, extra = {}) => ({ companyId: id, buildingId: b ? `b${b}` : "", buildingName: b ? `${b}号棟` : "", companyName: name, occupation: trade, plannedWorkerCount: "3", actualWorkerCount: actual, workHours: "08:00～17:00", workContent: `${trade}の作業（${b || "棟なし"}）`, ...extra });
    const rep = (siteId, date, companies, extra = {}) => stampNew({ siteId, date, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies, ...extra });
    const list = [
      rep(a.id, "2026-09-30", [row("p0", "TA", "アオバ塗装工業", "塗装", "5", { billingManDays: "5" })]), // 別の月
      rep(a.id, "2026-10-01", [
        row("a1", "TA", "アオバ塗装工業", "塗装", "3", { billingManDays: "3" }),
        row("a2", "TB", "アオバ塗装工業", "塗装", "2", { billingManDays: "2" }),
        row("i1", "TA", "株式会社イズミ足場", "足場", "4", { billingManDays: "4" }),
        row("u1", "", "ウエノ建設", "足場", "2", { billingManDays: "2" })             // 棟未設定
      ]),
      rep(a.id, "2026-10-02", [
        row("a3", "TA", "アオバ塗装工業", "防水", "1", { billingManDays: "1.5" }),
        row("i2", "TA", "（株）イズミ足場", "足場", "4", { billingManDays: "4" }),
        row("i3", "TB", "イズミ足場", "足場", "2", { billingManDays: "" }),          // 請求人工 未入力
        row("k1", "TA", "キタノ土建", "土工", "2")                                    // 請求人工の欄なし
      ]),
      rep(a.id, "2026-10-03", [row("a4", "TA", "アオバ塗装工業", "塗装", "", { billingManDays: "1" })], { dayStatus: "holiday" }), // 休工日の請求人工
      rep(a.id, "2026-10-04", [row("x1", "TA", "ケヤキ緑地", "植栽", "", { billingManDays: "" })]),       // 稼働も請求も無い
      rep(a.id, "2026-10-05", [row("u2", "TB", "ウエノ建設", "足場", "2", { manDays: "2" })]),           // 以前の版の manDays
      { ...rep(a.id, "2026-10-06", [row("d1", "TA", "アオバ塗装工業", "塗装", "9", { billingManDays: "9" })]), isDeleted: true } // 削除済み
    ];
    for (const r of list) await dbPut("reports", r);
    const b = await createSite({ name: "道路の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const rb = rep(b.id, "2026-10-01", [
      { companyId: "o1", companyName: "オリーブ警備", occupation: "警備", actualWorkerCount: "2", billingManDays: "2", workContent: "交通誘導" },
      { companyId: "o2", companyName: "カエデ美装工業", occupation: "清掃", actualWorkerCount: "1", billingManDays: "0.75", workContent: "清掃" }
    ]);
    await dbPut("reports", rb);
    return { a: a.id, b: b.id, rb: rb.id };
  });
}
const rcOf = (page, siteId, opt) => page.evaluate(async ([siteId, month, opt]) => {
  const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js");
  const rc = await import("/js/billing/billingReconcile.js"); const vn = await import("/js/billing/vendorNames.js");
  const site = await getSite(siteId); const reports = await listReportsBySite(siteId);
  const names = vn.collectVendorNames({ site, reports });
  const cand = vn.vendorNameCandidates({ site, names });
  const r = rc.buildReconciliation({ site, reports, month, today: "2026-11-16", ...opt, pendingNames: vn.pendingNameSet(cand) });
  return { pending: cand.pending.map((p) => [p.a, p.b, p.level].join("|")), groups: cand.groups.map((g) => g.names.slice().sort().join("+")), usesBuildings: r.usesBuildings, view: r.view, totals: r.totals,
    rows: r.rows.map((x) => ({ k: [x.vendorName, x.buildingLabel, x.trade].filter(Boolean).join("/"), w: x.workers, m: x.manDays, d: x.workDays, b: x.billing, diff: x.diff, st: x.stateLabel, miss: x.missingRows, names: x.rawNames, days: x.days.map((y) => [y.date, y.manDays, y.billing, y.diff, y.work].join(",")) })) };
}, [siteId, MONTH, opt || {}]);
const find = (r, k) => r.rows.find((x) => x.k === k) || {};
const snap = (page) => page.evaluate(async () => { const { dbGetAll } = await import("/js/db.js"); return JSON.stringify((await dbGetAll("reports")).map((r) => [r.id, r.updatedAt, r.companies]).sort()); });
const openVm = async (page, siteId, tab) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])");
  await page.selectOption("#vendorMgmtMonth", MONTH); await page.waitForTimeout(300);
  await page.click(`[data-vm-tab="${tab}"]`); await page.waitForTimeout(300);
};
const waitPdf = (page) => page.waitForFunction(() => document.getElementById("boardPdfDialog").open && /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 90000 });
const pdfInfo = (page, b64) => page.evaluate(async (b64) => {
  const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ data: u }).promise; const out = [];
  for (let p = 1; p <= doc.numPages; p++) { const pg = await doc.getPage(p); const vp = pg.getViewport({ scale: 1 }); out.push([Math.round(vp.width), Math.round(vp.height)]); }
  return out;
}, b64);
const sheetText = (page, html) => page.evaluate(async (h) => {
  const f = document.createElement("iframe"); f.style.cssText = "position:fixed;left:-30000px;top:0;width:1700px;height:1300px;border:0"; document.body.appendChild(f);
  await new Promise((r) => { f.onload = r; f.srcdoc = h; }); const doc = f.contentDocument; try { await doc.fonts.ready; } catch {}
  const sheets = [...doc.querySelectorAll(".sheet")].map((s) => { const sb = s.getBoundingClientRect();
    return { text: s.innerText.replace(/\s+/g, " "), thead: s.querySelectorAll("thead").length, total: s.querySelectorAll("tr.total").length, rowsBeforeTotal: (() => { const t = s.querySelector("tr.total"); if (!t) return -1; return [...t.parentElement.children].filter((x) => x !== t && !x.querySelector(".none")).length; })(),
      outside: [...s.querySelectorAll("table, .notes, .ft, .hd")].filter((el) => { const b = el.getBoundingClientRect(); return b.bottom > sb.bottom + 0.5 || b.right > sb.right + 0.5; }).length,
      over: [...s.querySelectorAll("td, th")].filter((c) => c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1).map((c) => c.textContent.trim().slice(0, 16)) }; });
  f.remove(); return sheets;
}, html);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-reconcile-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(SHARE_STUB);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);
  const before = await snap(page);
  const actBefore = await page.evaluate(async (s) => { const { listReportsBySite } = await import("/js/reports.js"); const m = await import("/js/billing/billingMonthly.js"); const r = await listReportsBySite(s); return JSON.stringify([m.buildVendorActivity({ reports: r, month: "2026-10", today: "2026-11-16", startDate: "2026-09-01" }), m.buildMonthlyBilling({ reports: r, month: "2026-10", today: "2026-11-16" })]); }, ids.a);

  // ===== 業者名の候補・確認前 =====
  let r = await rcOf(page, ids.a, { view: "vendor" });
  check("1. 同じ業者名の行はまとまる（アオバ塗装工業: 10/1 TA 3＋TB 2・10/2 防水 1 ＝延べ6人・実稼働人日6・稼働2日。9/30・削除済み・休工日の人数は入れない）", find(r, "アオバ塗装工業").w === 6 && find(r, "アオバ塗装工業").m === 6 && find(r, "アオバ塗装工業").d === 2, JSON.stringify(find(r, "アオバ塗装工業")));
  check("2. 表記違いの候補: 株式会社イズミ足場・（株）イズミ足場・イズミ足場の3組（表記違いの可能性が高い）。似ていない名前は候補にしない", r.pending.length === 3 && r.pending.every((p) => p.endsWith("|high")) && r.pending.every((p) => p.includes("イズミ")), JSON.stringify(r.pending));
  check("3. 確認前は自動でまとめず、3つの表記がそれぞれ「業者名確認待ち」", ["株式会社イズミ足場", "（株）イズミ足場", "イズミ足場"].every((n) => find(r, n).st === "業者名確認待ち") && r.groups.length === 0, JSON.stringify(r.rows.map((x) => x.k + ":" + x.st)));
  check("4. 請求人工の読み方: 以前の版の manDays だけの行も請求人工（ウエノ建設 2＋2＝4・実稼働4 → 一致）", find(r, "ウエノ建設").b === "4" && find(r, "ウエノ建設").st === "一致");
  check("5. 請求人工が1件も無い業者は「未照合」（キタノ土建: 実稼働2・請求 未入力。0人工にしない）", find(r, "キタノ土建").st === "未照合" && find(r, "キタノ土建").b === null && find(r, "キタノ土建").m === 2);
  check("6. 差異: アオバ塗装工業 請求7.5（3＋2＋1.5＋休工日の1）−実稼働6＝+1.5 → 差異あり", find(r, "アオバ塗装工業").b === "7.5" && find(r, "アオバ塗装工業").diff === "1.5" && find(r, "アオバ塗装工業").st === "差異あり");
  check("7. 日付ごとの明細: 10/1 5・5・0 ／10/2 1・1.5・+0.5 ／10/3 休工日 0・1・+1（稼働に数えない日）", JSON.stringify(find(r, "アオバ塗装工業").days) === JSON.stringify(["2026-10-01,5,5,0,true", "2026-10-02,1,1.5,0.5,true", "2026-10-03,0,1,1,false"]), JSON.stringify(find(r, "アオバ塗装工業").days));
  check("8. 稼働も請求人工も無い行（ケヤキ緑地）は照合に出さない", !r.rows.some((x) => x.k.includes("ケヤキ")));

  // ===== 画面: 業者名の確認 → まとめる =====
  await openVm(page, ids.a, "names");
  const namesUi = await page.evaluate(() => ({ pairs: document.querySelectorAll(".vm-name-pair").length, text: document.getElementById("vendorMgmtBody").innerText }));
  check("9. 業者名の確認の画面: 候補3組・自動ではまとめない説明・一覧に使われている所（日報 n行・n日）", namesUi.pairs === 3 && namesUi.text.includes("自動ではまとめません") && /株式会社イズミ足場[\s\S]*日報 1行・1日/.test(namesUi.text), namesUi.text.slice(0, 200));
  // 一覧から3つを選んでまとめる（表示名＝最初に選んだ名前）
  for (const n of ["株式会社イズミ足場", "（株）イズミ足場", "イズミ足場"]) await page.check(`.vm-name-pick[value="${n}"]`);
  await page.click(".vm-merge-picked"); await page.waitForTimeout(500);
  const disp0 = await page.evaluate(() => document.querySelector(".vm-group-disp")?.value);
  await page.selectOption(".vm-group-disp", "株式会社イズミ足場"); await page.waitForTimeout(500);
  check("9b. まとめた直後の表示名は最初に選んだ名前・表示名はまとめた名前から選び直せる", !!disp0 && (await page.evaluate(() => document.querySelector(".vm-group-disp")?.value)) === "株式会社イズミ足場", disp0);
  r = await rcOf(page, ids.a, { view: "vendor" });
  const iz = find(r, "株式会社イズミ足場");
  check("10. 確認後は同じ業者として集計: 株式会社イズミ足場 延べ10人（4＋4＋2）・請求8（未入力1件は0にしない）・差異 -2・未入力あり", iz.w === 10 && iz.b === "8" && iz.diff === "-2" && iz.st === "未入力あり" && iz.miss === 1 && iz.names.length === 3 && r.pending.length === 0, JSON.stringify(iz));
  check("11. 照合表の合計: 延べ22人・実稼働人日22・請求19.5・差異 -2.5", r.totals.workers === 22 && r.totals.manDays === 22 && r.totals.billing === "19.5" && r.totals.diff === "-2.5", JSON.stringify(r.totals));
  const siteRec = await page.evaluate(async (s) => (await (await import("/js/sites.js")).getSite(s)).vendorDirectory, ids.a);
  check("12. 確認結果は現場の記録に保存（業者ID＝グループの id。名前3つ）・日報の業者名は書き換えない", siteRec.groups.length === 1 && siteRec.groups[0].names.length === 3 && !!siteRec.groups[0].id && (await snap(page)) === before);

  // ===== 棟別・業者・棟別・職種別 =====
  r = await rcOf(page, ids.a, { view: "vendorBuilding" });
  check("13. 業者・棟別: アオバ塗装工業/TA号棟 実稼働4・請求5.5（差異 +1.5）、TB号棟 2・2（一致）＝業者別の6は棟の合計", find(r, "アオバ塗装工業/TA号棟").m === 4 && find(r, "アオバ塗装工業/TA号棟").b === "5.5" && find(r, "アオバ塗装工業/TB号棟").st === "一致" && find(r, "アオバ塗装工業/TA号棟").m + find(r, "アオバ塗装工業/TB号棟").m === 6, JSON.stringify(r.rows.map((x) => x.k)));
  check("14. 棟を使う現場の棟未入力は「棟未設定」（ウエノ建設/（棟未設定） 2人）", find(r, "ウエノ建設/（棟未設定）").st === "棟未設定" && find(r, "ウエノ建設/（棟未設定）").m === 2 && find(r, "ウエノ建設/TB号棟").st === "一致");
  r = await rcOf(page, ids.a, { view: "building" });
  check("15. 棟別（全業者）: TA号棟 延べ14人・請求13.5・未入力あり／TB号棟 6・4／棟未設定 2", find(r, "TA号棟").w === 14 && find(r, "TA号棟").b === "13.5" && find(r, "TA号棟").st === "未入力あり" && find(r, "TB号棟").w === 6 && find(r, "TB号棟").b === "4" && find(r, "（棟未設定）").st === "棟未設定", JSON.stringify(r.rows));
  r = await rcOf(page, ids.a, { view: "vendorBuilding", byTrade: true });
  check("16. 職種別: アオバ塗装工業/TA号棟 の塗装（実稼働3・請求4）と防水（1・1.5）を分ける", find(r, "アオバ塗装工業/TA号棟/塗装").m === 3 && find(r, "アオバ塗装工業/TA号棟/塗装").b === "4" && find(r, "アオバ塗装工業/TA号棟/防水").b === "1.5", JSON.stringify(r.rows.map((x) => x.k)));

  // ===== 画面の照合表 =====
  await openVm(page, ids.a, "reconcile");
  const ui1 = await page.evaluate(() => ({ text: document.getElementById("vendorMgmtBody").innerText, views: document.querySelectorAll(".vm-rc-view").length }));
  check("17. 照合・PDFの画面: 単位の切り替え3つ・状態の件数・合計の行・PDFのボタン3つ", ui1.views === 3 && /差異あり 1/.test(ui1.text) && /19\.5/.test(ui1.text) && (await page.$$(".vm-pdf-btn")).length === 3, ui1.text.slice(0, 300));
  await page.click('.vm-rc-row[data-rc-key^="name:アオバ"]'); await page.waitForTimeout(200);
  const det = await page.evaluate(() => document.querySelector(".vm-rc-detail")?.innerText || "");
  check("18. 行を押すと日付ごとの明細（休工日の請求人工は「稼働に数えない日の請求人工」）", /10\/3[\s\S]*休工日[\s\S]*稼働に数えない日の請求人工/.test(det), det.slice(0, 200));
  await page.click('.vm-rc-view[data-rc-view="building"]'); await page.waitForTimeout(200);
  check("19. 画面で棟別に切り替え", (await page.evaluate(() => document.querySelector(".vm-rc-table thead").innerText)).includes("棟") && !(await page.evaluate(() => document.querySelector(".vm-rc-table thead").innerText)).includes("業者"));
  await page.click('.vm-rc-view[data-rc-view="vendor"]'); await page.waitForTimeout(200);

  // ===== PDF: 請求人工（1業者）=====
  await page.selectOption(".vm-pdf-vendor-select", { label: "株式会社イズミ足場" });
  await page.click('.vm-pdf-btn[data-pdf="billing"]'); await waitPdf(page);
  const st1 = await page.textContent("#boardPdfStatus");
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 1);
  const sh1 = await page.evaluate(() => window.__shared[0].map((f) => ({ name: f.name, type: f.type, b64: f.b64 })));
  const p1 = await pdfInfo(page, sh1[0].b64);
  check("20. 請求人工PDF（1業者）: ファイル名「株式会社イズミ足場_2026年10月_請求人工.pdf」・A4縦（595×842）", sh1.length === 1 && sh1[0].name === "株式会社イズミ足場_2026年10月_請求人工.pdf" && sh1[0].type === "application/pdf" && p1.every(([w, h]) => w === 595 && h === 842) && /A4縦/.test(st1), `${st1} ${JSON.stringify(p1)}`);
  fs.writeFileSync(path.join(OUT, sh1[0].name), Buffer.from(sh1[0].b64, "base64"));
  await page.click("#boardPdfCloseBtn");
  const sheets = await page.evaluate(async ([s, m]) => {
    const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const v = await import("/js/billing/vendorMonthSheets.js");
    const site = await getSite(s); const reports = await listReportsBySite(s); const vs = v.monthVendors({ site, reports, month: m, today: "2026-11-16" });
    const id = vs.find((x) => x.vendorName === "株式会社イズミ足場").vendorId;
    const b = v.buildVendorBillingSheet({ site, reports, month: m, today: "2026-11-16", vendorId: id }); const a = v.buildVendorActivitySheet({ site, reports, month: m, today: "2026-11-16", vendorId: id });
    return { b: { html: b.html, total: b.total, blank: b.blank, entered: b.entered, file: b.fileName }, a: { html: a.html, workers: a.workers, manDays: a.manDays, days: a.days, file: a.fileName } };
  }, [ids.a, MONTH]);
  const bt = (await sheetText(page, sheets.b.html))[0];
  check("21. 請求人工PDFの内容: 工事名・工事番号・対象年月・業者名・棟・日付別の請求人工・合計8・未入力は「未入力」（合計に入れない）・稼働人数の列は無い", bt.text.includes("照合の確認現場") && bt.text.includes("K-2026-16") && bt.text.includes("2026年10月") && bt.text.includes("株式会社イズミ足場") && bt.text.includes("TB号棟") && /未入力/.test(bt.text) && sheets.b.total === "8" && sheets.b.blank === 1 && !/<th>稼働人数<\/th>/.test(sheets.b.html) && bt.outside === 0 && bt.over.length === 0, bt.text.slice(0, 300) + JSON.stringify(bt.over));
  check("22. 請求人工PDFに日報上の表記（3つの名前）を注記", /日報上の業者名の表記: .*（株）イズミ足場/.test(bt.text));
  const at = (await sheetText(page, sheets.a.html))[0];
  check("23. 業者別稼働PDF（別のファイル名「株式会社イズミ足場_2026年10月_業者別稼働.pdf」）: 延べ10人・実稼働人日10・稼働2日・職種別・作業内容・請求人工の列は無い", sheets.a.file === "株式会社イズミ足場_2026年10月_業者別稼働.pdf" && sheets.a.workers === 10 && sheets.a.manDays === 10 && sheets.a.days === 2 && at.text.includes("職種別の稼働人数") && at.text.includes("足場の作業") && !/<th>請求人工<\/th>/.test(sheets.a.html) && at.outside === 0 && at.over.length === 0, at.text.slice(0, 300) + JSON.stringify(at.over));

  // ===== PDF: 全業者（まとめて）=====
  await page.selectOption(".vm-pdf-vendor-select", "");
  await page.click('.vm-pdf-btn[data-pdf="activity"]'); await waitPdf(page);
  const st2 = await page.textContent("#boardPdfStatus");
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 2);
  const sh2 = await page.evaluate(() => window.__shared[1].map((f) => ({ name: f.name, type: f.type, b64: f.b64 })));
  const allA4 = (await Promise.all(sh2.map((f) => pdfInfo(page, f.b64)))).every((ps) => ps.length >= 1 && ps.every(([w, h]) => w === 842 && h === 595));
  check("24. 業者別稼働PDF（全業者）: 業者ごとに1ファイル（4社: アオバ・イズミ・ウエノ・キタノ）を共有にまとめて渡す・すべて A4横（業者別稼働は横のまま）", sh2.length === 4 && sh2.every((f) => f.name.endsWith("_2026年10月_業者別稼働.pdf")) && allA4 && /4件/.test(st2), `${st2} ${sh2.map((f) => f.name).join(",")}`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#boardPdfSaveBtn")]);
  const zp = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(zp);
  const zipEntries = await page.evaluate(async (b64) => { const { loadZip, readZipEntryBytes } = await import("/js/zipUtil.js"); const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const z = loadZip(u.buffer); const out = {}; for (const name of z.entries.keys()) { const b = await readZipEntryBytes(z, name); let t = ""; for (let i = 0; i < b.length; i++) t += String.fromCharCode(b[i]); out[name] = btoa(t); } return out; }, fs.readFileSync(zp).toString("base64"));
  const zipNames = Object.keys(zipEntries);
  check("25. ［ZIPで保存］: 4つのPDFを入れたZIP（業者別稼働_2026年10月_4社.zip）", (await page.textContent("#boardPdfSaveBtn")) === "ZIPで保存" && dl.suggestedFilename() === "業者別稼働_2026年10月_4社.zip" && zipNames.length === 4, zipNames.join(","));
  check("25b. ZIPの中身は［共有］に渡した個別PDFと同じ（ファイル名・中身がバイト単位で一致・対象年月 2026年10月）", sh2.every((f) => zipEntries[f.name] === f.b64 && f.name.includes("_2026年10月_")) && zipNames.every((n) => sh2.some((f) => f.name === n)), zipNames.join(","));
  await page.click("#boardPdfCloseBtn");
  await page.click('.vm-pdf-btn[data-pdf="billing"]'); await waitPdf(page);
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 3);
  const sh3 = await page.evaluate(() => window.__shared[2].map((f) => f.name));
  check("26. 請求人工PDF（全業者）は業者別稼働PDFとは別のファイル（…_請求人工.pdf ×4。請求人工が無く稼働だけのキタノ土建は「未入力」の明細）", sh3.length === 4 && sh3.every((n) => n.endsWith("_請求人工.pdf")) && sh3.some((n) => n.startsWith("キタノ土建")), sh3.join(","));
  await page.click("#boardPdfCloseBtn");
  // 照合表のPDF
  await page.click('.vm-pdf-btn[data-pdf="reconcile"]'); await waitPdf(page);
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 4);
  const sh4 = await page.evaluate(() => window.__shared[3][0]);
  fs.writeFileSync(path.join(OUT, sh4.name), Buffer.from(sh4.b64, "base64"));
  await page.click("#boardPdfCloseBtn");
  const rcHtml = await page.evaluate(async ([s, m]) => { const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const rc = await import("/js/billing/billingReconcile.js"); const v = await import("/js/billing/vendorMonthSheets.js"); const site = await getSite(s); const reports = await listReportsBySite(s); return v.buildReconcileSheetHtml({ site, reconciliation: rc.buildReconciliation({ site, reports, month: m, today: "2026-11-16", view: "vendor" }) }); }, [ids.a, MONTH]);
  const rt = await sheetText(page, rcHtml);
  check("27. 照合表PDF: 合計（22・19.5・-2.5）・差異・未入力のある日の明細・A4横", sh4.name === "請求人工実稼働照合表_照合の確認現場_2026年10月.pdf" && rt.map((x) => x.text).join(" ").includes("-2.5") && rt.map((x) => x.text).join(" ").includes("差異・未入力のある日") && rt.every((x) => x.outside === 0 && x.over.length === 0) && (await pdfInfo(page, sh4.b64)).every(([w, h]) => w === 842 && h === 595), JSON.stringify(rt.map((x) => x.over)));

  // ===== 複数ページ（純粋関数・架空の大きな月）=====
  const big = await page.evaluate(async () => {
    const v = await import("/js/billing/vendorMonthSheets.js");
    const site = { name: "複数ページの確認現場", constructionNumber: "", startDate: "2026-09-01", buildings: [{ id: "b1", name: "TC号棟" }] };
    const reports = Array.from({ length: 28 }, (_, i) => ({ id: `r${i}`, date: `2026-10-${String(i + 1).padStart(2, "0")}`, dayStatus: "work", companies: [
      { companyId: `c${i}a`, buildingId: "b1", buildingName: "TC号棟", companyName: "クスノキ設備", occupation: "設備", actualWorkerCount: "2", billingManDays: i % 9 === 4 ? "" : "2", workContent: "配管の作業（長い説明の作業内容をここに書きます。2行に収まるように小さくします）" },
      { companyId: `c${i}b`, buildingId: "", buildingName: "", companyName: "クスノキ設備", occupation: "電気", actualWorkerCount: "1", billingManDays: "1.25", workContent: "配線" }] }));
    const vs = v.monthVendors({ site, reports, month: "2026-10", today: "2026-11-16" });
    const b = v.buildVendorBillingSheet({ site, reports, month: "2026-10", today: "2026-11-16", vendorId: vs[0].vendorId });
    const a = v.buildVendorActivitySheet({ site, reports, month: "2026-10", today: "2026-11-16", vendorId: vs[0].vendorId });
    // 割り付けの決まり: 45行＋合計
    const pages = v.paginateBlocks([{ title: "t", cols: [{ label: "x" }], rows: Array.from({ length: 45 }, () => ({ cells: ["a"] })), total: { cells: ["合計"] } }]);
    return { b: b.html, a: a.html, bTotal: b.total, bBlank: b.blank, pages: pages.map((p) => p.map((f) => [f.rows.length, !!f.total])) };
  });
  const bs = await sheetText(page, big.b), as = await sheetText(page, big.a);
  const pageOk = (ss) => ss.length > 1 && ss.every((s, i) => s.text.includes("複数ページの確認現場") && s.thead >= 1 && s.text.includes(`${i + 1}／${ss.length}ページ`) && s.outside === 0 && s.over.length === 0);
  const lastFrag = big.pages[big.pages.length - 1].find((f) => f[1]);
  check("28. 複数ページ: どのページにも工事名・帳票名・表の見出し・n／総ページ数、紙面からはみ出さない（請求人工 " + bs.length + "ページ（A4縦・56行）・業者別稼働 " + as.length + "ページ（A4横））", pageOk(bs) && pageOk(as) && bs.every((s) => s.text.includes("請求人工 月間明細")) && bs.length >= 2 && big.b.includes("size: A4 portrait") && big.a.includes("size: A4 landscape"), JSON.stringify(bs.map((s) => s.over).concat(as.map((s) => s.over))));
  check("29. 合計の行は、その表の最後の行と同じページ（合計だけが次のページに離れない）・請求人工の合計 82（2×25＋1.25×28）・未入力3件", lastFrag && lastFrag[0] >= 1 && bs.some((s) => s.total >= 1 && s.rowsBeforeTotal >= 1) && big.bTotal === "85" && big.bBlank === 3, JSON.stringify({ pages: big.pages, t: big.bTotal, b: big.bBlank }));

  // ===== 確認結果の解除・別の業者 =====
  await openVm(page, ids.a, "names");
  await page.click('.vm-unmerge[data-name="イズミ足場"]'); await page.waitForTimeout(500);
  r = await rcOf(page, ids.a, { view: "vendor" });
  check("30. まとめから外すと、その名前はまた確認待ち（株式会社イズミ足場＋（株）イズミ足場は同じ業者のまま）", r.pending.length === 2 && find(r, "イズミ足場").st === "業者名確認待ち" && find(r, "株式会社イズミ足場").w === 8, JSON.stringify(r.pending));
  await page.click(".vm-distinct-pair >> nth=0"); await page.waitForTimeout(400);
  await page.click(".vm-distinct-pair >> nth=0"); await page.waitForTimeout(400);
  r = await rcOf(page, ids.a, { view: "vendor" });
  check("31. 「別の業者」と記録すると確認待ちから外れ、単独の業者として照合（イズミ足場: 実稼働2・請求 未入力 → 未照合）", r.pending.length === 0 && find(r, "イズミ足場").st === "未照合", JSON.stringify(r.rows.map((x) => x.k + ":" + x.st)));
  await page.click(".vm-undistinct >> nth=0"); await page.waitForTimeout(400);
  r = await rcOf(page, ids.a, { view: "vendor" });
  check("32. 「別の業者」の記録を取り消すと、また確認待ち", r.pending.length === 1);

  // ===== 追加確認（2026-11-16。統合→解除の再計算・表示名・棟の合計・未確認の業者・データ不変）=====
  const calcAll = (siteId) => page.evaluate(async ([s, m]) => {
    const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js");
    const rc = await import("/js/billing/billingReconcile.js"); const vn = await import("/js/billing/vendorNames.js"); const v = await import("/js/billing/vendorMonthSheets.js");
    const site = await getSite(s); const reports = await listReportsBySite(s);
    const pending = vn.pendingNameSet(vn.vendorNameCandidates({ site, names: vn.collectVendorNames({ site, reports }) }));
    const views = {}; for (const view of ["vendor", "building", "vendorBuilding"]) { const r = rc.buildReconciliation({ site, reports, month: m, today: "2026-11-16", view, pendingNames: pending }); views[view] = { totals: r.totals, rows: r.rows.map((x) => ({ vendorId: x.vendorId, vendorName: x.vendorName, b: x.buildingLabel, m: x.manDays, c: x.billingCents, st: x.state, names: x.rawNames })) }; }
    const vendors = v.monthVendors({ site, reports, month: m, today: "2026-11-16" });
    const sheets = vendors.map((x) => { const b = v.buildVendorBillingSheet({ site, reports, month: m, today: "2026-11-16", vendorId: x.vendorId }); const a = v.buildVendorActivitySheet({ site, reports, month: m, today: "2026-11-16", vendorId: x.vendorId }); return { name: x.vendorName, names: x.names, bFile: b.fileName, bTotal: b.total, aFile: a.fileName, aWorkers: a.workers, bNames: b.names }; });
    return { views, vendors: vendors.map((x) => x.vendorName), sheets, reportNames: reports.filter((r) => !r.isDeleted).flatMap((r) => r.companies.map((c) => c.companyName)).sort() };
  }, [siteId, MONTH]);
  const izName = (x) => /イズミ/.test(x.name || x.vendorName);
  // 1. 3つの表記を統合 → 照合・PDF・業者の一覧が1業者 → 解除 → 3業者に戻り、合計は同じ
  for (const n of ["株式会社イズミ足場", "（株）イズミ足場", "イズミ足場"]) await page.check(`.vm-name-pick[value="${n}"]`);
  await page.click(".vm-merge-picked"); await page.waitForTimeout(500);
  const merged = await calcAll(ids.a);
  const mIz = merged.sheets.filter(izName);
  check("44. 統合後: 照合表・業者の一覧・請求人工PDF・業者別稼働PDF がイズミ1業者（請求人工8・延べ10人）", merged.vendors.filter((n) => /イズミ/.test(n)).length === 1 && mIz.length === 1 && mIz[0].bTotal === "8" && mIz[0].aWorkers === 10 && mIz[0].bNames.length === 3 && merged.views.vendor.rows.filter(izName).length === 1, JSON.stringify(mIz));
  await page.click('.vm-unmerge[data-name="イズミ足場"]'); await page.waitForTimeout(400);
  await page.click('.vm-unmerge[data-name="（株）イズミ足場"]'); await page.waitForTimeout(400);
  const split = await calcAll(ids.a);
  const sIz = split.sheets.filter(izName);
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
  check("45. 解除後: 3業者に戻り（グループは無くなる）、PDFは表記ごとに別ファイル（4・4・未入力）、3つの合計＝統合時の合計（請求8・延べ10人）・照合表の合計も同じ", sIz.length === 3 && sIz.every((x) => x.bNames.length === 1) && sum(sIz, (x) => Number(x.bTotal)) === 8 && sum(sIz, (x) => x.aWorkers) === 10 && split.views.vendor.rows.filter(izName).length === 3 && JSON.stringify(split.views.vendor.totals) === JSON.stringify(merged.views.vendor.totals) && (await page.evaluate(async (s) => ((await (await import("/js/sites.js")).getSite(s)).vendorDirectory?.groups || []).length, ids.a)) === 0, JSON.stringify(sIz.map((x) => [x.name, x.bTotal, x.aWorkers])));
  // 2. 表示名を変えても日報の業者名は変わらない
  for (const n of ["株式会社イズミ足場", "（株）イズミ足場", "イズミ足場"]) await page.check(`.vm-name-pick[value="${n}"]`);
  await page.click(".vm-merge-picked"); await page.waitForTimeout(500);
  await page.selectOption(".vm-group-disp", "イズミ足場"); await page.waitForTimeout(500);
  const renamed = await calcAll(ids.a);
  check("46. 表示名を「イズミ足場」に変えると照合表・PDF（ファイル名）はその名前になり、日報に保存された3つの業者名はそのまま", renamed.views.vendor.rows.find(izName)?.vendorName === "イズミ足場" && renamed.sheets.find(izName)?.bFile === "イズミ足場_2026年10月_請求人工.pdf" && JSON.stringify(renamed.reportNames) === JSON.stringify(merged.reportNames) && renamed.reportNames.includes("株式会社イズミ足場") && renamed.reportNames.includes("（株）イズミ足場"), JSON.stringify(renamed.reportNames));
  // 3. 業者別の値＝その業者の棟別の合計、どの単位でも合計は同じ
  const vb = renamed.views.vendorBuilding, vv = renamed.views.vendor, bb = renamed.views.building;
  const perVendorOk = vv.rows.every((r) => { const parts = vb.rows.filter((x) => x.vendorId === r.vendorId); return sum(parts, (x) => x.m) === r.m && sum(parts, (x) => x.c) === r.c; });
  check("47. 業者別（全棟の合計）＝業者・棟別の合計（実稼働人日・請求人工とも、全業者で）・棟別の合計＝全体の合計・3つの単位の合計が一致", perVendorOk && sum(bb.rows, (x) => x.m) === vv.totals.manDays && sum(bb.rows, (x) => x.c) === vv.totals.billingCents && JSON.stringify(vb.totals) === JSON.stringify(vv.totals) && JSON.stringify(bb.totals) === JSON.stringify(vv.totals), JSON.stringify([vv.totals, vb.totals, bb.totals]));
  // 4. 未確認（確認待ち）の業者名を別の業者と照合しない（純粋関数。架空の名前）
  const pure = await page.evaluate(async () => {
    const rc = await import("/js/billing/billingReconcile.js"); const vn = await import("/js/billing/vendorNames.js");
    const site = { name: "x", startDate: "2026-10-01", buildings: [] };
    const reports = [{ id: "r", date: "2026-10-01", dayStatus: "work", companies: [
      { companyId: "1", companyName: "イズミ足場", occupation: "足場", actualWorkerCount: "2", billingManDays: "2" },
      { companyId: "2", companyName: "イズミ建設", occupation: "足場", actualWorkerCount: "3", billingManDays: "" },
      { companyId: "3", companyName: "株式会社イズミ足場", occupation: "足場", actualWorkerCount: "1", billingManDays: "1" }] }];
    const names = vn.collectVendorNames({ site, reports }); const cand = vn.vendorNameCandidates({ site, names });
    const r = rc.buildReconciliation({ site, reports, month: "2026-10", today: "2026-11-16", pendingNames: vn.pendingNameSet(cand) });
    const resolve = vn.vendorResolver(site);
    return { pending: cand.pending.map((p) => [p.a, p.b, p.level]), rows: r.rows.map((x) => [x.vendorName, x.manDays, x.billing, x.stateLabel]), ids: new Set(["イズミ足場", "イズミ建設", "株式会社イズミ足場"].map((n) => resolve(n).id)).size };
  });
  check("48. 似た名前（イズミ足場・イズミ建設・株式会社イズミ足場）は候補に出るだけで、確認前は3つとも別の業者として数え、互いの請求人工・人数を混ぜない（業者名確認待ち）", pure.ids === 3 && pure.rows.length === 3 && pure.rows.every((x) => x[3] === "業者名確認待ち") && JSON.stringify(pure.rows.find((x) => x[0] === "イズミ建設")) === JSON.stringify(["イズミ建設", 3, null, "業者名確認待ち"]) && pure.pending.length >= 2, JSON.stringify(pure));
  // 5. 個別PDFと全業者（ZIP）の内容・ファイル名・対象年月が一致（請求人工）
  await openVm(page, ids.a, "reconcile");
  await page.selectOption(".vm-pdf-vendor-select", { label: "イズミ足場" });
  await page.click('.vm-pdf-btn[data-pdf="billing"]'); await waitPdf(page);
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 5);
  await page.click("#boardPdfCloseBtn");
  await page.selectOption(".vm-pdf-vendor-select", "");
  await page.click('.vm-pdf-btn[data-pdf="billing"]'); await waitPdf(page);
  await page.click("#boardPdfShareBtn"); await page.waitForFunction(() => window.__shared.length === 6);
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#boardPdfSaveBtn")]);
  const zp2 = path.join(OUT, dl2.suggestedFilename()); await dl2.saveAs(zp2);
  await page.click("#boardPdfCloseBtn");
  const cmp = await page.evaluate(async (b64) => {
    const { loadZip, readZipEntryBytes } = await import("/js/zipUtil.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const z = loadZip(u.buffer);
    const zipFiles = {}; for (const name of z.entries.keys()) { const b = await readZipEntryBytes(z, name); let t = ""; for (let i = 0; i < b.length; i++) t += String.fromCharCode(b[i]); zipFiles[name] = btoa(t); }
    const single = window.__shared[4][0], all = window.__shared[5];
    const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const pages = async (x) => { const bb = atob(x); const uu = new Uint8Array(bb.length); for (let i = 0; i < bb.length; i++) uu[i] = bb.charCodeAt(i); return (await pdfjs.getDocument({ data: uu }).promise).numPages; };
    const inAll = all.find((f) => f.name === single.name);
    return { zipName: null, singleName: single.name, allNames: all.map((f) => f.name), zipNames: Object.keys(zipFiles), sameAsZip: all.every((f) => zipFiles[f.name] === f.b64), inAll: !!inAll, sizeNear: inAll ? Math.abs(inAll.size - single.size) < single.size * 0.02 : false, pagesSame: inAll ? (await pages(inAll.b64)) === (await pages(single.b64)) : false };
  }, fs.readFileSync(zp2).toString("base64"));
  check("49. 個別PDF（イズミ足場_2026年10月_請求人工.pdf）は全業者出力の中の同じ名前のファイルと同じ内容（ページ数が同じ・大きさがほぼ同じ。作成時刻だけ違う）・ZIPの中身は共有した全業者のPDFとバイト単位で一致・ファイル名の対象年月は 2026年10月", cmp.singleName === "イズミ足場_2026年10月_請求人工.pdf" && cmp.inAll && cmp.pagesSame && cmp.sizeNear && cmp.sameAsZip && cmp.zipNames.length === cmp.allNames.length && cmp.allNames.every((n) => n.includes("_2026年10月_請求人工.pdf")) && dl2.suggestedFilename() === "請求人工_2026年10月_4社.zip", JSON.stringify(cmp));
  // 6. 照合・PDFの計算で日報・請求人工を変えない（計算の前後で日報が同じ）
  const before6 = await snap(page);
  await calcAll(ids.a);
  await page.click('.vm-pdf-btn[data-pdf="reconcile"]'); await waitPdf(page); await page.click("#boardPdfCloseBtn");
  check("50. 照合表・PDFの作成の前後で日報（業者名・人数・請求人工・更新日時）が同じ＝元の日報を変えずに算出", (await snap(page)) === before6);
  // 元の状態（表示名・まとめ）に戻す（後の検査の期待値のため）
  await openVm(page, ids.a, "names");
  await page.selectOption(".vm-group-disp", "株式会社イズミ足場"); await page.waitForTimeout(400);
  await page.click('.vm-unmerge[data-name="イズミ足場"]'); await page.waitForTimeout(400);

  // ===== 棟の無い現場 =====
  r = await rcOf(page, ids.b, { view: "vendorBuilding" });
  check("33. 棟の無い現場: 棟で分けずに業者ごと（オリーブ警備 2・2 一致、カエデ美装工業 1・0.75 差異 -0.25）", r.usesBuildings === false && r.view === "vendor" && find(r, "オリーブ警備").st === "一致" && find(r, "カエデ美装工業").diff === "-0.25" && !r.rows.some((x) => x.k.includes("棟")), JSON.stringify(r.rows));
  await openVm(page, ids.b, "reconcile");
  const ui3 = await page.evaluate(() => ({ views: document.querySelectorAll(".vm-rc-view").length, text: document.getElementById("vendorMgmtBody").innerText }));
  check("34. 棟の無い現場の照合の画面: 単位の切り替えを出さず「棟を使わない設定」と表示", ui3.views === 0 && ui3.text.includes("棟を使わない設定"));
  const bsheet = await page.evaluate(async ([s, m]) => { const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const v = await import("/js/billing/vendorMonthSheets.js"); const site = await getSite(s); const reports = await listReportsBySite(s); const vs = v.monthVendors({ site, reports, month: m, today: "2026-11-16" }); return v.buildVendorBillingSheet({ site, reports, month: m, today: "2026-11-16", vendorId: vs[0].vendorId }).html; }, [ids.b, MONTH]);
  check("35. 棟の無い現場の請求人工PDFに棟の欄を出さない", !bsheet.includes("<th>棟</th>") && !bsheet.includes("棟別"));
  // 日報画面: 棟の欄（棟の無い現場は出さない、棟を使う現場は出す）
  await page.goto(`${BASE}#/sites/${ids.b}/report/${ids.rb}`); await page.waitForSelector(".company-row"); await page.waitForTimeout(600);
  const hideB = await page.$$eval(".company-row .buildingId", (ss) => ss.map((s) => s.closest("label").hidden));
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/sites/${ids.a}/report/new?date=2026-10-20`); await page.waitForSelector(".company-row .buildingId"); await page.waitForTimeout(400);
  const showA = await page.$eval(".company-row .buildingId", (s) => !s.closest("label").hidden);
  check("36. 日報画面: 棟の無い現場は作業行に棟の欄を出さない・棟を使う現場は出す（入力の順・ほかの欄はそのまま）", hideB.length === 2 && hideB.every(Boolean) && showA, JSON.stringify({ hideB, showA }));
  // 棟の無い現場で日報を保存できる（棟なしのまま）
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/sites/${ids.b}/report/${ids.rb}`); await page.waitForSelector(".company-row"); await page.waitForTimeout(500);
  await page.click("#reportSaveBtn"); await page.waitForTimeout(1200);
  const savedB = await page.evaluate(async (id) => (await (await import("/js/reports.js")).getReport(id)).companies.map((c) => [c.companyName, c.buildingId, c.actualWorkerCount, c.billingManDays].join(",")), ids.rb);
  check("37. 棟の無い現場の日報を保存しても、業者・人数・請求人工は変わらず棟は空のまま", JSON.stringify(savedB) === JSON.stringify(["オリーブ警備,,2,2", "カエデ美装工業,,1,0.75"]), JSON.stringify(savedB));
  // 棟の使用設定を「使う」にすると、棟の無い作業行は棟未設定（入力漏れ）と区別して出る
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/sites/${ids.b}/edit`); await page.waitForSelector(".use-buildings-cb"); await page.waitForTimeout(400);
  const cb0 = await page.isChecked(".use-buildings-cb");
  await page.check(".use-buildings-cb"); await page.waitForTimeout(600);
  r = await rcOf(page, ids.b, { view: "vendorBuilding" });
  check("38. 現場の編集で「この現場で棟を使用する」にすると、棟の無い作業行は「棟未設定」（棟の無い現場のときは出ない）", cb0 === false && r.usesBuildings === true && r.rows.every((x) => x.st === "棟未設定"), JSON.stringify(r.rows.map((x) => x.k + ":" + x.st)));
  await page.uncheck(".use-buildings-cb"); await page.waitForTimeout(600);
  r = await rcOf(page, ids.b, { view: "vendorBuilding" });
  check("39. 「使用しない」に戻すと、また棟で分けない", r.usesBuildings === false && find(r, "オリーブ警備").st === "一致");

  // ===== 既存の集計・データ =====
  const actAfter = await page.evaluate(async (s) => { const { listReportsBySite } = await import("/js/reports.js"); const m = await import("/js/billing/billingMonthly.js"); const r = await listReportsBySite(s); return JSON.stringify([m.buildVendorActivity({ reports: r, month: "2026-10", today: "2026-11-16", startDate: "2026-09-01" }), m.buildMonthlyBilling({ reports: r, month: "2026-10", today: "2026-11-16" })]); }, ids.a);
  check("40. 既存の業者別稼働・請求人工管理の集計は変わらない（業者名ごとのまま）", actAfter === actBefore);
  const afterSnap = JSON.parse(await snap(page)).filter(([id]) => id !== ids.rb);
  check("41. 照合・PDF・業者名の確認で日報は書き換えない（業者名・人数・請求人工・更新日時）", JSON.stringify(afterSnap) === JSON.stringify(JSON.parse(before).filter(([id]) => id !== ids.rb)));
  check("42. ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });

  // ===== iPad の縦・横（WebKit）=====
  for (const [label, vp] of [["縦", { width: 820, height: 1180 }], ["横", { width: 1180, height: 820 }]]) {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-reconcile-wk-"));
    const c2 = await webkit.launchPersistentContext(d2, { viewport: vp, deviceScaleFactor: 2, hasTouch: true });
    await c2.addInitScript(SHARE_STUB);
    const p2 = await c2.newPage(); p2.on("dialog", (d) => d.accept());
    await p2.goto(BASE); await p2.waitForSelector("#view-site-list:not([hidden])");
    const i2 = await seed(p2);
    await openVm(p2, i2.a, "reconcile");
    const lay = await p2.evaluate(() => { const bs = [...document.querySelectorAll(".vm-pdf-btn, .vm-rc-view, [data-vm-tab]")].map((b) => b.getBoundingClientRect()); return { minH: Math.min(...bs.map((b) => b.height)), out: bs.filter((b) => b.right > window.innerWidth + 0.5).length, overflow: document.documentElement.scrollWidth - window.innerWidth }; });
    await p2.tap('.vm-pdf-btn[data-pdf="billing"]'); await waitPdf(p2);
    const st = await p2.evaluate(() => ({ status: document.getElementById("boardPdfStatus").textContent, preview: document.getElementById("boardPdfPreview").naturalWidth, inside: (() => { const d = document.getElementById("boardPdfDialog").getBoundingClientRect(); return d.left >= 0 && d.right <= window.innerWidth; })() }));
    await p2.tap("#boardPdfShareBtn"); await p2.waitForFunction(() => window.__shared.length > 0);
    const n = await p2.evaluate(() => window.__shared[0].length);
    await p2.tap("#boardPdfCloseBtn"); await p2.waitForFunction(() => !document.getElementById("boardPdfDialog").open);
    await openVm(p2, i2.a, "names");
    const lay2 = await p2.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, minH: Math.min(...[...document.querySelectorAll(".vm-merge-pair, .vm-distinct-pair")].map((b) => b.getBoundingClientRect().height)) }));
    check(`43. iPad ${label}（WebKit）: ボタンは44px以上で画面内・横スクロールなし・全業者の請求人工PDF（6件＝確認前の表記ごと）を作成して共有に渡す・業者名の確認の画面`, lay.minH >= 44 && lay.out === 0 && lay.overflow <= 0 && /作成しました: 6件/.test(st.status) && st.preview > 0 && st.inside && n === 6 && lay2.overflow <= 0 && lay2.minH >= 44, JSON.stringify({ lay, st, n, lay2 }));
    await c2.close(); fs.rmSync(d2, { recursive: true, force: true });
  }

  console.log(`PDF: ${OUT}`);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
