// 日報カレンダーから所長印を一括押印する（2026-10-25。架空データ・隔離したプロファイル）
//   月ごとに選ぶ・個別に選ぶ／外す・月をまたいで選ぶ、押印済みは既定で対象外、確認画面の件数と日付、押した日報だけに印、
//   本文・人数・写真・職長サイン・確定済みの日報は変わらない、再読み込み・日報画面・印刷・PDF・まとめて印刷、Excel出力は変わらない、
//   元に戻す、押し直し（上書き）、確認画面の後に変更された日報があれば何も書かない、変更履歴、工事完了の現場は不可
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const NAME = "山田"; // 架空の名前
const OTHER = "佐藤";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-bulk-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const ids = await page.evaluate(async ([OTHER]) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "一括押印の試験", startDate: "2026-09-01" });
    const mk = (date, extra = {}) => stampNew({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", temperature: "18", remarks: `${date} の連絡`, workerCountTotal: "3",
      companies: [{ companyId: "c-" + date, companyName: "甲工業", occupation: "塗装", plannedWorkerCount: "3", actualWorkerCount: "3", workContent: `${date} 外壁塗装`, billingManDays: "2.5" }], ...extra });
    const r = {
      s27: mk("2026-09-27", { finalizedAt: "2026-09-28T00:00:00.000Z" }),
      s29: mk("2026-09-29"), s30: mk("2026-09-30"),
      o01: mk("2026-10-01"), o02a: mk("2026-10-02"), o02b: mk("2026-10-02", { remarks: "同じ日の2件目" }),
      o03: mk("2026-10-03", { directorSeal: { name: OTHER, offsetX: 50, offsetY: 0, stampedAt: "2026-10-03T08:00:00.000Z" } })
    };
    for (const x of Object.values(r)) await dbPut("reports", x);
    // 職長サイン（9/29）と写真（9/30）
    const cv = document.createElement("canvas"); cv.width = 300; cv.height = 80; const g = cv.getContext("2d"); g.lineWidth = 3; g.beginPath(); g.moveTo(20, 60); g.lineTo(280, 20); g.stroke();
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    await dbPut("signatures", stampNew({ reportId: r.s29.id, companyId: "c-2026-09-29", role: "foreman", roleLabel: "職長", imageBlob: blob, signedAt: new Date().toISOString() }));
    await dbPut("photos", stampNew({ reportId: r.s30.id, siteId: site.id, blob, mimeType: "image/png", caption: "写真" }));
    return { site: site.id, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.id])) };
  }, [OTHER]);

  // 押印の前の状態（印・更新の記録以外の項目、職長サイン・写真）
  const SNAP = async () => page.evaluate(async (siteId) => {
    const { dbGetAll } = await import("/js/db.js");
    const strip = ({ directorSeal, updatedAt, version, lastEditedAt, updatedByUserId, updatedByUserName, deviceId, ...rest }) => rest;
    const reports = (await dbGetAll("reports")).filter((r) => r.siteId === siteId);
    return {
      body: Object.fromEntries(reports.map((r) => [r.id, JSON.stringify(strip(r))])),
      seal: Object.fromEntries(reports.map((r) => [r.id, r.directorSeal ?? null])),
      sig: JSON.stringify((await dbGetAll("signatures")).map((s) => [s.id, s.updatedAt, s.isDeleted || false])),
      photos: JSON.stringify((await dbGetAll("photos")).map((p) => [p.id, p.updatedAt, p.isDeleted || false]))
    };
  }, ids.site);
  const excelOf = (id) => page.evaluate(async (id) => {
    const { getReport } = await import("/js/reports.js"); const { getSite } = await import("/js/sites.js");
    const rp = await import("/js/reportPrint.js"); const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const r = await getReport(id); const t = await rp.resolveCompanyTemplateForSite(await getSite(r.siteId));
    const out = await generateReportOutput({ reportId: id, format: "excel", templateId: t?.templateId || null });
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const zip = loadZip(await out.blob.arrayBuffer());
    let s = ""; for (const n of [...zip.entries.keys()].filter((n) => /^xl\/(worksheets\/sheet\d+|drawings\/drawing\d+)\.xml$/.test(n)).sort()) s += `[${n}]` + (await readZipEntryText(zip, n));
    return s;
  }, id);
  const before = await SNAP();
  const excel0 = await excelOf(ids.o01);

  const openCalendar = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForTimeout(200);
    await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
    await page.click('[data-action="calendar"]'); await page.waitForSelector("#calSealBulkBtn"); await page.waitForTimeout(200);
  };
  const listRows = () => page.evaluate(() => [...document.querySelectorAll("#sealBulkDialog .seal-bulk-list li")].map((li) => ({ date: li.querySelector(".seal-bulk-date")?.textContent || "", state: li.querySelector(".seal-bulk-state")?.textContent || "", id: li.querySelector("input")?.dataset.sbId, checked: !!li.querySelector("input")?.checked, disabled: !!li.querySelector("input")?.disabled })));
  const dlgText = () => page.evaluate(() => document.getElementById("sealBulkBody").textContent.replace(/\s+/g, " "));

  await openCalendar();
  check("日報カレンダーに［所長印を一括押印］がある", await page.isVisible("#calSealBulkBtn"));
  await page.click("#calSealBulkBtn"); await page.waitForSelector("#sealBulkDialog[open]");
  let rows = await listRows();
  check("10月の保存済みの日報が並ぶ（同じ日の2件は別々・押印済みは名前つき）", rows.length === 4 && rows.filter((r) => r.date.startsWith("10/2")).length === 2 && rows.find((r) => r.id === ids.o03)?.state === `押印済み：${OTHER}` && rows.every((r) => !r.checked), JSON.stringify(rows));
  check("名前の初期値はこの現場の前の印の名前（自動では押さない）", (await page.inputValue("#sealBulkName")) === OTHER);
  check("最初は［確認へ］が押せない（何も選んでいない）", await page.isDisabled('[data-sb="toConfirm"]'));
  await page.fill("#sealBulkName", NAME);
  check("名前を変えると印の見本が出る", await page.isVisible("#sealBulkDialog img.seal-bulk-preview"));
  await page.click('[data-sb="selectMonth"]');
  rows = await listRows();
  check("［この月の未押印をすべて選択］で未押印の3件だけが選ばれる（押印済みの10/3は選ばない）", rows.filter((r) => r.checked).length === 3 && !rows.find((r) => r.id === ids.o03).checked);
  await page.uncheck(`[data-sb-id="${ids.o02b}"]`);
  await page.check(`[data-sb-id="${ids.o03}"]`); // 押印済みを選んでも、既定では対象外になる
  await page.click('[data-sb="month"][data-shift="-1"]');
  rows = await listRows();
  check("前の月（9月）へ移れる・確定済みの日報は選べない", rows.length === 3 && rows.find((r) => r.id === ids.s27)?.disabled && /確定済み/.test(rows.find((r) => r.id === ids.s27)?.state));
  await page.check(`[data-sb-id="${ids.s29}"]`);
  check("月をまたいで選んだ件数と日付が出る（4件）", /選択中 4件（9\/29（火）・10\/1（木）・10\/2（金）・10\/3（土）/.test(await dlgText()), await dlgText());
  await page.click('[data-sb="toConfirm"]'); await page.waitForSelector('[data-sb="apply"]');
  const conf = await dlgText();
  check("確認画面: 押印する3件の日付・押印済みの10/3は対象外（名前つき）・印の見本", /押印する ?3件（9\/29（火）・10\/1（木）・10\/2（金））/.test(conf) && /対象外 ?1件（10\/3（土） 押印済み（佐藤））/.test(conf) && await page.isVisible("#sealBulkDialog img.seal-bulk-preview"), conf.slice(0, 200));
  check("確認画面ではまだ書き込まない", JSON.stringify((await SNAP()).seal) === JSON.stringify(before.seal));
  await page.click('[data-sb="apply"]'); await page.waitForSelector(".seal-bulk-result-head");
  check("結果: 押印した3件・対象外1件・失敗0件", /押印した 3件・対象外 1件・失敗 0件/.test(await dlgText()), (await dlgText()).slice(0, 120));
  const a1 = await SNAP();
  check("選んだ日報（9/29・10/1・10/2の1件目）だけに印（名前・中央）", [ids.s29, ids.o01, ids.o02a].every((id) => a1.seal[id]?.name === NAME && a1.seal[id].offsetX === 0 && a1.seal[id].offsetY === 0));
  check("選ばなかった日報（9/30・10/2の2件目）・確定済み（9/27）は印なしのまま", [ids.s30, ids.o02b, ids.s27].every((id) => a1.seal[id] === null));
  check("押印済み（10/3）は既定では変わらない（名前・位置・押印日時）", JSON.stringify(a1.seal[ids.o03]) === JSON.stringify(before.seal[ids.o03]));
  check("日報の本文・人数・作業内容・請求人工など印以外の項目は変わらない（全日報）", Object.keys(before.body).every((id) => before.body[id] === a1.body[id]));
  check("職長サイン・写真は変わらない", a1.sig === before.sig && a1.photos === before.photos);
  const audit = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("auditLog")).map((e) => e.summary).filter((s) => s.includes("一括押印")));
  check("変更履歴に対象の日付と件数が残る", audit.some((s) => s === `所長印を一括押印（${NAME}・3件: 9/29・10/1・10/2）`), JSON.stringify(audit));
  await page.click('[data-sb="close"]'); await page.waitForTimeout(300);
  const marks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#reportCalendar .cal-cell[data-date]")].filter((c) => c.querySelector(".cal-seal")).map((c) => [c.dataset.date, c.querySelector(".cal-seal").textContent])));
  check("カレンダーに押印済みの印（10/1・10/2は2件中1件・10/3）", marks["2026-10-01"] === "印" && marks["2026-10-02"] === "印 1/2" && marks["2026-10-03"] === "印" && Object.keys(marks).length === 3, JSON.stringify(marks));

  // 再読み込み・日報画面・印刷・PDF・Excel
  await page.reload(); await page.waitForTimeout(800);
  check("再読み込みしても印は残る", (await SNAP()).seal[ids.o01]?.name === NAME);
  await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.o01}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500);
  const form = await page.evaluate(() => ({ shown: !document.getElementById("directorSealImg").hidden, status: document.getElementById("directorSealStatus").textContent, name: document.getElementById("directorSealName").value }));
  check("日報画面を開くと所長印が押印済みで表示される", form.shown && form.status.startsWith(`押印済み：${NAME}`) && !form.status.includes("まだ保存") && form.name === NAME, JSON.stringify(form));
  const html = await page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, ids.o01);
  const bulkHtml = await page.evaluate(async (list) => (await (await import("/js/reportPrint.js")).buildReportsPrintHtml(list, "まとめて")).html, [ids.s29, ids.s30, ids.o01]);
  check("印刷用HTML（個別）の所長欄に印が1つ", (html.match(/class="xlsx-overlay-img xlsx-overlay-seal"/g) || []).length === 1);
  check("まとめて印刷（9/29・9/30・10/1）で押印した2件だけに印", (bulkHtml.match(/class="xlsx-overlay-img xlsx-overlay-seal"/g) || []).length === 2);
  const red = await page.evaluate(async (html) => {
    const { renderCompanySheetsToJpegs } = await import("/js/ui/company-pdf.js"); const pages = await renderCompanySheetsToJpegs(html);
    const bm = await createImageBitmap(new Blob([pages[0].jpeg], { type: "image/jpeg" })); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n;
  }, html);
  check("PDF（1ページのPDFの画像）に赤い印が出る", red > 200, `${red}`);
  const pdfPage = await ctx.newPage(); await pdfPage.setContent(html); await pdfPage.waitForTimeout(500); await pdfPage.emulateMedia({ media: "print" });
  const pdf = await pdfPage.pdf({ printBackground: true, preferCSSPageSize: true }); await pdfPage.close();
  check("印刷（PDF出力）は A3横・1ページ", (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+119[01](\.\d+)?\s+84[12](\.\d+)?\s*\]/.test(pdf.toString("latin1")), (pdf.toString("latin1").match(/\/MediaBox\s*\[[^\]]*\]/) || [""])[0]);
  check("Excel出力は押印の前後で同じ（Excelには印を書かない）", (await excelOf(ids.o01)) === excel0 && excel0.length > 1000);

  // 元に戻す（前回の一括押印）
  await openCalendar(); await page.click("#calSealBulkBtn"); await page.waitForSelector("#sealBulkDialog[open]");
  check("ダイアログに前回の一括押印（3件）と［前回の一括押印を元に戻す］", /前回の一括押印: .*山田・3件/.test(await dlgText()) && await page.isVisible('[data-sb="undo"]'));
  await page.click('[data-sb="undo"]'); await page.waitForTimeout(500);
  const u1 = await SNAP();
  check("元に戻すと3件は印なしに戻り、10/3（佐藤）はそのまま", [ids.s29, ids.o01, ids.o02a].every((id) => u1.seal[id] === null) && JSON.stringify(u1.seal[ids.o03]) === JSON.stringify(before.seal[ids.o03]));
  check("元に戻しても印以外の項目・職長サイン・写真は変わらない", Object.keys(before.body).every((id) => before.body[id] === u1.body[id]) && u1.sig === before.sig && u1.photos === before.photos);
  check("元に戻した後は［前回の一括押印を元に戻す］が出ない", !(await page.isVisible('[data-sb="undo"]')));

  // 押し直し（上書き）: 押印済みの10/3も名前を押し直す（位置はそのまま）
  await page.fill("#sealBulkName", NAME);
  await page.check('input[name="sealBulkMode"][value="overwrite"]');
  await page.check(`[data-sb-id="${ids.o03}"]`); await page.check(`[data-sb-id="${ids.o01}"]`);
  await page.click('[data-sb="toConfirm"]'); await page.waitForSelector('[data-sb="apply"]');
  check("確認画面: 押し直し1件が分かる", /押印する ?2件（10\/1（木）・10\/3（土））/.test(await dlgText()) && /うち押し直し ?1件（10\/3（土））/.test(await dlgText()), (await dlgText()).slice(0, 200));
  await page.click('[data-sb="apply"]'); await page.waitForSelector(".seal-bulk-result-head");
  const o1 = await SNAP();
  check("押し直すと10/3は名前だけ変わり、位置（右へ50）はそのまま", o1.seal[ids.o03]?.name === NAME && o1.seal[ids.o03].offsetX === 50 && o1.seal[ids.o01]?.name === NAME);
  // 押印の後に別の画面で印を変えた日報は、元に戻さない
  await page.evaluate(async (id) => (await import("/js/reports.js")).updateReport(id, { directorSeal: { name: "鈴木" } }), ids.o01);
  await page.click('[data-sb="undoThis"]'); await page.waitForTimeout(500);
  const o2 = await SNAP();
  check("［元に戻す］: 10/3は佐藤（押す前）に戻り、後から印を変えた10/1は変えない（理由を表示）", JSON.stringify(o2.seal[ids.o03]) === JSON.stringify(before.seal[ids.o03]) && o2.seal[ids.o01]?.name === "鈴木" && /元に戻しました: 1件（戻さなかった日報: 10\/1（木） 一括押印の後に印が変更されている/.test(await dlgText()), (await dlgText()).slice(-160));
  await page.click('[data-sb="close"]');

  // 確認画面の後に変更された日報があれば、何も書かない
  await page.click("#calSealBulkBtn"); await page.waitForSelector("#sealBulkDialog[open]");
  await page.fill("#sealBulkName", NAME);
  await page.check(`[data-sb-id="${ids.o02a}"]`); await page.check(`[data-sb-id="${ids.o02b}"]`);
  await page.click('[data-sb="toConfirm"]'); await page.waitForSelector('[data-sb="apply"]');
  await page.evaluate(async (id) => (await import("/js/reports.js")).updateReport(id, { remarks: "別の画面で修正" }), ids.o02b);
  const s3 = await SNAP();
  await page.click('[data-sb="apply"]'); await page.waitForSelector(".seal-bulk-result-head");
  const s4 = await SNAP();
  check("確認画面の後に変更された日報があると中止し、どの日報か示す（1件も押さない）", /押印した 0件・対象外 0件・失敗 2件/.test(await dlgText()) && JSON.stringify(s4.seal) === JSON.stringify(s3.seal) && /確認画面を出した後に変更された（この日報）/.test(await dlgText()) && /ほかの日報が確認画面を出した後に変更されたため中止/.test(await dlgText()), (await dlgText()).slice(0, 200));
  await page.click('[data-sb="close"]');

  // データ層: 重複・確定済み・工事完了の現場
  const dl = await page.evaluate(async ([ids, NAME]) => {
    const m = await import("/js/directorSealBulk.js"); const { getReport } = await import("/js/reports.js");
    const r1 = await m.applyBulkSeal({ siteId: ids.site, reportIds: [ids.s30, ids.s30, ids.s27], name: NAME });
    const s30 = (await getReport(ids.s30)).directorSeal;
    const { dbGet, dbPut } = await import("/js/db.js"); const site = await dbGet("sites", ids.site);
    await dbPut("sites", { ...site, completedAt: new Date().toISOString() });
    let err = ""; try { await m.applyBulkSeal({ siteId: ids.site, reportIds: [ids.o02b], name: NAME }); } catch (e) { err = e.message; }
    await dbPut("sites", site);
    let errName = ""; try { await m.applyBulkSeal({ siteId: ids.site, reportIds: [ids.o02b], name: "  " }); } catch (e) { errName = e.message; }
    return { done: r1.done.length, skipped: r1.skipped.map((s) => s.reason), s30, err, errName };
  }, [ids, NAME]);
  check("同じ日報を2回渡しても印は1つ・確定済みは対象外", dl.done === 1 && dl.s30?.name === NAME && dl.skipped.length === 1 && /確定済み/.test(dl.skipped[0]), JSON.stringify(dl));
  check("工事完了の現場・名前が空では押印しない", /工事完了/.test(dl.err) && /名前/.test(dl.errName), `${dl.err} / ${dl.errName}`);
  check("DB の版は 10 のまま", (await page.evaluate(async () => (await import("/js/db.js")).DB_VERSION)) === 10);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
