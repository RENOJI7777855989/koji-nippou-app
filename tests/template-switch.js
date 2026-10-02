// 固定様式の現場を、同梱の03-2へ切り替える操作の検証（実ブラウザ・実IndexedDB・画面操作）
// iPad と同じ状態を再現する: 会社の03-2（原本）を直接登録し、元請名の一致でその様式に固定された現場。
//   A 同梱の03-2を登録しても、固定済みの現場の様式は変わらない
//   B 現場情報を編集で「03-2 …（標準） ― この現場をこの様式に固定」を選んで保存すると切り替わる
//     （「標準テンプレートに従う」のままでは切り替わらず、そのことを画面で説明する）
//   C 現場詳細に「使用中: 03-2 … 第1版」が出る
//   D 既存の日報（業者・署名・搬入・搬出・流れ・作業時間）が残っている
//   E Excel出力・PDF・印刷・台帳が同梱の03-2を使う（PDFはA3横・1ページ・崩れなし）
//   F 切り替え前に出力したExcelファイルは変わらない
//   G 「前の様式に戻す」で元の様式に戻る
//   H 工事完了の現場は、画面でもデータ層でも切り替えられない
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/template-switch.js（鍵ファイル・原本が必要）
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");
const { ORIGINAL_TEMPLATE } = require("./helpers/localConfig.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  if (!ORIGINAL_TEMPLATE || !fs.existsSync(ORIGINAL_TEMPLATE)) throw new Error("原本の03-2が見つかりません（~/.koji-nippou-app/config.json の originalTemplatePath）");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-switch-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // ---- iPad と同じ状態: 会社の03-2（原本）を直接登録 → 元請名の一致でその様式に固定された現場（標準は未設定）----
  const ids = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const blob = new Blob([u], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const { createCompanyProfile, updateCompanyProfile } = await import("/js/report-output/companyProfiles.js");
    const { createReportTemplate, sha256OfBlob } = await import("/js/report-output/reportTemplates.js");
    const profile = await createCompanyProfile({ name: "サンプル元請" });
    const tpl = await createReportTemplate({ companyProfileId: profile.id, format: "excel", name: "会社の03-2（直接登録）", rendererId: "xlsx-template-patch", sourceFileBlob: blob, sourceFileName: "03-2.xlsx", sourceFileMimeType: blob.type, layoutId: "anzen-eisei-03-2", sourceFileSha256: await sha256OfBlob(blob) });
    if (updateCompanyProfile) await updateCompanyProfile(profile.id, { defaultExcelTemplateId: tpl.id }).catch(() => {});
    const { createSite } = await import("/js/sites.js");
    const site = await createSite({ name: "切替確認現場", clientName: "サンプル元請", startDate: "2026-09-01" });
    const done = await createSite({ name: "工事完了の現場", clientName: "サンプル元請", startDate: "2026-09-01" });
    const { dbPut, dbGet } = await import("/js/db.js");
    const { stampNew } = await import("/js/utils.js");
    const report = stampNew({ siteId: site.id, date: "2026-09-10", weather: "晴れ", temperature: "21",
      companies: [{ companyId: "c1", companyName: "株式会社サンプル建設工業協力会社", occupation: "型枠大工", actualWorkerCount: "4", workHours: "8:00～17:00", workContent: "2階東側スラブ型枠建込および配筋検査前の清掃と墨出し作業".repeat(3), safetyNotes: "開口部養生" }],
      timeline: [{ id: "t1", time: "08:00", title: "朝礼", kind: "meeting", status: "done", note: "" }],
      deliveries: [{ id: "d1", direction: "in", time: "10:00", item: "鉄筋", status: "plan" }, { id: "d2", direction: "out", time: "15:00", item: "残土", status: "plan" }] });
    await dbPut("reports", report);
    const cv = document.createElement("canvas"); cv.width = 200; cv.height = 60; cv.getContext("2d").fillText("署名", 10, 30);
    await dbPut("signatures", stampNew({ reportId: report.id, companyId: "c1", role: "foreman", roleLabel: "職長", imageBlob: await new Promise((r) => cv.toBlob(r, "image/png")), signedAt: new Date().toISOString() }));
    await dbPut("reports", stampNew({ siteId: done.id, date: "2026-09-10", companies: [{ companyId: "z", companyName: "完了工業" }] }));
    const { completeSite } = await import("/js/sites.js");
    await completeSite(done.id);
    return { siteId: site.id, doneId: done.id, reportId: report.id, tplId: tpl.id, pin: (await dbGet("sites", site.id)).templatePin };
  }, fs.readFileSync(ORIGINAL_TEMPLATE).toString("base64"));
  check("準備: 現場は会社の03-2（直接登録）に固定されている", ids.pin?.templateId === ids.tplId, ids.pin?.source);
  const snapshot = () => page.evaluate(async (id) => { const { dbGet, dbGetAll } = await import("/js/db.js"); const r = await dbGet("reports", id); return JSON.stringify({ c: r.companies, t: r.timeline, d: r.deliveries, sig: (await dbGetAll("signatures")).filter((s) => s.reportId === id).map((s) => [s.id, s.imageBlob?.size]) }); }, ids.reportId);
  const dataBefore = await snapshot();

  // ---- 切り替え前の様式（会社の03-2・原本）でも、PDFが崩れない ----
  const pdf0 = await page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, ids.reportId);
  const p0 = await ctx.newPage(); await p0.setContent(pdf0); await p0.waitForTimeout(300);
  const m0 = await p0.evaluate(() => { dispatchEvent(new Event("beforeprint")); const t = document.querySelector("table.xlsx-sheet"); const z = parseFloat(document.querySelector(".xlsx-sheet-wrap").style.zoom) || 1; let grown = 0; for (const tr of t.rows) if (tr.getBoundingClientRect().height / z > (parseFloat(tr.style.height) || 0) + 1.5) grown++; return { grown, clipped: window.__xlsxCellsClipped, zoom: z }; });
  const b0 = Buffer.from(await p0.pdf({ preferCSSPageSize: true })).toString("latin1"); await p0.close();
  const box0 = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(b0); const pages0 = (b0.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("切り替え前の様式（会社の03-2・原本）でも、長文の日のPDFがA3横・1ページ・行の伸び/収まらないセル無し", pages0 === 1 && box0 && Math.abs(Number(box0[1]) - 1190.55) < 3 && m0.grown === 0 && m0.clipped === 0, `${pages0}頁 ${box0 ? Math.round(box0[1]) + "x" + Math.round(box0[2]) : "?"}pt 縮小${m0.zoom.toFixed(2)} 行の伸び${m0.grown} 収まらず${m0.clipped}`);

  // ---- F の準備: 切り替え前にExcelを出力して保存 ----
  const [dl1] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), ids.reportId)]);
  const beforeFile = path.join(dir, "before.xlsx"); await dl1.saveAs(beforeFile);
  const beforeSha = sha(fs.readFileSync(beforeFile));

  // ---- A 同梱の03-2を登録（セットアップリンク）しても、固定済みの現場は変わらない ----
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const afterSetup = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin, ids.siteId);
  check("A 同梱の03-2を登録しても、固定済みの現場の様式は変わらない", JSON.stringify(afterSetup) === JSON.stringify(ids.pin));

  // ---- B 現場情報を編集 ----
  await page.goto(`${BASE}#/sites/${ids.siteId}/edit`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.waitForFunction(() => document.getElementById("siteFormReportTemplateHint").textContent.includes("今使っている様式"));
  const opts = await page.$$eval("#siteFormReportTemplate option", (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  const hint0 = await page.textContent("#siteFormReportTemplateHint");
  check("B 選択肢の意味が分かる（標準に従う／この現場をこの様式に固定）", opts[0].t.startsWith("標準テンプレートに従う（今の標準: 03-2") && opts.some((o) => o.t === "03-2 安全衛生作業打合日誌（標準） ― この現場をこの様式に固定"), opts.map((o) => o.t).join(" / "));
  check("B 今使っている様式と、標準へ切り替える方法（一覧から直接選ぶ）が説明される", hint0.includes("今使っている様式: 会社の03-2（直接登録） 第1版") && hint0.includes("「標準テンプレートに従う」のままでは、今の様式から切り替わりません"), hint0.replace(/\n/g, " / ").slice(0, 160));
  // 「標準テンプレートに従う」のまま保存しても切り替わらない（従来の仕様）
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const stillPin = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin.templateId, ids.siteId);
  check("B 「標準テンプレートに従う」のまま保存しても様式は切り替わらない（従来どおり）", stillPin === ids.tplId);
  // 直接選ぶ
  await page.goto(`${BASE}#/sites/${ids.siteId}/edit`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.waitForFunction(() => document.getElementById("siteFormReportTemplateHint").textContent.includes("今使っている様式"));
  const bundledValue = opts.find((o) => o.t === "03-2 安全衛生作業打合日誌（標準） ― この現場をこの様式に固定").v;
  // 画面の準備（選択肢の作り直し）が終わってから選ぶ。選んだ値が選択欄に残るまで繰り返す
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    await page.selectOption("#siteFormReportTemplate", bundledValue);
    await page.waitForTimeout(250);
    if ((await page.inputValue("#siteFormReportTemplate")) === bundledValue && (await page.textContent("#siteFormReportTemplateHint")).includes("保存すると")) break;
  }
  const hint1 = await page.textContent("#siteFormReportTemplateHint");
  check("B 選ぶと、保存後に使う様式と版・出力済みファイルは変わらないことが表示される", hint1.includes("「03-2 安全衛生作業打合日誌（標準）」第1版で出力されます") && hint1.includes("出力済みのファイルは変わりません"), hint1.replace(/\n/g, " / ").slice(0, 160));
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const msg = await page.textContent("#message").catch(() => "") || await page.evaluate(() => document.body.textContent);
  const newPin = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin, ids.siteId);
  check("B 保存すると同梱の03-2 第1版に切り替わる", newPin.templateId === bundledValue && newPin.revision === 1, `${newPin.templateId} 第${newPin.revision}版`);
  check("B 切り替えのメッセージに様式名・版・出力済みファイルは変わらないことが出る", /「03-2 安全衛生作業打合日誌（標準）」第1版に切り替えました.*出力済みのファイルは変わりません/.test(msg), (msg.match(/日報のExcel様式を[^。]*。/) || [""])[0]);

  // ---- C 現場詳細 ----
  await page.waitForFunction(() => document.getElementById("siteDetailReportTemplate")?.textContent.includes("使用中"), null, { timeout: 10000 }).catch(() => {});
  const detail = await page.evaluate(() => (document.getElementById("siteDetailReportTemplate") || document.querySelector("[id*=ReportTemplate]"))?.textContent || "");
  check("C 現場詳細に「使用中: 03-2 安全衛生作業打合日誌（標準） 第1版」と、前の様式に戻すボタンが出る", detail.includes("使用中: 03-2 安全衛生作業打合日誌（標準） 第1版") && detail.includes("前の様式（会社の03-2（直接登録） 第1版）に戻す"), detail.replace(/\s+/g, " ").slice(0, 160));

  // ---- D 既存の日報が残っている ----
  check("D 既存の日報（業者・署名・搬入・搬出・流れ・作業時間）が変わっていない", (await snapshot()) === dataBefore);
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.reportId}`); await page.waitForSelector("#view-report-form:not([hidden])");
  const form = await page.evaluate(() => ({ name: document.querySelector(".company-row .companyName").value, hours: document.querySelector(".company-row .workHours").value, dl: document.querySelectorAll(".delivery-row").length }));
  check("D 日報を開くと内容が入っている", form.name === "株式会社サンプル建設工業協力会社" && form.hours === "08:00～17:00" && form.dl === 2, JSON.stringify(form));

  // ---- E Excel・PDF・印刷・台帳が同梱の03-2を使う ----
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => { const r = await (await import("/js/reportPrint.js")).exportReportExcel(id); window.__usedTpl = r.company?.templateId; }, ids.reportId)]);
  const afterFile = path.join(dir, "after.xlsx"); await dl2.saveAs(afterFile);
  const used = await page.evaluate(() => window.__usedTpl);
  check("E Excel出力が同梱の03-2を使う（Excelとして開ける）", used === bundledValue && fs.readFileSync(afterFile).subarray(0, 2).toString() === "PK", used);
  const pdf = await page.evaluate(async (id) => { const r = await (await import("/js/reportPrint.js")).buildReportPrintHtml(id); return { html: r.html, tpl: r.company?.templateId }; }, ids.reportId);
  const p2 = await ctx.newPage(); await p2.setContent(pdf.html); await p2.waitForTimeout(300);
  const m = await p2.evaluate(() => { dispatchEvent(new Event("beforeprint")); const t = document.querySelector("table.xlsx-sheet"); const z = parseFloat(document.querySelector(".xlsx-sheet-wrap").style.zoom) || 1; let grown = 0; for (const tr of t.rows) if (tr.getBoundingClientRect().height / z > (parseFloat(tr.style.height) || 0) + 1.5) grown++; return { grown, clipped: window.__xlsxCellsClipped }; });
  const pdfBytes = await p2.pdf({ preferCSSPageSize: true }); await p2.close();
  const txt = Buffer.from(pdfBytes).toString("latin1"); const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(txt); const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("E PDF・印刷（同じ印刷用HTML）が同梱の03-2を使い、A3横・1ページ・行の伸び/収まらないセル無し", pdf.tpl === bundledValue && pages === 1 && box && Math.abs(Number(box[1]) - 1190.55) < 3 && m.grown === 0 && m.clipped === 0, `${pages}頁 ${box ? Math.round(box[1]) + "x" + Math.round(box[2]) : "?"}pt 行の伸び${m.grown} 収まらず${m.clipped}`);
  const ledger = await page.evaluate(async (siteId) => { const { resolveReportTemplateForSite } = await import("/js/report-output/templateResolver.js"); const { dbGet } = await import("/js/db.js"); return (await resolveReportTemplateForSite(await dbGet("sites", siteId))).templateId; }, ids.siteId);
  check("E 台帳も同じ様式（同梱の03-2）を使う（台帳・印刷は現場の固定を共通で参照）", ledger === bundledValue, ledger);

  // ---- F 切り替え前に出力したExcelファイルは変わらない ----
  check("F 切り替え前に出力したExcelファイルは変わっていない", sha(fs.readFileSync(beforeFile)) === beforeSha && sha(fs.readFileSync(afterFile)) !== beforeSha);

  // ---- G 前の様式に戻す ----
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteTemplateRevertBtn");
  await page.click("#siteTemplateRevertBtn");
  await waitForAsync(page, async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin.templateId !== "bundled-anzen-eisei-03-2", ids.siteId, { timeout: 10000 });
  const reverted = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin, ids.siteId);
  check("G 「前の様式に戻す」で会社の03-2（直接登録）第1版に戻る", reverted.templateId === ids.tplId && reverted.sha256 === ids.pin.sha256);

  // ---- G2 戻した後: 様式の指定もそろい、現場フォームで03-2を直接選び直すだけで切り替わる（「標準に従う」を経由しない）----
  const afterRevert = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).reportTemplateId || null, ids.siteId);
  check("G2 戻すと、様式の指定もそろう（元請名の一致で決まっていた固定に戻したので、指定なし＝標準に従う）", afterRevert === null, String(afterRevert));
  const pickDirect = async () => {
    await page.goto(`${BASE}#/sites/${ids.siteId}/edit`); await page.waitForSelector("#view-site-form:not([hidden])");
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); await page.selectOption("#siteFormReportTemplate", bundledValue); await page.waitForTimeout(200); if ((await page.inputValue("#siteFormReportTemplate")) === bundledValue && (await page.textContent("#siteFormReportTemplateHint")).includes("保存すると")) break; }
    const hint = await page.textContent("#siteFormReportTemplateHint");
    await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
    return { hint, pin: await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("sites", id)).templatePin, ids.siteId) };
  };
  const re = await pickDirect();
  check("G2 戻した後、現場フォームで「03-2 … ― この現場をこの様式に固定」を直接選んで保存すると03-2へ切り替わる", re.pin.templateId === bundledValue && re.pin.revision === 1);
  const [dl3] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => { const r = await (await import("/js/reportPrint.js")).exportReportExcel(id); window.__usedTpl = r.company?.templateId; }, ids.reportId)]);
  const f3 = path.join(dir, "again.xlsx"); await dl3.saveAs(f3);
  const pdf3 = await page.evaluate(async (id) => { const r = await (await import("/js/reportPrint.js")).buildReportPrintHtml(id); return { tpl: r.company?.templateId, a3: r.html.includes("size: 420mm 297mm") }; }, ids.reportId);
  const [ld3] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (sid) => { const r = await (await import("/js/reportPrint.js")).exportSiteLedgerExcel(sid); window.__ledTpl = r.company?.templateId; }, ids.siteId)]);
  check("G2 切り替え直した後も、Excel・PDF（印刷と同じ印刷用ページ・A3横）・台帳が03-2で出力される", (await page.evaluate(() => window.__usedTpl)) === bundledValue && fs.readFileSync(f3).subarray(0, 2).toString() === "PK" && pdf3.tpl === bundledValue && pdf3.a3 && (await page.evaluate(() => window.__ledTpl)) === bundledValue && /\.xlsx$/.test(ld3.suggestedFilename()));
  check("G2 戻す・切り替え直しをしても、日報（業者・署名・搬入・搬出・流れ・作業時間）は変わらない", (await snapshot()) === dataBefore);
  // 以前の版で「戻す」をして、指定（03-2）と固定（旧様式）が食い違ったままの現場でも、03-2を直接選べば切り替わる
  await page.evaluate(async ({ id, tpl, oldPin }) => { const { dbGet, dbPut } = await import("/js/db.js"); const s = await dbGet("sites", id); await dbPut("sites", { ...s, reportTemplateId: tpl, templatePin: { ...oldPin, pinnedAt: new Date().toISOString() } }); }, { id: ids.siteId, tpl: bundledValue, oldPin: ids.pin });
  const stuck = await pickDirect();
  check("G2 指定が03-2のまま旧様式に固定されている現場（以前の版で戻した場合）でも、03-2を選んで保存すると切り替わる", stuck.pin.templateId === bundledValue && stuck.hint.includes("第1版で出力されます"), stuck.hint.replace(/\n/g, " / ").slice(0, 90));

  // ---- H 工事完了の現場は切り替えられない ----
  await page.goto(`${BASE}#/sites/${ids.doneId}/edit`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.waitForFunction(() => document.getElementById("siteFormReportTemplateHint").textContent.includes("工事完了"));
  const doneForm = await page.evaluate(() => ({ disabled: document.getElementById("siteFormReportTemplate").disabled, hint: document.getElementById("siteFormReportTemplateHint").textContent }));
  check("H 工事完了の現場は、現場フォームの様式の選択欄が操作できず、理由が表示される", doneForm.disabled && doneForm.hint.includes("工事完了の現場は、日報のExcel様式を切り替えられません"));
  const donePinBefore = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGet("sites", id)).templatePin), ids.doneId);
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const layer = await page.evaluate(async ({ id, tpl }) => { const { repinSite, revertSiteTemplate } = await import("/js/report-output/templateResolver.js"); const out = []; for (const f of [() => repinSite(id, { templateId: tpl, reason: "form" }), () => revertSiteTemplate(id)]) { try { await f(); out.push("通った"); } catch (e) { out.push(e.message); } } return out; }, { id: ids.doneId, tpl: bundledValue });
  const donePinAfter = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGet("sites", id)).templatePin), ids.doneId);
  check("H 工事完了の現場は、データ層でも切り替え・戻しを拒否し、固定は変わらない", layer.every((x) => x.includes("工事完了の現場は")) && donePinBefore === donePinAfter, layer.join(" / "));
  const doneDetail = await page.evaluate(() => ({ revert: !!document.getElementById("siteTemplateRevertBtn"), upgrade: !!document.getElementById("siteTemplateUpgradeBtn") }));
  check("H 工事完了の現場の詳細には、切り替え・戻すボタンが出ない", !doneDetail.revert && !doneDetail.upgrade);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
