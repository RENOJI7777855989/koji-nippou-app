// 日報の紛失防止／再出力管理の検証（実ブラウザ・実IndexedDB・実際の会社指定Excel様式）
// 使う様式: 03-2安全衛生作業打合日誌（A3横）。原本は読み取りのみ（SHA-256で不変を確認）
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/report-reprint.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const TEMPLATE = ORIGINAL_TEMPLATE;
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "report-reprint-test");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  if (!fs.existsSync(TEMPLATE)) { console.log("会社指定様式が見つかりません: " + TEMPLATE); process.exit(2); }
  const templateBytes = fs.readFileSync(TEMPLATE);
  const H0 = sha(templateBytes);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  // 実際の印刷ダイアログはテストでは開けないため、印刷プレビュー内の print() の呼び出しだけを数える
  await page.addInitScript(() => { window.__printCalls = 0; });
  const stubPrint = () => page.evaluate(() => { for (const f of document.querySelectorAll("iframe")) { try { f.contentWindow.print = () => { window.__printCalls++; }; } catch {} } });

  await page.goto(BASE);
  await page.waitForSelector("#view-site-list:not([hidden])");
  // 新規端末の初回起動で自動登録される同梱の標準テンプレート（クリーンな03-2）を取り除き、
  // このテストで登録する会社様式（原本）だけで検証する（同梱の検証は tests/bundled-template.js）
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length > 0, null, { timeout: 2000 }).catch(() => {});
  await page.evaluate(async () => { const { dbDelete, dbGetAll } = await import("/js/db.js"); for (const t of await dbGetAll("reportTemplates")) await dbDelete("reportTemplates", t.id); });
  const dbAll = (s) => page.evaluate(async (s) => (await (await import("/js/db.js")).dbGetAll(s)).filter((r) => !r.isDeleted), s);
  const reportOf = (id) => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), id);

  // ---- 準備: 現場（元請名＝会社プロファイル名）と会社指定Excel様式の登録（帳票テンプレート管理画面と同じデータ層）----
  const siteId = await page.evaluate(async ({ b64 }) => {
    const { createSite } = await import("/js/sites.js");
    const { createCompanyProfile } = await import("/js/report-output/companyProfiles.js");
    const { createReportTemplate } = await import("/js/report-output/reportTemplates.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const company = await createCompanyProfile({ name: "テスト元請建設" });
    await createReportTemplate({ companyProfileId: company.id, format: "excel", name: "安全衛生作業打合日誌", rendererId: "xlsx-template-patch", sourceFileBlob: new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), sourceFileName: "03-2安全衛生作業打合日誌.xlsx", sourceFileMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
    return (await createSite({ name: "紛失防止テスト現場", clientName: "テスト元請建設", startDate: d(6), endDate: d(-30) })).id;
  }, { b64: templateBytes.toString("base64") });

  // ===== 1. 日報を入力して保存 =====
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.click("#newReportBtn"); await page.waitForSelector("#view-report-form:not([hidden])");
  const today = await page.inputValue("#date");
  await page.selectOption("#weather", "曇り");
  await page.fill("#temperature", "23");
  const row = page.locator(".company-row").first();
  await row.locator(".companyName").fill("山田足場工業");
  await row.locator(".occupation").fill("とび工");
  await row.locator(".plannedWorkerCount").fill("5");
  await row.locator(".actualWorkerCount").fill("4");
  await row.locator(".workContent").fill("外部足場組立");
  await page.fill("#tomorrowPlan", "足場解体");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const saved = (await dbAll("reports"))[0];
  const localToday = await page.evaluate(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; });
  check("1 日報を入力して保存できる（日付の初期値は端末の今日）", !!saved && saved.date === today && today === localToday && saved.companies[0].companyName === "山田足場工業" && String(saved.temperature).includes("23"), JSON.stringify(saved && [saved.date, today, localToday, saved.temperature, saved.companies[0].companyName]));
  const card = await page.textContent("#reportList .report-card");
  check("2(一覧) 日報一覧に 日付・入力状態・印刷状態（未印刷）が表示される", card.includes(today) && card.includes("入力済み・未確認") && card.includes("未印刷"), card.replace(/\s+/g, " ").slice(0, 120));

  // ===== 2. Excelへ正しく反映 =====
  await page.locator("#reportList .report-card").first().click(); await page.waitForSelector("#reportOutputPanel:not([hidden])");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#reportExcelBtn")]);
  const xlsxPath = path.join(OUT, "report.xlsx"); await dl.saveAs(xlsxPath);
  const parsed = await page.evaluate(async (b64) => {
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const zip = loadZip(bytes.buffer);
    const sheet = await readZipEntryText(zip, "xl/worksheets/sheet1.xml");
    const cell = (ref) => { const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet); if (!m) return null; const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[1] || ""); const v = /<v>([\s\S]*?)<\/v>/.exec(m[1] || ""); return t ? t[1] : v ? v[1] : ""; };
    return { E2: cell("E2"), M2: cell("M2"), M4: cell("M4"), A7: cell("A7"), B7: cell("B7"), C7: cell("C7"), D7: cell("D7"), E7: cell("E7"), pageSetup: /<pageSetup[^>]*>/.exec(sheet)?.[0] || "" };
  }, fs.readFileSync(xlsxPath).toString("base64"));
  check("2 Excel（会社指定様式の複製）に日報の内容が反映される（工事名・気温・天候・業者・職種・予定/実績人数・作業内容）",
    parsed.E2.includes("紛失防止テスト現場") && parsed.M2.includes("23") && parsed.M4.includes("曇り") && parsed.A7 === "山田足場工業" && parsed.B7 === "とび工" && parsed.C7 === "5" && parsed.D7 === "4" && parsed.E7 === "外部足場組立", JSON.stringify(parsed).slice(0, 220));
  check("8(A3) 出力Excelの用紙設定はA3横のまま（paperSize=8・landscape）", /paperSize="8"/.test(parsed.pageSetup) && /orientation="landscape"/.test(parsed.pageSetup), parsed.pageSetup);
  let r1 = await reportOf(saved.id);
  check("Excel出力で最終出力日時が記録され、印刷状態は変わらない（未印刷のまま）", !!r1.lastOutputAt && r1.lastOutputFormat === "excel" && (r1.printCount || 0) === 0);

  // ===== 3. PDF出力（会社指定様式のA3横レイアウト）=====
  await page.click("#reportPdfBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.innerText?.length > 0);
  const pdfHtml = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  check("3 PDF出力: 会社指定様式のレイアウト（A3横 420mm×297mm）で日報の内容を含む印刷用データが作られる", /@page \{ size: 420mm 297mm/.test(pdfHtml) && pdfHtml.includes("山田足場工業"), /@page[^;]*;/.exec(pdfHtml)?.[0]);
  // 実際にPDFファイルを生成できるか（印刷用HTMLをChromiumでPDF化し、用紙サイズをPDF内から読む）
  {
    fs.writeFileSync(path.join(OUT, "report.html"), pdfHtml);
    const p2 = await ctx.newPage();
    await p2.setContent(pdfHtml);
    const pdfBytes = await p2.pdf({ preferCSSPageSize: true });
    await p2.close();
    fs.writeFileSync(path.join(OUT, "report.pdf"), pdfBytes);
    const txt = Buffer.from(pdfBytes).toString("latin1");
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(txt);
    const w = box ? Number(box[1]) : 0, h = box ? Number(box[2]) : 0;
    check("3 実際にPDFファイルを生成できる（1ページ・A3横 1191×842pt）", txt.startsWith("%PDF") && (txt.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && Math.abs(w - 1190.55) < 3 && Math.abs(h - 841.89) < 3, `${w}x${h}pt`);
  }
  await stubPrint(); await page.click("#reportPrintOpenBtn");
  await page.click("#reportPrintCloseBtn");
  r1 = await reportOf(saved.id);
  check("3 PDF出力（印刷画面でPDFに保存）を開くと最終出力日時がPDFとして記録され、印刷状態は変わらない", r1.lastOutputFormat === "pdf" && (r1.printCount || 0) === 0 && (await page.evaluate(() => window.__printCalls)) === 1);

  // ===== 4・5. 印刷 → 印刷済み =====
  check("4(ボタン) 未印刷の日報のボタンは「印刷」", (await page.textContent("#reportPrintBtn")).trim() === "印刷");
  await page.click("#reportPrintBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.innerText?.length > 0);
  await stubPrint(); await page.click("#reportPrintOpenBtn");
  check("4 印刷: 印刷画面を開ける（print()が呼ばれる）・印刷できたかの確認が表示される", (await page.evaluate(() => window.__printCalls)) === 2 && (await page.isVisible("#reportPrintRecordArea")));
  await page.click("#reportPrintNotDoneBtn");
  r1 = await reportOf(saved.id);
  check("4 「印刷しなかった」を選ぶと記録しない（未印刷のまま）", (r1.printCount || 0) === 0);
  await page.click("#reportPrintOpenBtn"); await page.click("#reportPrintDoneBtn"); await page.waitForSelector("#reportPrintDialog:not([open])", { state: "attached" }); await page.waitForTimeout(200);
  r1 = await reportOf(saved.id);
  check("5 「紙に印刷できた」で印刷状態が「印刷済み」になり、最終印刷日時が記録される", r1.printStatus === "printed" && r1.printCount === 1 && !!r1.lastPrintedAt);
  check("5 画面の状態表示も「印刷済み」・ボタンは「再印刷」に変わる", (await page.textContent("#reportOutputStatus")).includes("印刷済み") && (await page.textContent("#reportPrintBtn")).trim() === "再印刷");

  // ===== 6・7. 再印刷 =====
  await page.click("#reportPrintBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.innerText?.length > 0);
  const reprintHtml = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  check("6 同じ日報を再印刷できる（前回と同じ内容の印刷用データ）", reprintHtml === pdfHtml);
  await stubPrint(); await page.click("#reportPrintOpenBtn"); await page.click("#reportPrintDoneBtn"); await page.waitForSelector("#reportPrintDialog:not([open])", { state: "attached" }); await page.waitForTimeout(200);
  r1 = await reportOf(saved.id);
  check("7 再印刷後に状態が「再印刷」になる（印刷2回）", r1.printStatus === "reprinted" && r1.printCount === 2);
  const hist = r1.outputHistory.map((h) => h.kind).join(",");
  check("出力履歴（Excel・PDF・印刷・再印刷）と変更履歴が残る", hist === "excel,pdf,print,print" && (await dbAll("auditLog")).some((a) => a.summary.includes("再印刷（2回目）")), hist);

  // ===== 8. 押しただけでは削除されない（2026-10-03 から日報を1件ずつ削除できる。確認ダイアログでキャンセルすれば残る）=====
  await page.click("#deleteReportBtn"); await page.waitForFunction(() => document.getElementById("reportDeleteDialog").open);
  await page.click("#reportDeleteCancelBtn");
  check("8 削除ボタンを押すと確認が出て、キャンセルすれば日報は残る", !(await page.evaluate(() => document.getElementById("reportDeleteDialog").open)) && !(await reportOf(saved.id)).isDeleted);
  const del = await page.evaluate(async (id) => { try { await (await import("/js/reports.js")).deleteReport(id); return "deleted"; } catch (e) { return e.message; } }, saved.id);
  check("8 通常の削除操作（データ層）でも削除できず、日報は残る", del.includes("削除できません") && !(await reportOf(saved.id)).isDeleted, del);

  // 修正（削除ではなく修正）→ 印刷後に修正あり
  await page.fill("#tomorrowPlan", "足場解体（修正）"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  check("修正は保存でき、一覧に「印刷後に修正あり」が表示される（紙が古い可能性）", (await page.textContent("#reportList")).includes("印刷後に修正あり"));

  // ===== 9. 過去の日報を開いて再出力 =====
  await page.selectOption("#reportListFilter", "missing"); await page.waitForTimeout(350);
  const missingN = await page.locator("#reportMissingList .report-missing-card").count();
  check("9(未入力) 「未入力（日報のない日）」で工期内の日報のない日が一覧できる", missingN === 6, `${missingN}日`);
  const pastDate = await page.locator("#reportMissingList .report-missing-card").last().getAttribute("data-date");
  await page.locator("#reportMissingList .report-missing-card").last().click(); await page.waitForSelector("#view-report-form:not([hidden])");
  check("9(未入力) 未入力の日を押すと、その日付で日報を作成できる", (await page.inputValue("#date")) === pastDate, pastDate);
  await page.locator(".company-row").first().locator(".companyName").fill("過去日の業者"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.selectOption("#reportListFilter", "unprinted"); await page.waitForTimeout(350);
  check("9(絞込) 「未印刷」で未印刷の日報だけが表示される", (await page.locator("#reportList .report-card").count()) === 1 && (await page.textContent("#reportList")).includes(pastDate));
  await page.selectOption("#reportListFilter", "reprinted"); await page.waitForTimeout(350);
  check("9(絞込) 「再印刷」で再印刷済みの日報だけが表示される", (await page.locator("#reportList .report-card").count()) === 1 && (await page.textContent("#reportList")).includes(today));
  await page.selectOption("#reportListFilter", "all"); await page.waitForTimeout(350); await page.fill("#reportListSearch", pastDate); await page.waitForTimeout(350);
  await page.locator("#reportList .report-card").first().click(); await page.waitForSelector("#reportOutputPanel:not([hidden])");
  await page.click("#reportPrintBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.innerText?.length > 0);
  check("9 紛失時: 一覧で対象日を検索 → 日報を開く → 印刷で同じ帳票（過去日の内容）を出力できる", (await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc)).includes("過去日の業者"));
  await stubPrint(); await page.click("#reportPrintOpenBtn"); await page.click("#reportPrintDoneBtn"); await page.waitForSelector("#reportPrintDialog:not([open])", { state: "attached" }); await page.waitForTimeout(200);
  await page.click("#reportConfirmBtn"); await page.waitForFunction(() => document.getElementById("reportConfirmBtn").textContent.includes("解除"));
  await page.click("#backToSiteDetailBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.fill("#reportListSearch", ""); await page.waitForTimeout(350); await page.selectOption("#reportListFilter", "confirmed"); await page.waitForTimeout(350);
  check("9(絞込) 「確認済み」で確認済みの日報だけが表示される", (await page.locator("#reportList .report-card").count()) === 1 && (await page.textContent("#reportList")).includes("確認済み"), (await page.locator("#reportList .report-card").count()) + "件 " + (await page.textContent("#reportList")).replace(/\s+/g, " ").slice(0, 100));
  await page.selectOption("#reportListFilter", "all"); await page.waitForTimeout(350);

  // まとめて出力（工事期間中の日報）
  await page.click("#reportBulkPanel summary");
  const [zdl] = await Promise.all([page.waitForEvent("download"), page.click("#bulkExcelBtn")]);
  const zipPath = path.join(OUT, "bulk.zip"); await zdl.saveAs(zipPath);
  const zipNames = await page.evaluate(async (b64) => { const { loadZip } = await import("/js/zipUtil.js"); const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return [...loadZip(bytes.buffer).entries.keys()]; }, fs.readFileSync(zipPath).toString("base64"));
  check("10(一括) Excel一括出力: 表示中の日報2件が1つのZIPに入る（ファイル名は日付）", zipNames.length === 2 && zipNames.includes(`${pastDate}.xlsx`) && zipNames.includes(`${today}.xlsx`), zipNames.join(","));
  await page.click("#bulkPdfBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  const bulkHtml = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  check("10(一括) PDF一括出力: 2件が1日報1ページ（改ページ）で1つの印刷用データになり、A3横のまま", (bulkHtml.match(/class="bulk-report-page"/g) || []).length === 2 && (bulkHtml.match(/break-after: page/g) || []).length === 1 && /size: 420mm 297mm/.test(bulkHtml));
  {
    const p3 = await ctx.newPage();
    await p3.setContent(bulkHtml);
    const bytes = await p3.pdf({ preferCSSPageSize: true }); await p3.close();
    const txt = Buffer.from(bytes).toString("latin1");
    check("10(一括) PDF一括出力を実際にPDF化すると、2日報＝2ページ（各ページA3横）になる", (txt.match(/\/Type\s*\/Page[^s]/g) || []).length === 2, (txt.match(/\/Type\s*\/Page[^s]/g) || []).length + "ページ");
  }
  await page.click("#reportPrintCloseBtn");

  // ===== 10. 工事完了 → 確定・アーカイブ後も検索・閲覧・再出力 =====
  await page.click("#completeSiteBtn"); await page.waitForTimeout(500);
  const reps = await dbAll("reports");
  check("10 工事完了で全日報が確定される・日報の追加ボタンが消える", reps.every((r) => !!r.finalizedAt) && !(await page.isVisible("#newReportBtn")) && (await page.isVisible("#siteCompletedNotice")));
  await page.locator("#reportList .report-card").first().click(); await page.waitForSelector("#reportOutputPanel:not([hidden])");
  check("10 確定後の日報は閲覧のみ（保存ボタン非表示・入力欄が無効）で、再出力のボタンは使える", !(await page.isVisible("#reportSaveBtn")) && (await page.isDisabled("#tomorrowPlan")) && (await page.isEnabled("#reportPrintBtn")) && (await page.isEnabled("#reportExcelBtn")));
  const upd = await page.evaluate(async (id) => { try { await (await import("/js/reports.js")).updateReport(id, { remarks: "x" }); return "updated"; } catch (e) { return e.message; } }, saved.id);
  check("10 確定後はデータ層でも修正できない", upd.includes("確定済み"), upd);
  await page.click("#backToSiteDetailBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.click("#toggleArchiveBtn"); await page.waitForTimeout(300);
  await page.click("#backToSiteListBtn"); await page.waitForSelector("#view-site-list:not([hidden])");
  const hiddenByDefault = !(await page.textContent("#siteList")).includes("紛失防止テスト現場");
  await page.check("#showArchivedCheckbox"); await page.fill("#siteSearchInput", "紛失防止").catch(() => {});
  await page.waitForTimeout(300);
  check("10 アーカイブ後は一覧に既定で出ず、「アーカイブ済みを表示」＋検索で見つかる（工事完了の表示付き）", hiddenByDefault && (await page.textContent("#siteList")).includes("紛失防止テスト現場") && (await page.textContent("#siteList")).includes("工事完了"));
  await page.locator(".site-card", { hasText: "紛失防止テスト現場" }).click(); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.waitForSelector("#reportList .report-card");
  await page.fill("#reportListSearch", "過去日の業者"); await page.waitForTimeout(350);
  check("10 工事完了・アーカイブ後も日報を検索できる（業者名で検索）", (await page.locator("#reportList .report-card").count()) === 1);
  await page.locator("#reportList .report-card").first().click(); await page.waitForSelector("#reportOutputPanel:not([hidden])");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#reportExcelBtn")]);
  await dl2.saveAs(path.join(OUT, "after-complete.xlsx"));
  await page.click("#reportPrintBtn"); await page.waitForSelector("#reportPrintDialog[open]");
  await page.waitForFunction(() => document.getElementById("reportPrintFrame").contentDocument?.body?.innerText?.length > 0);
  await stubPrint(); await page.click("#reportPrintOpenBtn"); await page.click("#reportPrintDoneBtn"); await page.waitForSelector("#reportPrintDialog:not([open])", { state: "attached" }); await page.waitForTimeout(200);
  const after = (await dbAll("reports")).find((r) => r.companies[0].companyName === "過去日の業者");
  check("10 工事完了・アーカイブ後も閲覧・Excel再出力・再印刷ができ、再印刷として記録される", fs.statSync(path.join(OUT, "after-complete.xlsx")).size > 10000 && after.printStatus === "reprinted");
  check("10 完成工事の日報は削除されない（日報2件のまま）", (await dbAll("reports")).length === 2);

  // ===== 11. 会社指定Excel書式が変更されていない =====
  const dbTemplateSha = await page.evaluate(async () => { const t = (await (await import("/js/db.js")).dbGetAll("reportTemplates"))[0]; const buf = await t.sourceFileBlob.arrayBuffer(); const d = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); });
  check("11 会社指定Excel様式の原本ファイル・アプリ内の様式データとも変更されていない（SHA-256一致）", sha(fs.readFileSync(TEMPLATE)) === H0 && dbTemplateSha === H0, H0.slice(0, 16));
  const partsSame = await page.evaluate(async ({ tpl, out }) => {
    const { loadZip, readZipEntryBytes } = await import("/js/zipUtil.js");
    const dec = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return loadZip(u.buffer); };
    const a = dec(tpl), b = dec(out);
    const changed = [];
    for (const name of a.entries.keys()) { const x = await readZipEntryBytes(a, name), y = await readZipEntryBytes(b, name); if (!y || x.length !== y.length || x.some((v, i) => v !== y[i])) changed.push(name); }
    return changed;
  }, { tpl: templateBytes.toString("base64"), out: fs.readFileSync(xlsxPath).toString("base64") });
  // 他工事データ除去（台帳シート・保存先パス・外部リンク・参照されない共有文字列は出力の複製から外す）ため、それらのパートは原本と一致しない。
  // 書式(styles)・テーマ・記入する様式シートの図形と印刷設定は原本のまま。
  const untouched = ["xl/styles.xml", "xl/theme/theme1.xml", "xl/drawings/drawing1.xml", "xl/printerSettings/printerSettings1.bin", "xl/media/image1.jpg"];
  check("11 出力Excelで、書式(styles)・テーマ・記入シートの図形と印刷設定は原本のまま（変わるのは記入シート・ブック構成・他工事データの除去だけ）", untouched.every((n) => !partsSame.includes(n)), partsSame.filter((n) => untouched.includes(n)).join(","));

  // ===== 画面幅（iPad・スマホ・Windows）でページ全体が横にはみ出さない =====
  for (const [label, vp] of [["スマホ375", { width: 375, height: 800 }], ["iPad820", { width: 820, height: 1180 }], ["Windows1366", { width: 1366, height: 768 }]]) {
    await page.setViewportSize(vp);
    await page.goto(BASE + "#/sites/" + siteId); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(400);
    const o1 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await page.locator("#reportList .report-card").first().click(); await page.waitForSelector("#reportOutputPanel:not([hidden])"); await page.waitForTimeout(300);
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`画面幅${label}: 現場詳細・日報画面でページ全体が横にはみ出さない`, o1 <= 0 && o2 <= 0, `詳細${o1}px／日報${o2}px`);
  }
  check("コンソールエラー0件", errors.length === 0, errors.join(" | ").slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n合計 ${results.length}件中 失敗 ${failed}件`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
