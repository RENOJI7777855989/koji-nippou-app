// 03-2を新しい版へ差し替えた後も、旧版に固定した現場のExcelを WebKit（Safariと同じエンジン）で確実に作れることを確かめる（2026-10-17）。
//   以前の不具合: 差し替え・「前の版に戻す」で退避した旧版のファイル（Blob）を、元のレコードと同じBlobのまま受け渡していたため、
//   WebKit（永続プロファイル）で旧版に固定した現場のExcel出力が約3回に1回 NotFoundError になった（Chromiumでは起きない）。
//   ① 第1版で現場Aを作る ② テンプレートを第2版へ差し替え ③ Aの日報のExcelを繰り返し作る（再読み込みを挟む）
//   ④ 第1版へ戻す・もう一度第2版へ ⑤ 繰り返し作る。テンプレートのid・版・指紋・現場の固定は変わらないことも確かめる
//   同梱の03-2（暗号化）を鍵ファイルでメモリ上で復号して使う（原本・同梱ファイルは変更しない）
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { webkit } = require("playwright");
const { decryptBundled, setupUrl } = require("./helpers/templateKey");
const { waitForAsync } = require("./helpers/wait");

const BASE = "http://localhost:8934/index.html";
const ROUNDS = Number(process.env.ARCHIVE_ROUNDS || 6);
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const bundle = decryptBundled();
  const HB = sha(bundle);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-archive-wk-"));
  const ctx = await webkit.launchPersistentContext(dir, { viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(setupUrl(BASE)); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const STD = "bundled-anzen-eisei-03-2";

  // ① 第1版で現場Aと日報
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const site = await createSite({ name: "旧版固定の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const r = await createReport({ siteId: site.id, date: "2026-09-10", companies: [{ companyId: "a", companyName: "甲工業", occupation: "塗装", actualWorkerCount: "3", workContent: "外壁塗装" }] });
    return { siteId: site.id, reportId: r.id };
  });
  const pin1 = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin, ids.siteId);
  check("① 現場Aは同梱の03-2の第1版に固定", pin1?.templateId === STD && pin1.revision === 1 && pin1.sha256 === HB, JSON.stringify(pin1));

  // ② 第2版へ差し替え（固定文言を1か所変えた複製）
  await page.evaluate(async ({ b64 }) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const { replaceReportTemplateFile } = await import("/js/report-output/reportTemplates.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer);
    pkg.setText("xl/sharedStrings.xml", (await pkg.getText("xl/sharedStrings.xml")).replace("巡回点検記録", "巡回点検記録（第2版）"));
    const blob = await pkg.toCompressedBlob();
    await replaceReportTemplateFile("bundled-anzen-eisei-03-2", { blob, fileName: "03-2_v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }, { b64: bundle.toString("base64") });

  // ③ Aの日報のExcelを繰り返し作る（毎回ページを読み直して、保存場所から読み直す）
  const exportOnce = async () => {
    await page.goto(`${BASE}#/sites`); await page.reload(); await page.waitForSelector("#view-site-list:not([hidden])");
    return page.evaluate(async (reportId) => {
      try {
        const { generateReportOutput } = await import("/js/report-output/index.js");
        const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js");
        const { getReport } = await import("/js/reports.js"); const { getSite } = await import("/js/sites.js");
        const site = await getSite((await getReport(reportId)).siteId);
        const company = await resolveCompanyTemplateForSite(site);
        const out = await generateReportOutput({ reportId, format: "excel", templateId: company?.templateId || null });
        const buf = new Uint8Array(await out.blob.arrayBuffer());
        const { loadZip, readZipEntryText } = await import("/js/zipUtil.js");
        const sst = await readZipEntryText(loadZip(buf.buffer), "xl/sharedStrings.xml");
        return { ok: true, size: buf.length, v: sst.includes("巡回点検記録（第2版）") ? 2 : 1 };
      } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
    }, ids.reportId);
  };
  const runRounds = async () => { const r = []; for (let i = 0; i < ROUNDS; i++) r.push(await exportOnce()); return r; };
  let rounds = await runRounds();
  check(`③ 第2版へ差し替えた後、第1版に固定した現場AのExcelを ${ROUNDS}回（毎回読み直し）作って、すべて成功・すべて第1版の内容`, rounds.every((x) => x.ok && x.v === 1), rounds.map((x) => (x.ok ? `v${x.v}` : x.error)).join(" / "));

  // ④ 第1版へ戻す → もう一度第2版へ（退避・復元を往復）
  await page.evaluate(async () => {
    const { listTemplateVersions, restoreReportTemplateVersion } = await import("/js/report-output/reportTemplates.js");
    const id = "bundled-anzen-eisei-03-2";
    const v1 = (await listTemplateVersions(id)).find((v) => v.revision === 1);
    await restoreReportTemplateVersion(id, v1.id);
    const v2 = (await listTemplateVersions(id)).find((v) => v.revision === 2);
    await restoreReportTemplateVersion(id, v2.id);
  });
  rounds = await runRounds();
  check(`④⑤ 第1版へ戻す・第2版へ戻すを往復した後も、現場AのExcelを ${ROUNDS}回作ってすべて成功・第1版の内容`, rounds.every((x) => x.ok && x.v === 1), rounds.map((x) => (x.ok ? `v${x.v}` : x.error)).join(" / "));

  // テンプレートのid・版・指紋・現場の固定は変わらない。退避した版のファイルは中身ごと残っている
  const st = await page.evaluate(async ({ siteId }) => {
    const { dbGet, dbGetAll } = await import("/js/db.js");
    const tpl = await dbGet("reportTemplates", "bundled-anzen-eisei-03-2");
    const archives = (await dbGetAll("reportTemplates")).filter((t) => t.templateKind === "report_archive" && t.archivedOf === tpl.id && !t.isDeleted);
    const digest = async (blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const archiveOk = [];
    for (const a of archives) archiveOk.push(a.sourceFileBlob ? (await digest(a.sourceFileBlob)) === a.sourceFileSha256 : false);
    return { id: tpl.id, revision: tpl.revision, shaOk: (await digest(tpl.sourceFileBlob)) === tpl.sourceFileSha256, archives: archives.length, archiveOk, pin: (await dbGet("sites", siteId)).templatePin };
  }, { siteId: ids.siteId });
  check("テンプレートのidは変わらず、現在の版のファイルの中身は記録した指紋と一致、退避した版（差し替え1回＋戻す2回＝3件）もすべて中身が指紋と一致・現在は第4版", st.id === STD && st.shaOk && st.revision === 4 && st.archives === 3 && st.archiveOk.every(Boolean), JSON.stringify({ ...st, pin: undefined }));
  check("現場Aの固定（テンプレートid・第1版・指紋）は変わらない", st.pin.templateId === STD && st.pin.revision === 1 && st.pin.sha256 === HB);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
