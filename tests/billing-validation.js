// 請求人工の入力の決まり（js/billing/billingValue.js）を、日報画面・請求人工入力の画面・保存処理（reports.js）で確かめる（架空データ・Chromium）。
//   ・空欄＝未入力、0＝0人工。0以上・小数2桁まで。マイナス・-0・指数表記（1e2）・小数3桁（1.333）は保存しない（別の数に変えない）
//   ・保存処理でも検査する。前から保存されている値は、変えていなければ、ほかの項目の保存を止めない（既存の値を自動で直さない）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-valid-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // ===== 共通の決まり =====
  const table = await page.evaluate(async () => {
    const { parseBillingInput } = await import("/js/billing/billingValue.js");
    const cases = ["", "  ", "0", "2", "2.5", "3.75", "2.50", "007", ".5", "２．５", "1e2", "1E2", "1.333", "-1", "-0", "1.", "abc", "1,5", "+1", "Infinity", "0x10", " 3 "];
    return cases.map((c) => [c, parseBillingInput(c)]);
  });
  const want = { "": "", "  ": "", "0": "0", "2": "2", "2.5": "2.5", "3.75": "3.75", "2.50": "2.5", "007": "7", ".5": "0.5", "２．５": "2.5", " 3 ": "3" };
  const bad = table.filter(([c, r]) => (c in want ? r?.value !== want[c] : r !== null));
  check("決まり: 空欄＝未入力・0・整数・小数2桁まで（全角も読む）は正しい値、1e2・1E2・1.333・-1・-0・1.・abc・1,5・+1・Infinity・0x10 は誤り（null）", bad.length === 0, bad.map(([c, r]) => `${c}→${JSON.stringify(r)}`).join(" / "));

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "入力検査の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const c = (id, name, billing) => ({ companyId: id, companyName: name, occupation: "塗装", actualWorkerCount: "3", billingManDays: billing });
    const mk = async (date, companies) => { const r = stampNew({ siteId: site.id, date, dayStatus: "work", siteSupervisorNames: [], companies }); await dbPut("reports", r); return r.id; };
    return { siteId: site.id, r1: await mk("2026-09-10", [c("a", "甲工業", "")]), legacy: await mk("2026-09-11", [c("x", "旧データ工業", "1.333"), c("y", "乙工業", "")]) };
  });
  const get = (id) => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), id);

  // ===== 日報画面 =====
  const openForm = async (id) => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${ids.siteId}/report/${id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300); };
  await openForm(ids.r1);
  check("日報画面の請求人工欄は小数2桁の刻み（step 0.01）", (await page.getAttribute(".company-row .billingManDays", "step")) === "0.01");
  for (const v of ["1e2", "1.333", "-1", "-0"]) {
    await page.locator(".company-row .billingManDays").first().fill(v);
    await page.click("#reportSaveBtn"); await page.waitForTimeout(400);
    const stillForm = await page.isVisible("#view-report-form");
    const saved = (await get(ids.r1)).companies[0].billingManDays;
    check(`日報画面: 「${v}」は保存しない（画面に残り、保存値は未入力のまま）`, stillForm && saved === "", `保存値 ${JSON.stringify(saved)}`);
  }
  await page.locator(".company-row .billingManDays").first().fill("2.50");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(300);
  check("日報画面: 正しい値（2.50）は数の形（2.5）で保存", (await get(ids.r1)).companies[0].billingManDays === "2.5");
  await openForm(ids.r1);
  await page.locator(".company-row .billingManDays").first().fill("0");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(300);
  check("日報画面: 0 は0人工として保存（未入力とは別）", (await get(ids.r1)).companies[0].billingManDays === "0");
  await openForm(ids.r1);
  await page.locator(".company-row .billingManDays").first().fill("");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(300);
  check("日報画面: 空欄は未入力（\"\"）として保存（0にしない）", (await get(ids.r1)).companies[0].billingManDays === "");

  // ===== 保存処理（reports.js）=====
  const dl = await page.evaluate(async ([r1, legacy]) => {
    const { updateReport, createReport, getReport } = await import("/js/reports.js");
    const out = {};
    const base = await getReport(r1);
    for (const v of ["1e2", "1.333", "-0", "abc"]) {
      try { await updateReport(r1, { companies: base.companies.map((c) => ({ ...c, billingManDays: v })) }); out[v] = "保存された"; } catch (e) { out[v] = e.message.includes("請求人工") ? "止めた" : `別のエラー ${e.message}`; }
    }
    try { await createReport({ siteId: base.siteId, date: "2026-09-12", companies: [{ companyId: "n", companyName: "新規工業", billingManDays: "1e2" }] }); out.create = "保存された"; } catch (e) { out.create = e.message.includes("請求人工") ? "止めた" : `別のエラー ${e.message}`; }
    // 前から保存されている誤った値（1.333）は、変えていなければほかの項目の保存を止めない
    const lg = await getReport(legacy);
    try { await updateReport(legacy, { companies: lg.companies.map((c) => c.companyId === "y" ? { ...c, billingManDays: "2" } : c), remarks: "連絡事項を変更" }); out.legacyOther = "保存できた"; } catch (e) { out.legacyOther = `止まった ${e.message}`; }
    try { await updateReport(legacy, { companies: lg.companies.map((c) => c.companyId === "x" ? { ...c, billingManDays: "1.3333" } : c) }); out.legacyChangeBad = "保存された"; } catch (e) { out.legacyChangeBad = "止めた"; }
    const after = await getReport(legacy);
    out.legacyValue = after.companies.map((c) => c.billingManDays).join(",");
    out.r1Value = (await getReport(r1)).companies[0].billingManDays;
    return out;
  }, [ids.r1, ids.legacy]);
  check("保存処理: 1e2・1.333・-0・abc は updateReport でも保存しない", ["1e2", "1.333", "-0", "abc"].every((v) => dl[v] === "止めた") && dl.r1Value === "", JSON.stringify(dl));
  check("保存処理: createReport でも誤った請求人工は保存しない", dl.create === "止めた", dl.create);
  check("前から保存されている値（1.333）は自動で直さず、変えていなければほかの業者・項目の保存を止めない（乙工業=2・連絡事項は保存）", dl.legacyOther === "保存できた" && dl.legacyValue === "1.333,2" && (await get(ids.legacy)).remarks === "連絡事項を変更", JSON.stringify(dl));
  check("前から保存されている値を別の誤った値（1.3333）に変えることはできない", dl.legacyChangeBad === "止めた");

  // 日報画面でも、前から保存されている 1.333 の行を変えずにほかの項目を直すと保存できる（1.333 は自動で直さない）
  await openForm(ids.legacy);
  await page.fill("#remarks", "日報画面から連絡事項を変更");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(300);
  const lg2 = await get(ids.legacy);
  check("日報画面: 前から保存されている 1.333 を変えずにほかの項目を直すと保存でき、1.333 はそのまま残る", lg2.remarks === "日報画面から連絡事項を変更" && lg2.companies[0].billingManDays === "1.333", lg2.companies.map((c) => c.billingManDays).join(","));
  await openForm(ids.legacy);
  await page.locator(".company-row .billingManDays").first().fill("1.3333");
  await page.click("#reportSaveBtn"); await page.waitForTimeout(400);
  check("日報画面: 前から保存されている値を別の誤った値（1.3333）に変えると保存しない", (await page.isVisible("#view-report-form")) && (await get(ids.legacy)).companies[0].billingManDays === "1.333");

  // ===== 同じ日に日報が複数ある場合（集計は従来どおり合算・重複の可能性を示すだけ）=====
  const multi = await page.evaluate(async () => {
    const { buildMonthlyBilling } = await import("/js/billing/billingMonthly.js");
    const c = (n, b) => ({ companyId: n + b, companyName: n, occupation: "塗装", billingManDays: b });
    const reports = [
      { id: "r1", date: "2026-09-10", companies: [c("甲工業", "2")] },
      { id: "r2", date: "2026-09-10", companies: [c("甲工業", "1.5")] },
      { id: "r3", date: "2026-09-11", companies: [c("甲工業", "1"), c("乙工業", "3")] },
      { id: "r4", date: "2026-09-12", companies: [c("乙工業", "1")] }, { id: "r5", date: "2026-09-12", companies: [c("丙工業", "")] }
    ];
    const m = buildMonthlyBilling({ reports, site: null, month: "2026-09", today: "2026-10-17" });
    return { rows: m.rows.map((r) => `${r.vendor}=${r.manDays}:${r.multiReportDates.join("/")}`), sameDay: m.sameDayReportDates };
  });
  check("同じ日に日報が2件: 月間請求人工は従来どおり両方を合算（甲工業 2+1.5+1=4.5）し、その日を「同じ日に日報が複数」として示す（乙工業は別々の日報の別の業者なので示さない）", multi.rows.join(",") === "乙工業=4:,甲工業=4.5:2026-09-10" && multi.sameDay.join(",") === "2026-09-10,2026-09-12", JSON.stringify(multi));

  // ===== 請求人工入力の画面（同じ決まり）=====
  await page.goto(`${BASE}#/sites/${ids.siteId}/vendors`); await page.waitForSelector("#view-vendor-management:not([hidden])"); await page.waitForTimeout(300);
  await page.selectOption("#vendorMgmtMonth", "2026-09"); await page.waitForTimeout(300);
  await page.click("#vendorMgmtBillingInputBtn"); await page.waitForFunction(() => document.getElementById("billingDialog").open);
  await page.fill("#billingDate", "2026-09-10"); await page.dispatchEvent("#billingDate", "change"); await page.waitForTimeout(300);
  const states = [];
  for (const v of ["1e2", "1.333", "-0", "-1"]) { await page.locator("#billingDay .billing-value").first().fill(v); states.push(await page.textContent("#billingDay .billing-state")); }
  await page.click("#billingSaveBtn"); await page.waitForTimeout(400);
  check("請求人工入力の画面: 1e2・1.333・-0・-1 は誤りと表示し、保存しない", states.every((t) => t.includes("2桁")) && (await get(ids.r1)).companies[0].billingManDays === "", states.join(" / "));
  // 前から保存されている 1.333 の日（9/11）は、その行を直すまで保存できないことを表示する（自動で直さない）
  await page.fill("#billingDate", "2026-09-11"); await page.dispatchEvent("#billingDate", "change"); await page.waitForTimeout(300);
  const legacyShown = await page.$$eval("#billingDay .billing-row", (rs) => rs.map((r) => `${r.querySelector(".chorei-vendor").textContent}:${r.querySelector(".billing-value").value}:${r.dataset.state}`).join(","));
  check("請求人工入力の画面: 前から保存されている 1.333 はそのまま表示し、誤りとして示す（自動で直さない）", legacyShown.startsWith("旧データ工業:1.333:error"), legacyShown);
  await page.click("#billingCloseBtn");

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
