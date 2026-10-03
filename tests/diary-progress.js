// 進捗率を日誌ごとに記録する変更の検証（実ブラウザ・実IndexedDB・画面操作。データは架空）
//   1〜5 新しい日誌に40%を入力→保存→開き直すと40%
//   6〜8 別の日の日誌に45%→ダッシュボードは45%・過去の日誌は40%のまま・進捗の推移
//   9 進捗率が未入力の日誌: 保存できる・「進捗率が未入力です」と出る・ダッシュボードは過去の値を使わず「未入力」
//   不正な値（150・-1・12.5）は保存できない
//   現場に以前入力した進捗率は、現場情報の編集・保存でも消えない（画面では入力しない）
//   10 Excel・PDF（印刷用ページ）・A3シート・バックアップと復元
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/diary-progress.js（鍵ファイルが必要）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-progress-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  // 以前の版で現場に進捗率（62%）を入力していた現場を再現する
  const siteId = await page.evaluate(async (start) => {
    const { createSite } = await import("/js/sites.js");
    return (await createSite({ name: "進捗率の確認現場", startDate: start, progressPercent: 62 })).id;
  }, day(-5));

  const writeDiary = async (date, progress, company) => {
    await page.goto(`${BASE}#/sites/${siteId}/report/new?date=${date}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
    if (progress !== null) await page.fill("#progressPercent", String(progress));
    await page.locator(".company-row .companyName").first().fill(company); await page.locator(".company-row .actualWorkerCount").first().fill("3");
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
    return page.evaluate(async ({ sid, date }) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === date), { sid: siteId, date });
  };

  // 入力欄の場所（日付のすぐ隣）
  await page.goto(`${BASE}#/sites/${siteId}/report/new?date=${day(-2)}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const place = await page.evaluate(() => { const d = document.getElementById("date").closest("label"); const p = document.getElementById("progressPercent").closest("label"); return { next: d.nextElementSibling === p, label: p.firstChild.textContent.trim(), hint: document.getElementById("progressPercentHint").textContent }; });
  check("入力欄: 日誌の日付のすぐ隣に「進捗率（％）」があり、空欄なら「進捗率が未入力です」と出る", place.next && place.label === "進捗率（％）" && place.hint.startsWith("進捗率が未入力です"), place.hint);

  // 不正な値は保存できない
  for (const bad of ["150", "-1", "12.5"]) {
    await page.fill("#progressPercent", bad);
    await page.click("#reportSaveBtn"); await page.waitForTimeout(300);
    const still = await page.isVisible("#view-report-form");
    const msg = await page.textContent("#message");
    check(`不正な値（${bad}）は保存できず、理由が表示される`, still && msg.includes("0〜100の整数"), msg.slice(0, 40));
  }

  // 1〜5
  const r40 = await writeDiary(day(-2), 40, "サンプル工業");
  check("1〜3 新しい日誌に40%を入力して保存（日誌に progressPercent=40）", r40?.progressPercent === 40);
  await page.goto(`${BASE}#/sites/${siteId}/report/${r40.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  check("4〜5 日誌を開き直すと40%が入っている", (await page.inputValue("#progressPercent")) === "40");

  // 6〜8
  const r45 = await writeDiary(day(-1), 45, "サンプル工業");
  check("6 別の日の日誌に45%を保存", r45?.progressPercent === 45);
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard .dash-nav[data-shift='-1']"); await page.waitForTimeout(500);
  const dash45 = (await page.textContent("#siteDashboard")).replace(/\s+/g, " ");
  check("7 ダッシュボード（45%の日）は「進捗 45%」・進捗の推移 40%→45%", dash45.includes("進捗 45%") && /進捗の推移: .*40% → .*45%/.test(dash45), (dash45.match(/進捗[^工]{0,40}/g) || []).join(" | "));
  await page.goto(`${BASE}#/sites/${siteId}/report/${r40.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const hint40 = await page.textContent("#progressPercentHint");
  check("8 過去の日誌（40%の日）は40%のまま", (await page.inputValue("#progressPercent")) === "40" && (await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).progressPercent, r40.id)) === 40, hint40);

  // 9 未入力の日誌
  const r0 = await writeDiary(day(0), null, "サンプル工業");
  const msg = await page.textContent("#message");
  check("9 進捗率が未入力の日誌も保存でき、保存時に「進捗率が未入力です」と出る（null で保存）", r0 && r0.progressPercent === null && msg.includes("進捗率が未入力です"), msg);
  await page.goto(`${BASE}#/sites/${siteId}/report/${r0.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const hint0 = await page.textContent("#progressPercentHint");
  check("9 未入力の日誌を開くと「進捗率が未入力です（前回の日誌は45%）」と出る（自動では入れない）", (await page.inputValue("#progressPercent")) === "" && hint0.includes("進捗率が未入力です") && hint0.includes("45%"), hint0);
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard .dash-nav[data-today]"); await page.waitForTimeout(500);
  const dash0 = (await page.textContent("#siteDashboard")).replace(/\s+/g, " ");
  check("9 一番新しい日誌が未入力なら、ダッシュボードは過去の値（45%）を使わず「進捗 未入力」", dash0.includes("進捗 未入力") && !dash0.includes("進捗 45%"), (dash0.match(/進捗 [^工]{0,20}/) || [""])[0]);
  const card = await page.$$eval("#reportList .report-card-meta", (els) => els.map((e) => e.textContent));
  check("日報一覧に日付ごとの進捗率（40%・45%・未入力）が出る", card.some((t) => t.includes("進捗 40%")) && card.some((t) => t.includes("進捗 45%")) && card.some((t) => t.includes("進捗 未入力")), card.join(" / "));

  // 現場に以前入力した進捗率は消えない
  await page.goto(`${BASE}#/sites/${siteId}/edit`); await page.waitForSelector("#view-site-form:not([hidden])"); await page.waitForTimeout(800);
  const formInfo = await page.evaluate(() => ({ input: !!document.getElementById("siteFormProgressPercent"), note: document.getElementById("siteFormProgressNote").textContent }));
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const legacy = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).progressPercent, siteId);
  check("現場情報の編集には進捗率の入力欄が無く、日誌で入力する説明と以前の値（62%）が表示される", !formInfo.input && formInfo.note.includes("日誌ごとに入力") && formInfo.note.includes("62%"), formInfo.note);
  check("現場情報を保存しても、以前の進捗率（62%）は消えない", legacy === 62);
  check("ダッシュボードは現場の以前の進捗率（62%）を使わない", !dash0.includes("62%"));

  // 10 Excel・PDF・A3・バックアップ
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), r45.id)]);
  const xf = path.join(dir, "x.xlsx"); await dl.saveAs(xf);
  check("10 Excel出力（03-2）できる", fs.readFileSync(xf).subarray(0, 2).toString() === "PK");
  const html = await page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, r45.id);
  const p2 = await ctx.newPage(); await p2.setContent(html); await p2.waitForTimeout(300);
  const pdf = Buffer.from(await p2.pdf({ preferCSSPageSize: true })).toString("latin1"); await p2.close();
  check("10 PDF・印刷用ページ（03-2）はA3横・1ページ", (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf));
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard .dash-nav[data-today]"); await page.waitForTimeout(300);
  await page.click("#siteDashboard .dash-nav[data-shift='-1']"); await page.waitForTimeout(400);
  await page.click("#siteDashboard [data-action=print]"); await page.waitForSelector("#reportPrintDialog[open]");
  const a3 = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  check("10 A3「今日の現場シート」に日誌の進捗率（45%）が出る", a3.includes('<span class="bl">進捗</span><span class="bv">45%</span>') && a3.includes("size: A3 landscape"));
  await page.click("#reportPrintCloseBtn");
  const [bdl] = await Promise.all([page.waitForEvent("download"), page.goto(`${BASE}#/backup`).then(() => page.waitForSelector("#view-backup:not([hidden])")).then(() => page.click("#exportBackupBtn"))]);
  const bf = path.join(dir, "backup.zip"); await bdl.saveAs(bf);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "diary-progress-restore-"));
  const ctx2 = await chromium.launchPersistentContext(dir2, {}); const q = await ctx2.newPage(); q.on("dialog", (d) => d.accept());
  await q.goto(BASE); await q.waitForSelector("#view-site-list:not([hidden])");
  await q.goto(`${BASE}#/backup`); await q.waitForSelector("#view-backup:not([hidden])"); await q.setInputFiles("#restoreFileInput", bf);
  await waitForAsync(q, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length === 3, null, { timeout: 20000 });
  const restored = await q.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).map((r) => r.progressPercent).sort().join(","));
  const restoredSite = await q.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("sites"))[0].progressPercent);
  check("10 バックアップ→別の環境に復元しても、日誌ごとの進捗率（40・45・未入力）と現場の以前の値（62）が残る", restored === "40,45," && restoredSite === 62, `${restored} / 現場 ${restoredSite}`);
  await ctx2.close(); fs.rmSync(dir2, { recursive: true, force: true });

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
