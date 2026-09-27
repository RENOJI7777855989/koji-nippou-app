// 標準テンプレート（03-2）・現場ごとの様式指定・版の差し替え／復元の検証
// 実ブラウザ・実IndexedDB・実際の会社指定Excel様式（03-2）。原本ファイルは読み取りのみ（SHA-256で不変を確認）。
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/default-template.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const TEMPLATE = ORIGINAL_TEMPLATE;
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "default-template-test");
fs.mkdirSync(OUT, { recursive: true });
let LEAK_WORDS = []; // 実行時に原本から取り出す（コードに書かない）

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  if (!fs.existsSync(TEMPLATE)) { console.log("様式が見つかりません: " + TEMPLATE); process.exit(2); }
  const original = fs.readFileSync(TEMPLATE);
  const H0 = sha(original);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

  await page.goto(BASE);
  await page.waitForSelector("#view-site-list:not([hidden])");
  LEAK_WORDS = await leakWordsFromOriginal(page, original, { includeRemoveTexts: false }); // 原本（利用者が登録した会社の様式）で出力するので、見出しの会社名は対象外

  // ---- 変種ファイルを、アプリ同梱のZIP部品で作る（原本の複製に印だけ付ける。原本は変更しない）----
  const variants = await page.evaluate(async (b64) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const make = async (mark, changeLabel) => {
      const pkg = await WorkbookPackage.open(bytes.buffer.slice(0));
      let core = await pkg.getText("docProps/core.xml");
      core = core.replace("</cp:coreProperties>", `<dc:title>${mark}</dc:title></cp:coreProperties>`);
      pkg.setText("docProps/core.xml", core);
      if (changeLabel) { // 会社側で様式の固定文言が変わった想定
        let sst = await pkg.getText("xl/sharedStrings.xml");
        sst = sst.replace("巡回点検記録", "巡回点検記録（改）");
        pkg.setText("xl/sharedStrings.xml", sst);
      }
      const buf = new Uint8Array(await pkg.toBlob().arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return { other: await make("OTHER-FORMAT", false), v2: await make("VERSION-2", true) };
  }, original.toString("base64"));
  const fileOther = path.join(OUT, "other-format.xlsx"); fs.writeFileSync(fileOther, Buffer.from(variants.other, "base64"));
  const fileV2 = path.join(OUT, "version-2.xlsx"); fs.writeFileSync(fileV2, Buffer.from(variants.v2, "base64"));
  const fileGarbage = path.join(OUT, "garbage.xlsx"); fs.writeFileSync(fileGarbage, "これはExcelではありません");

  const dbAll = (s) => page.evaluate(async (s) => (await (await import("/js/db.js")).dbGetAll(s)).filter((r) => !r.isDeleted), s);
  const listTemplates = async () => (await dbAll("reportTemplates")).filter((t) => (t.templateKind || "report") === "report");
  const blobSha = (id) => page.evaluate(async (id) => { const t = await (await import("/js/db.js")).dbGet("reportTemplates", id); const d = await crypto.subtle.digest("SHA-256", await t.sourceFileBlob.arrayBuffer()); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }, id);

  async function openTemplates() { await page.goto(`${BASE}#/report-templates`); await page.waitForSelector("#view-report-templates:not([hidden])"); }
  async function addTemplateViaUi({ name, file, standard }) {
    await page.click("#addReportTemplateBtn"); await page.waitForSelector("#reportTemplateFormDialog[open]");
    await page.fill("#reportTemplateName", name);
    await page.setInputFiles("#reportTemplateFile", file);
    await page.waitForFunction(() => document.querySelectorAll("#reportTemplateInspectList li").length > 0);
    if (standard !== undefined) { const c = page.locator("#reportTemplateAsStandard"); if ((await c.isChecked()) !== standard) await c.click(); }
    const inspect = await page.textContent("#reportTemplateInspectList");
    await page.click("#reportTemplateSaveBtn"); await page.waitForSelector("#reportTemplateFormDialog:not([open])", { state: "attached" });
    return inspect;
  }

  // ===== 1. 03-2を標準テンプレートとして登録（画面操作）=====
  // 同梱のクリーンな03-2（暗号化）はセットアップリンクを開いた端末だけに登録される（bundled-template.jsで検証）。
  // このテストは「利用者が原本を自分で登録する」流れを検証するので、同梱分を取り除いてから始める。
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length > 0, null, { timeout: 2000 }).catch(() => {});
  await page.evaluate(async () => { const { dbDelete, dbGetAll } = await import("/js/db.js"); for (const t of await dbGetAll("reportTemplates")) await dbDelete("reportTemplates", t.id); });
  check("0 開始時は標準テンプレートが未設定（同梱の自動登録分を取り除いた）", (await listTemplates()).length === 0);
  await openTemplates();
  const isStandardDefaultChecked = await (async () => { await page.click("#addReportTemplateBtn"); await page.waitForSelector("#reportTemplateFormDialog[open]"); const v = await page.isChecked("#reportTemplateAsStandard"); await page.click("#reportTemplateCancelBtn"); return v; })();
  check("1 標準が未設定のとき、最初のテンプレート登録では「標準テンプレートにする」が既定でオン", isStandardDefaultChecked);
  const inspect1 = await addTemplateViaUi({ name: "03-2 安全衛生作業打合日誌", file: TEMPLATE });
  const t1 = (await listTemplates())[0];
  check("1 登録したテンプレートが標準（isAppDefault）になり、様式の種類（03-2）が自動判別される", !!t1 && t1.isAppDefault && t1.layoutId === "anzen-eisei-03-2" && t1.revision === 1, JSON.stringify(t1 && [t1.isAppDefault, t1.layoutId, t1.revision]));
  check("1 登録前の検査で「様式の種類」と台帳シートあり（180日分）が表示された", inspect1.includes("安全衛生作業打合日誌（03-2）") && inspect1.includes("台帳シートあり") && inspect1.includes("180日"), inspect1.replace(/\s+/g, " ").slice(0, 120));
  check("1 アプリ内に保存された複製は原本と同一内容（SHA-256）で、SHAも記録される", (await blobSha(t1.id)) === H0 && t1.sourceFileSha256 === H0);
  const summary = await page.textContent("#reportTemplateStandardSummary");
  check("1 管理画面に標準テンプレートの表示（名称・第1版）", summary.includes("03-2 安全衛生作業打合日誌") && summary.includes("第1版"), summary.slice(0, 80));

  // ===== 2. 新規現場は自動的に標準（会社・元請名が無くても）=====
  await page.goto(`${BASE}#/sites/new`); await page.waitForSelector("#view-site-form:not([hidden])");
  const opt0 = await page.textContent("#siteFormReportTemplate option:checked");
  check("2 新規現場フォームの様式は既定で「標準テンプレートに従う（現在: 03-2 …）」", opt0.includes("標準テンプレートに従う") && opt0.includes("03-2"), opt0);
  await page.fill("#siteFormName", "標準確認現場A");
  await page.fill("#siteFormStartDate", "2026-04-01"); await page.fill("#siteFormEndDate", "2026-04-30");
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const siteA = (await dbAll("sites")).find((s) => s.name === "標準確認現場A");
  check("2 新規現場は様式の指定を持たず（標準に従う）、元請名が空でも標準が適用される", siteA.reportTemplateId === null);
  await page.waitForFunction(() => document.getElementById("siteDetailReportTemplate").textContent.includes("標準テンプレート"));
  const info = await page.textContent("#siteDetailReportTemplate");
  check("2 現場詳細に「どの様式を、なぜ使うか」が表示される", info.includes("03-2 安全衛生作業打合日誌") && info.includes("標準テンプレート") && info.includes("第1版"), info);

  const mkReport = (siteId, date, tag) => page.evaluate(async ({ siteId, date, tag }) => {
    const { createReport } = await import("/js/reports.js");
    return (await createReport({ siteId, date, weather: "晴れ", temperature: "20", siteSupervisorNames: ["監督A"], companies: [{ companyId: "c1", companyName: `業者${tag}`, occupation: "とび工", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: `作業${tag}`, safetyNotes: "" }] })).id;
  }, { siteId, date, tag });
  const excelFor = async (reportId) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => { const m = await import("/js/reportPrint.js"); return m.exportReportExcel(id); }, reportId)]);
    const file = path.join(OUT, `out-${reportId.slice(0, 6)}.xlsx`); await dl.saveAs(file);
    return page.evaluate(async ({ b64, words }) => {
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const pkg = await WorkbookPackage.open(u.buffer);
      const sheets = (await pkg.listSheets()).map((s) => s.name);
      const core = await pkg.getText("docProps/core.xml");
      const sheet1 = await pkg.getText("xl/worksheets/sheet1.xml");
      const leaks = [];
      for (const p of pkg.listParts()) if (/\.(xml|rels)$/.test(p)) { const t = await pkg.getText(p); for (const w of words) if (t.includes(w)) leaks.push(p + ":" + w); }
      return { sheets, marker: /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1] || "", hasWork: sheet1.includes("作業A") || sheet1.includes("作業B") || sheet1.includes("作業C"), leaks, sheet1 };
    }, { b64: fs.readFileSync(file).toString("base64"), words: LEAK_WORDS }).then((r) => r);
  };
  const rA = await mkReport(siteA.id, "2026-04-02", "A");
  const outA = await excelFor(rA);
  check("2 標準テンプレートで日報Excelを出力でき、内容が入り、他工事データが無い", outA.sheets.length === 1 && outA.sheets[0] === "手書印刷用" && outA.hasWork && outA.leaks.length === 0, JSON.stringify([outA.sheets, outA.leaks]));
  // 台帳も、元請名や会社プロファイルが無くても標準テンプレートで出力できる
  await page.goto(`${BASE}#/sites/${siteA.id}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  const [ledgerDl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#ledgerExcelBtn")]);
  const ledgerPath = path.join(OUT, "ledger.xlsx"); await ledgerDl.saveAs(ledgerPath);
  check("2 台帳Excelも標準テンプレートで出力できる（元請名・会社プロファイル不要）", ledgerDl.suggestedFilename().includes("台帳") && fs.statSync(ledgerPath).size > 50000, ledgerDl.suggestedFilename());

  // ===== 3. 現場ごとに別のExcel書式を使う =====
  await openTemplates();
  await addTemplateViaUi({ name: "別書式（他社向け）", file: fileOther, standard: false });
  const tOther = (await listTemplates()).find((t) => t.name === "別書式（他社向け）");
  check("3 別のExcel書式も登録でき、標準は変わらない（標準は1件のまま）", !!tOther && !tOther.isAppDefault && (await listTemplates()).filter((t) => t.isAppDefault).length === 1);
  await page.goto(`${BASE}#/sites/new`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.fill("#siteFormName", "別書式現場B"); await page.selectOption("#siteFormReportTemplate", tOther.id);
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const siteB = (await dbAll("sites")).find((s) => s.name === "別書式現場B");
  check("3 現場フォームで別書式を指定すると現場に保存される", siteB.reportTemplateId === tOther.id);
  await page.waitForFunction(() => document.getElementById("siteDetailReportTemplate").textContent.includes("この現場で指定"));
  const rB = await mkReport(siteB.id, "2026-04-02", "B");
  const outB = await excelFor(rB);
  const outA2 = await excelFor(rA);
  check("3 別書式の現場は別書式で、標準の現場は標準で出力される（現場ごとに使い分け）", outB.marker === "OTHER-FORMAT" && outA2.marker === "" && outB.hasWork && outA2.hasWork, `${outB.marker} / ${outA2.marker}`);
  const siteFormCopy = await page.evaluate(async (id) => { const { copySite } = await import("/js/sites.js"); return (await copySite(id, { newName: "コピー現場" })).reportTemplateId; }, siteB.id);
  check("3 現場をコピーしても様式の指定が引き継がれる", siteFormCopy === tOther.id);

  // ===== 4. 標準テンプレートを最新版へ差し替え =====
  await openTemplates();
  const before = await listTemplates(); const std = before.find((t) => t.isAppDefault);
  const editStd = page.locator(`li[data-template-id="${std.id}"] .editReportTemplateBtn`);
  dialogs.length = 0;
  await editStd.click(); await page.waitForSelector("#reportTemplateFormDialog[open]");
  await page.setInputFiles("#reportTemplateFile", fileV2);
  await page.waitForFunction(() => document.querySelectorAll("#reportTemplateInspectList li").length > 0);
  const diffText = await page.textContent("#reportTemplateInspectList");
  check("4 差し替え前に、前の版との固定文言の違いが表示される（セル位置がずれる可能性の警告）", diffText.includes("固定文言") && diffText.includes("巡回点検記録"), diffText.replace(/\s+/g, " ").slice(0, 140));
  await page.click("#reportTemplateSaveBtn"); await page.waitForSelector("#reportTemplateFormDialog:not([open])", { state: "attached" });
  check("4 警告がある差し替えは、確認ダイアログを出してから実行される", dialogs.some((m) => m.includes("固定文言")), dialogs[0]?.slice(0, 60));
  const stdAfter = (await listTemplates()).find((t) => t.id === std.id);
  const archives = (await dbAll("reportTemplates")).filter((t) => t.templateKind === "report_archive" && t.archivedOf === std.id);
  check("4 差し替え後: 同じid・標準のまま第2版になり、前の版が退避される（原本ファイルと同一内容）", stdAfter.isAppDefault && stdAfter.revision === 2 && archives.length === 1 && archives[0].sourceFileSha256 === H0 && (await blobSha(archives[0].id)) === H0, JSON.stringify([stdAfter.revision, archives.length]));
  check("4 差し替え後の保存内容は新しいファイルと同一（SHA-256）", (await blobSha(std.id)) === sha(fs.readFileSync(fileV2)) && stdAfter.sourceFileSha256 === sha(fs.readFileSync(fileV2)));
  const outA3 = await excelFor(rA);
  const outB2 = await excelFor(rB);
  check("4 差し替えても、既に作成した現場（標準で作成）は作成時の第1版のまま（版の固定）。別書式の現場も影響を受けない", outA3.marker === "" && outB2.marker === "OTHER-FORMAT", `${outA3.marker || "第1版"} / ${outB2.marker}`);
  const siteC = await page.evaluate(async () => (await (await import("/js/sites.js")).createSite({ name: "差し替え後の新規現場" })).id);
  const rC = await mkReport(siteC, "2026-04-03", "C");
  const outC = await excelFor(rC);
  check("4 差し替え後に作成した現場は新しい版（第2版）で出力され、内容が正しい（他工事データなし）", outC.marker === "VERSION-2" && outC.hasWork && outC.leaks.length === 0, outC.marker);

  // 同じファイルの再差し替え・壊れたファイルは拒否
  await openTemplates();
  await page.locator(`li[data-template-id="${std.id}"] .editReportTemplateBtn`).click(); await page.waitForSelector("#reportTemplateFormDialog[open]");
  await page.setInputFiles("#reportTemplateFile", fileV2); await page.waitForFunction(() => document.querySelectorAll("#reportTemplateInspectList li").length > 0);
  await page.click("#reportTemplateSaveBtn"); await page.waitForTimeout(400);
  const sameMsg = await page.evaluate(() => document.getElementById("message")?.textContent || "");
  const stillRev2 = (await listTemplates()).find((t) => t.id === std.id).revision === 2 && (await dbAll("reportTemplates")).filter((t) => t.templateKind === "report_archive" && t.archivedOf === std.id).length === 1;
  check("4 現在と同じ内容のファイルへの差し替えは拒否され、理由が表示され、版は増えない", stillRev2 && sameMsg.includes("同じ内容"), sameMsg.slice(0, 60));
  await page.evaluate(() => document.getElementById("reportTemplateFormDialog").close());
  await page.locator(`li[data-template-id="${std.id}"] .editReportTemplateBtn`).click(); await page.waitForSelector("#reportTemplateFormDialog[open]");
  await page.setInputFiles("#reportTemplateFile", fileGarbage); await page.waitForFunction(() => document.querySelectorAll("#reportTemplateInspectList li").length > 0);
  const garbageMsg = await page.textContent("#reportTemplateInspectList");
  await page.click("#reportTemplateSaveBtn"); await page.waitForTimeout(400);
  check("4 Excelとして読めないファイルは差し替えできない（理由を表示・データは変わらない）", garbageMsg.includes("読み込めませんでした") && (await listTemplates()).find((t) => t.id === std.id).revision === 2);
  await page.evaluate(() => document.getElementById("reportTemplateFormDialog").close());

  // ===== 5. 前の版に戻す =====
  await openTemplates();
  await page.locator(`li[data-template-id="${std.id}"] .showTemplateVersionsBtn`).click();
  await page.waitForSelector(`li[data-template-id="${std.id}"] .restoreTemplateVersionBtn`);
  await page.locator(`li[data-template-id="${std.id}"] .restoreTemplateVersionBtn`).first().click();
  await page.waitForFunction((id) => document.querySelector(`li[data-template-id="${id}"]`)?.textContent.includes("第3版"), std.id);
  const stdRestored = (await listTemplates()).find((t) => t.id === std.id);
  const outA4 = await excelFor(rA);
  const outC2 = await excelFor(rC);
  check("5 第1版へ戻すと、標準のまま第3版として元の内容（原本と同一）になる。第1版で固定の現場Aは第1版のまま、第2版で固定の現場は第2版のまま", stdRestored.isAppDefault && stdRestored.revision === 3 && (await blobSha(std.id)) === H0 && outA4.marker === "" && outC2.marker === "VERSION-2" && stdRestored.restoredFromRevision === 1, `${stdRestored.revision} A:${outA4.marker || "第1版"} C:${outC2.marker}`);
  check("5 戻す前の版（第2版）も前の版として残る（往復できる）", (await dbAll("reportTemplates")).filter((t) => t.templateKind === "report_archive" && t.archivedOf === std.id).length === 2);

  // ===== 6. 標準の解除・削除時の挙動、従来の元請名一致（後方互換）=====
  await openTemplates();
  await page.locator(`li[data-template-id="${std.id}"] .clearStandardTemplateBtn`).click(); await page.waitForTimeout(300);
  const noStd = (await listTemplates()).filter((t) => t.isAppDefault).length === 0;
  const resolvedNoStd = await page.evaluate(async (id) => { const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js"); const { getSite } = await import("/js/sites.js"); return (await resolveCompanyTemplateForSite(await getSite(id)))?.source || null; }, siteA.id);
  check("6 標準を解除しても、既に作成した現場は固定した版を使い続ける", noStd && resolvedNoStd === "default", String(resolvedNoStd));
  const newNoStd = await page.evaluate(async () => { const { createSite } = await import("/js/sites.js"); const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js"); const s = await createSite({ name: "標準なしの新規現場" }); return { pin: s.templatePin || null, r: (await resolveCompanyTemplateForSite(s))?.source || null }; });
  check("6 標準を解除した後に作る、指定も元請名一致も無い現場は汎用フォーマット（様式なし・版は固定しない）", newNoStd.pin === null && newNoStd.r === null, JSON.stringify(newNoStd));
  const legacy = await page.evaluate(async () => {
    const { createCompanyProfile } = await import("/js/report-output/companyProfiles.js");
    const { createReportTemplate } = await import("/js/report-output/reportTemplates.js");
    const { createSite } = await import("/js/sites.js");
    const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js");
    const c = await createCompanyProfile({ name: "旧方式元請" });
    const stdTpl = (await (await import("/js/db.js")).dbGetAll("reportTemplates")).find((t) => t.name === "別書式（他社向け）");
    await createReportTemplate({ companyProfileId: c.id, format: "excel", name: "旧方式の様式", rendererId: "xlsx-template-patch", sourceFileBlob: stdTpl.sourceFileBlob, sourceFileName: "x.xlsx" });
    const site = await createSite({ name: "旧方式現場", clientName: "旧方式元請" });
    return (await resolveCompanyTemplateForSite(site))?.source;
  });
  check("6 従来の「元請名と同じ会社の様式」も、標準が無いときは今までどおり使われる（後方互換）", legacy === "company", legacy);
  await page.locator(`li[data-template-id="${std.id}"] .setStandardTemplateBtn`).click(); await page.waitForTimeout(300);
  const legacyWithStd = await page.evaluate(async () => { const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js"); const { dbGetAll } = await import("/js/db.js"); const s = (await dbGetAll("sites")).find((x) => x.name === "旧方式現場"); return (await resolveCompanyTemplateForSite(s))?.source; });
  check("6 標準を再設定しても、既存の現場は作成時の様式（元請名一致）の版のまま", legacyWithStd === "company", legacyWithStd);
  const newWithStd = await page.evaluate(async () => { const { createSite } = await import("/js/sites.js"); const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js"); const s = await createSite({ name: "旧方式元請の新規現場", clientName: "旧方式元請" }); return (await resolveCompanyTemplateForSite(s))?.source; });
  check("6 標準がある間に作る現場は、元請名一致より標準が優先される", newWithStd === "default", newWithStd);
  // 現場で使用中の別書式は削除できない（削除すると、その現場の出力様式が変わってしまうため）
  await openTemplates();
  await page.locator(`li[data-template-id="${tOther.id}"] .deleteReportTemplateBtn`).click(); await page.waitForTimeout(300);
  const delMsg = await page.evaluate(() => document.getElementById("message")?.textContent || "");
  const otherAfter = (await dbAll("reportTemplates")).find((t) => t.id === tOther.id);
  check("6 現場で使用中の別書式は削除できず、理由（使用中の現場）が表示される", !!otherAfter && delMsg.includes("使用中のため削除できません") && delMsg.includes("別書式現場B"), delMsg.slice(0, 80));

  // ===== 7. 原本の不変・エラー =====
  check("7 原本ファイルのSHA-256は全工程後も不変（アプリは複製を保存・書き換えは複製に対してのみ）", sha(fs.readFileSync(TEMPLATE)) === H0);
  const stdNow = (await listTemplates()).find((t) => t.id === std.id);
  check("7 アプリ内の標準テンプレートの保存内容は、日報出力を繰り返しても変わらない（第3版の内容＝原本と同一）", (await blobSha(std.id)) === H0 && stdNow.sourceFileSha256 === H0);
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
