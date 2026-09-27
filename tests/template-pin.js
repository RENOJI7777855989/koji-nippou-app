// 現場ごとのテンプレート版の固定の検証（実ブラウザ・実IndexedDB・同梱のクリーンな03-2）
//  ① 現場Aを第1版で作成 ② 03-2を第2版へ更新 ③ Aは第1版のまま ④⑤ 新規現場Bは第2版
//  ⑥ Aの日報の再出力は第1版 ⑦ Aを手動で第2版へ ⑧ Aを第1版へ戻す ⑨ 使用中の版は削除できない
//  ⑩ 400日工事の台帳を固定した版で全期間生成 ＋ 既存現場の移行・自動整理で使用中の版が残ること
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/template-pin.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { setupUrl, decryptBundled } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const ASSETS = path.join(__dirname, "..", "assets", "templates");
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const ORIGINAL = ORIGINAL_TEMPLATE;
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "template-pin-test");
fs.mkdirSync(OUT, { recursive: true });
const V2_MARK = "巡回点検記録（第2版）";

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const H0 = fs.existsSync(ORIGINAL) ? sha(fs.readFileSync(ORIGINAL)) : null;
  const bundle = decryptBundled(); // 同梱は暗号化済み。比較用にメモリ上で復号する
  const HB = sha(bundle);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

  // 同梱の標準テンプレート（暗号化）は、セットアップリンクを開いた端末に登録される
  await page.goto(setupUrl(BASE));
  await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 20000 });
  const STD = "bundled-anzen-eisei-03-2";

  // 第2版のファイル（同梱のクリーン版の複製の固定文言を1か所変える。原本・同梱ファイルは変更しない）
  const v2b64 = await page.evaluate(async ({ b64, mark }) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer);
    pkg.setText("xl/sharedStrings.xml", (await pkg.getText("xl/sharedStrings.xml")).replace("巡回点検記録", mark));
    const buf = new Uint8Array(await (await pkg.toCompressedBlob()).arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { b64: bundle.toString("base64"), mark: V2_MARK });
  const v2File = path.join(OUT, "03-2_v2.xlsx"); fs.writeFileSync(v2File, Buffer.from(v2b64, "base64"));
  const HV2 = sha(fs.readFileSync(v2File));

  const db = (fn, arg) => page.evaluate(fn, arg);
  const siteByName = (name) => db(async (name) => (await (await import("/js/db.js")).dbGetAll("sites")).find((s) => s.name === name), name);
  const templateRec = (id) => db(async (id) => (await import("/js/db.js")).dbGet("reportTemplates", id), id);
  // 出力.xlsxの「版」を判定（第2版は固定文言に印がある）
  const versionOf = async (file) => db(async (b64) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer);
    const sst = await pkg.getText("xl/sharedStrings.xml");
    const sheets = await pkg.listSheets();
    const first = await pkg.getText(sheets[0].path);
    return { v: sst.includes("巡回点検記録（第2版）") ? 2 : sst.includes("巡回点検記録") ? 1 : 0, sheets: sheets.map((s) => s.name), pageSetup: /<pageSetup\b[^>]*>/.exec(first)?.[0] || "" };
  }, fs.readFileSync(file).toString("base64"));
  const exportDay = async (reportId, name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), db(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), reportId)]);
    const f = path.join(OUT, name); await dl.saveAs(f); return versionOf(f);
  };
  const printHtmlHasV2 = (reportId) => db(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html.includes("巡回点検記録（第2版）"), reportId);
  const openSite = async (id) => { await page.goto(`${BASE}#/sites/${id}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForFunction(() => !/確認中/.test(document.getElementById("siteDetailReportTemplate").textContent)); };
  const createSiteUi = async (name, start, end) => {
    await page.goto(`${BASE}#/sites/new`); await page.waitForSelector("#view-site-form:not([hidden])");
    await page.fill("#siteFormName", name); await page.fill("#siteFormStartDate", start); await page.fill("#siteFormEndDate", end);
    await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
    return siteByName(name);
  };
  const addReports = (siteId, start, days, step) => db(async ({ siteId, start, days, step }) => {
    const { createReport } = await import("/js/reports.js"); const ids = [];
    for (let d = 0; d < days; d += step) {
      const date = new Date(Date.parse(start + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
      ids.push((await createReport({ siteId, date, weather: "晴れ", temperature: "20", siteSupervisorNames: ["監督A"], companies: [{ companyId: "c", companyName: "固定確認工業", occupation: "とび", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: "作業" + date, safetyNotes: "" }] })).id);
    }
    return ids;
  }, { siteId, start, days, step });

  // ===== ① 現場Aを第1版で作成（400日工事）=====
  const std1 = await templateRec(STD);
  const siteA = await createSiteUi("現場A（第1版で開始）", "2026-04-01", "2027-05-05"); // 400日
  check("① 現場Aは作成時に標準テンプレートの第1版に固定される（テンプレートid・版・SHA-256を記録）", siteA.templatePin?.templateId === STD && siteA.templatePin.revision === 1 && siteA.templatePin.sha256 === HB && siteA.templatePin.sha256 === std1.sourceFileSha256, JSON.stringify(siteA.templatePin));
  await openSite(siteA.id);
  const infoA1 = await page.textContent("#siteDetailReportTemplate");
  check("4 現場詳細に使用中のテンプレート名・版番号・SHA-256が表示される", infoA1.includes("03-2 安全衛生作業打合日誌") && infoA1.includes("第1版") && infoA1.includes("この現場に固定") && infoA1.includes(HB.slice(0, 16)), infoA1.replace(/\s+/g, " "));
  const reportsA = await addReports(siteA.id, "2026-04-01", 400, 5); // 80件
  const rA = reportsA[1];
  const outA0 = await exportDay(rA, "A_v1_before.xlsx");
  check("① 現場Aの出力は第1版", outA0.v === 1);

  // ===== ② 03-2を第2版へ更新（テンプレート管理画面から差し替え）=====
  await page.goto(`${BASE}#/report-templates`); await page.waitForSelector("#view-report-templates:not([hidden])");
  await page.locator(`li[data-template-id="${STD}"] .editReportTemplateBtn`).click(); await page.waitForSelector("#reportTemplateFormDialog[open]");
  await page.setInputFiles("#reportTemplateFile", v2File);
  await page.waitForFunction(() => document.querySelectorAll("#reportTemplateInspectList li").length > 0);
  await page.click("#reportTemplateSaveBtn"); await page.waitForSelector("#reportTemplateFormDialog:not([open])", { state: "attached" });
  const std2 = await templateRec(STD);
  check("② 標準テンプレートが第2版に更新された（同じid・標準のまま）", std2.revision === 2 && std2.isAppDefault && std2.sourceFileSha256 === HV2);

  // ===== ③ 現場Aは第1版のまま =====
  const siteA2 = await siteByName(siteA.name);
  check("③ 現場Aの固定は第1版のまま（自動で第2版にならない）", siteA2.templatePin.revision === 1 && siteA2.templatePin.sha256 === HB);
  await openSite(siteA.id);
  const infoA2 = await page.textContent("#siteDetailReportTemplate");
  check("③ 現場詳細: 第1版を使用中・最新は第2版・切り替えボタンが表示される", infoA2.includes("第1版") && infoA2.includes("最新は第2版") && (await page.locator("#siteTemplateUpgradeBtn").count()) === 1, infoA2.replace(/\s+/g, " ").slice(0, 120));

  // ===== ④⑤ 現場Bを新規作成 → 第2版 =====
  const siteB = await createSiteUi("現場B（第2版で開始）", "2026-10-01", "2026-10-31");
  check("⑤ 新規現場Bは第2版に固定される", siteB.templatePin?.templateId === STD && siteB.templatePin.revision === 2 && siteB.templatePin.sha256 === HV2, JSON.stringify(siteB.templatePin));
  const [rB] = await addReports(siteB.id, "2026-10-01", 1, 1);
  const outB = await exportDay(rB, "B_v2.xlsx");
  check("⑤ 現場Bの出力は第2版", outB.v === 2);

  // ===== ⑥ 現場Aの日報を再出力 → 第1版 =====
  const outA1 = await exportDay(rA, "A_reexport.xlsx");
  const htmlA = await printHtmlHasV2(rA);
  const outA1b = await exportDay(reportsA[70], "A_reexport_late.xlsx");
  check("⑥ 更新後に現場Aの過去の日報を再出力しても第1版（Excel）", outA1.v === 1 && outA1b.v === 1, `${outA1.v}/${outA1b.v}`);
  check("⑥ 現場Aの再印刷・PDF（会社様式の印刷用データ）も第1版", htmlA === false);
  check("⑥ A3横の印刷設定は維持", /paperSize="8"/.test(outA1.pageSetup) && /orientation="landscape"/.test(outA1.pageSetup), outA1.pageSetup);

  // ===== ⑩ 400日工事の台帳を固定版（第1版）で全期間生成 =====
  await openSite(siteA.id);
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  const [dlL] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click("#ledgerExcelBtn")]);
  const ledgerFile = path.join(OUT, "A_ledger_400days.xlsx"); await dlL.saveAs(ledgerFile);
  const lg = await versionOf(ledgerFile);
  const lgPages = await db(async (b64) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const { parseSharedStringsXml, readSheetCells } = await import("/js/report-output/ledger/sheetCells.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer); const sheets = await pkg.listSheets();
    const ss = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
    const last = readSheetCells(await pkg.getText(sheets[sheets.length - 1].path), ss);
    const wb = await pkg.getText("xl/workbook.xml");
    return { lastG4: last.get("G" + (4 + 19 * 52))?.value, lastE7: last.get("E" + (7 + 19 * 52))?.value, area: [...wb.matchAll(/Print_Area" localSheetId="\d+">([^<]*)</g)].map((m) => m[1]).slice(-1)[0] };
  }, fs.readFileSync(ledgerFile).toString("base64"));
  const serial = (d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000);
  check("⑩ 400日工事の台帳を第1版で全期間生成（20シート・最終日2027-05-05が400頁目・第2版の文言なし）", lg.v === 1 && lg.sheets.length === 20 && lg.sheets[19] === "381～400" && Number(lgPages.lastG4) === serial("2027-05-05"), `${lg.sheets.length}シート 最後=${lg.sheets[19]} G4=${lgPages.lastG4} ${lgPages.area}`);
  check("⑩ 180日を超えて追加したシートも第1版の構造・A3横", /paperSize="8"/.test(lg.pageSetup) && /landscape/.test(lg.pageSetup));

  // ===== ⑦ 現場Aを手動で第2版へ（違いを確認してから）=====
  dialogs.length = 0;
  await openSite(siteA.id);
  await page.click("#siteTemplateUpgradeBtn");
  await page.waitForFunction(() => document.getElementById("siteDetailReportTemplate").textContent.includes("第2版") && !document.getElementById("siteDetailReportTemplate").textContent.includes("最新は"));
  check("⑦ 切り替え前に、旧版と新版の違い（固定文言）が確認ダイアログに表示される", dialogs.some((m) => m.includes("第1版から第2版") && m.includes("巡回点検記録") && m.includes("第2版）")), (dialogs[0] || "").replace(/\s+/g, " ").slice(0, 120));
  const siteA3 = await siteByName(siteA.name);
  const outA2 = await exportDay(rA, "A_after_upgrade.xlsx");
  check("⑦ 現場Aを手動で第2版に切り替えでき、以後の出力は第2版", siteA3.templatePin.revision === 2 && siteA3.templatePin.sha256 === HV2 && outA2.v === 2 && (siteA3.templatePinHistory || [])[0]?.sha256 === HB);
  const siteBafter = await siteByName(siteB.name);
  check("⑦ 現場Aの切り替えは他の現場（B）に影響しない", siteBafter.templatePin.sha256 === HV2);

  // ===== ⑧ 現場Aを第1版へ戻す =====
  await openSite(siteA.id);
  await page.click("#siteTemplateRevertBtn");
  await waitForAsync(page, async (name) => (await (await import("/js/db.js")).dbGetAll("sites")).find((s) => s.name === name)?.templatePin?.revision === 1, siteA.name);
  await page.waitForFunction(() => document.getElementById("siteDetailReportTemplate").textContent.includes("最新は第2版"));
  const siteA4 = await siteByName(siteA.name);
  const outA3 = await exportDay(rA, "A_after_revert.xlsx");
  check("⑧ 現場Aを第1版に戻せ、以後の出力は第1版（画面も第1版・最新は第2版の表示に戻る）", siteA4.templatePin.sha256 === HB && siteA4.templatePin.revision === 1 && outA3.v === 1, JSON.stringify([siteA4.templatePin.revision, outA3.v]));

  // ===== ⑨ 第1版を使用中の現場がある状態で削除できない =====
  await page.goto(`${BASE}#/report-templates`); await page.waitForSelector("#view-report-templates:not([hidden])");
  const itemText = await page.textContent(`li[data-template-id="${STD}"]`);
  check("⑨ テンプレート管理画面に使用中の現場数が表示される", /使用中の現場: 2件/.test(itemText), itemText.replace(/\s+/g, " ").match(/使用中の現場: \d+件/)?.[0]);
  await page.locator(`li[data-template-id="${STD}"] .showTemplateVersionsBtn`).click();
  await page.waitForSelector(`li[data-template-id="${STD}"] .report-template-versions:not([hidden])`);
  const verText = await page.textContent(`li[data-template-id="${STD}"] .report-template-versions`);
  check("⑨ 「前の版」に第1版と、その版を使用中の現場数（1件）が表示される", verText.includes("第1版") && verText.includes("この版を使用中の現場: 1件"), verText.replace(/\s+/g, " ").slice(0, 100));
  await page.locator(`li[data-template-id="${STD}"] .deleteReportTemplateBtn`).click();
  await page.waitForTimeout(400);
  const msg = await page.evaluate(() => document.getElementById("message")?.textContent || "");
  const afterDel = await templateRec(STD);
  const v1Archive = await db(async ({ id, sha }) => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).find((t) => t.archivedOf === id && t.sourceFileSha256 === sha && !t.isDeleted), { id: STD, sha: HB });
  check("⑨ 使用中のテンプレート（第1版を含む）は削除できず、理由（使用中の現場）が表示される", !afterDel.isDeleted && !!v1Archive && msg.includes("使用中のため削除できません") && msg.includes("現場A"), msg.slice(0, 90));
  const delApi = await db(async (id) => { try { await (await import("/js/report-output/reportTemplates.js")).deleteReportTemplate(id); return "deleted"; } catch (e) { return e.message; } }, STD);
  check("⑨ データ層でも削除を拒否する（画面を経由しない場合も）", delApi.includes("使用中"), delApi.slice(0, 40));

  // ===== 8. 10版を超えて差し替えても、使用中の版（第1版）は自動整理で消えない =====
  const cleanup = await db(async ({ id, b64 }) => {
    const m = await import("/js/report-output/reportTemplates.js");
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    for (let n = 3; n <= 14; n++) {
      const pkg = await WorkbookPackage.open(u.buffer.slice(0));
      pkg.setText("docProps/core.xml", (await pkg.getText("docProps/core.xml")).replace("</cp:coreProperties>", `<dc:title>rev${n}</dc:title></cp:coreProperties>`));
      await m.replaceReportTemplateFile(id, { blob: await pkg.toCompressedBlob(), fileName: `rev${n}.xlsx` });
    }
    const all = (await (await import("/js/db.js")).dbGetAll("reportTemplates")).filter((t) => t.archivedOf === id);
    return { live: all.filter((t) => !t.isDeleted).map((t) => t.revision).sort((a, b) => a - b), deleted: all.filter((t) => t.isDeleted).map((t) => t.revision).sort((a, b) => a - b), current: (await m.getReportTemplate(id)).revision };
  }, { id: STD, b64: bundle.toString("base64") });
  check("8 10版を超えると古い版は自動整理されるが、使用中の第1版・第2版は残る", cleanup.current === 14 && cleanup.live.includes(1) && cleanup.live.includes(2) && cleanup.deleted.length > 0 && !cleanup.deleted.includes(1) && !cleanup.deleted.includes(2), JSON.stringify(cleanup));
  const outA4 = await exportDay(rA, "A_after_many.xlsx");
  const outB2 = await exportDay(rB, "B_after_many.xlsx");
  check("8 多数の差し替え後も現場Aは第1版・現場Bは第2版で出力される", outA4.v === 1 && outB2.v === 2, `${outA4.v}/${outB2.v}`);

  // ===== 既存現場の移行（この機能より前に作られた、固定の記録が無い現場）=====
  const legacy = await db(async () => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const s = stampNew({ name: "機能追加前の現場", clientName: "", startDate: "2026-01-01", endDate: "", memo: "", status: "active", assignedUserIds: [], reportTemplateId: null });
    await dbPut("sites", s); return s;
  });
  await page.reload(); await page.waitForTimeout(1000);
  const legacyAfter = await siteByName("機能追加前の現場");
  const std14 = await templateRec(STD);
  const { templatePin, ...rest } = legacyAfter;
  check("移行: 起動時に既存の現場へ、今使っているテンプレートの現在の版を固定として記録する", templatePin?.templateId === STD && templatePin.revision === 14 && templatePin.sha256 === std14.sourceFileSha256, JSON.stringify(templatePin));
  check("移行: 現場のその他の内容・更新日時・版数は変更しない", JSON.stringify(rest) === JSON.stringify(legacy), "");
  const pinA = (await siteByName(siteA.name)).templatePin;
  check("移行: 既に固定済みの現場（A）は起動しても変わらない", pinA.sha256 === HB);

  // ===== 現場フォームで様式の指定を変えずに保存しても、版は変わらない =====
  await page.goto(`${BASE}#/sites/${siteA.id}/edit`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.fill("#siteFormMemo", "メモだけ変更");
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  check("現場情報の編集（様式の指定は変えない）で固定の版は変わらない", (await siteByName(siteA.name)).templatePin.sha256 === HB);

  // ===== 保護・データ =====
  check("原本の03-2はSHA-256不変", !H0 || sha(fs.readFileSync(ORIGINAL)) === H0);
  check("同梱の暗号化ファイルは変更されていない（復号した内容の指紋が同じ）", sha(decryptBundled()) === HB);
  const reportCount = await db(async () => (await (await import("/js/db.js")).dbGetAll("reports")).length);
  check("日報は削除・変更されていない（件数）", reportCount === reportsA.length + 1, String(reportCount));
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
