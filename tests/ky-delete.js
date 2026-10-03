// 危険予知活動表の提出状況から、誤って登録した業者を削除する（提出時刻も一緒に消える）ことを確かめる（架空データ・Chromium）。
//   ・削除するのは その日・その現場・その業者の KY の記録だけ（提出状況・提出時刻・変更履歴）。保存場所から完全に消す
//   ・日報の業者・工種・人数・作業時間・署名・写真・請求人工は変えない。日報に無い業者も削除できる。削除後に正しい業者を登録できる
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const D = "2026-09-15";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ky-delete-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 日報の業者はナダカ工業・野本建装工業・協栄工業（署名・写真・請求人工・作業時間あり）。西原工業は日報に無い
  const ids = await page.evaluate(async (date) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const site = await createSite({ name: "KY削除の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const row = (id, name, trade, n, billing) => ({ companyId: id, companyName: name, occupation: trade, plannedWorkerCount: n, actualWorkerCount: n, workHours: "08:00～17:00", billingManDays: billing, workContent: trade, foremanName: "職長" + id });
    const r = stampNew({ siteId: site.id, date, dayStatus: "work", siteSupervisorNames: [], companies: [row("a", "ナダカ工業", "塗装", "3", "3.5"), row("b", "野本建装工業", "塗装", "2", ""), row("c", "協栄工業", "足場", "4", "4")], patrolChecklist: { morningMeeting: "good" } });
    await dbPut("reports", r);
    for (const cid of ["a", "b", "c"]) await saveSignature({ reportId: r.id, companyId: cid, blob: png });
    await addPhoto(r.id, site.id, new File([png], "p.png", { type: "image/png" }));
    return { siteId: site.id, reportId: r.id };
  }, D);
  const snapshot = () => page.evaluate(async (rid) => { const { dbGet, dbGetAll } = await import("/js/db.js"); return { report: JSON.stringify(await dbGet("reports", rid)), sigs: JSON.stringify((await dbGetAll("signatures")).map((s) => [s.id, s.reportId, s.companyId, s.isDeleted || false, s.imageBlob?.size])), photos: JSON.stringify((await dbGetAll("photos")).map((p) => [p.id, p.reportId, p.isDeleted || false, p.blob?.size])) }; }, ids.reportId);
  const kyAll = () => page.evaluate(async (sid) => (await (await import("/js/db.js")).dbGetAll("kySubmissions", "by_siteId", sid)).map((r) => ({ id: r.id, name: r.vendorName, submitted: r.submitted, at: r.submittedAt, hist: r.history?.length || 0, del: !!r.isDeleted })), ids.siteId);
  const kyRows = () => page.$$eval("#siteDashboard .dash-ky-table tbody tr", (trs) => trs.map((tr) => ({ name: tr.querySelector("td b").textContent, time: tr.querySelectorAll("td")[2].textContent.trim(), del: !!tr.querySelector("[data-ky-delete]") })));

  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, D); await page.waitForTimeout(500);
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  const before = await snapshot();

  // ===== 1・2・8 登録（日報の業者2社＋日報に無い西原工業）と提出時刻 =====
  await page.click('[data-ky-add="ナダカ工業"]'); await page.waitForTimeout(300);
  await page.click('[data-ky-add="野本建装工業"]'); await page.waitForTimeout(300);
  await page.fill("#siteDashboard .dash-ky-name", "西原工業"); await page.click("#siteDashboard .dash-ky-form button[type=submit]"); await page.waitForTimeout(400);
  const kyIds = Object.fromEntries((await kyAll()).map((r) => [r.name, r.id]));
  await page.click(`[data-ky-id="${kyIds["ナダカ工業"]}"][data-ky-state="submitted"]`); await page.waitForTimeout(300);
  await page.click(`[data-ky-id="${kyIds["西原工業"]}"][data-ky-state="submitted"]`); await page.waitForTimeout(300);
  let all = await kyAll();
  let rows = await kyRows();
  check("1・8 KY提出状況に業者を登録（日報に無い西原工業も登録できる）", rows.map((r) => r.name).join() === "ナダカ工業,野本建装工業,西原工業", rows.map((r) => r.name).join());
  check("2 提出済みにすると提出時刻が記録される（ナダカ工業・西原工業）", all.find((r) => r.name === "ナダカ工業").at && all.find((r) => r.name === "西原工業").at && rows.find((r) => r.name === "西原工業").time !== "—");
  check("3 各業者の行に「削除」ボタン（操作の列）", rows.every((r) => r.del) && (await page.textContent("#siteDashboard .dash-ky-table thead")).includes("操作"));
  const nadakaBefore = JSON.stringify(all.find((r) => r.name === "ナダカ工業"));

  // ===== 4・5 確認ダイアログ・キャンセル =====
  await page.click(`[data-ky-delete="${kyIds["西原工業"]}"]`);
  await page.waitForFunction(() => document.getElementById("kyDeleteDialog").open);
  const dlg = (await page.textContent("#kyDeleteDialog")).replace(/\s+/g, " ");
  const focus = await page.evaluate(() => document.activeElement?.id);
  check("4 削除確認: 「危険予知活動表の提出状況から『西原工業』を削除しますか？」・提出時刻も削除・日報や業者情報は削除されない・［キャンセル］［削除する］", dlg.includes("危険予知活動表の提出状況から「西原工業」を削除しますか？") && dlg.includes("提出時刻") && dlg.includes("も削除されます") && dlg.includes("日報や業者の情報") && dlg.includes("キャンセル") && dlg.includes("削除する") && focus === "kyDeleteCancelBtn", dlg);
  await page.click("#kyDeleteCancelBtn"); await page.waitForTimeout(300);
  check("5 キャンセルすると何も変わらない", JSON.stringify(await kyAll()) === JSON.stringify(all) && !(await page.evaluate(() => document.getElementById("kyDeleteDialog").open)));

  // ===== 6・7・9 削除（提出済みの西原工業）=====
  await page.click(`[data-ky-delete="${kyIds["西原工業"]}"]`); await page.waitForFunction(() => document.getElementById("kyDeleteDialog").open);
  await page.click("#kyDeleteConfirmBtn"); await page.waitForTimeout(600);
  all = await kyAll(); rows = await kyRows();
  check("6・9 削除すると西原工業（日報に無い・提出済み）が一覧から消える", rows.map((r) => r.name).join() === "ナダカ工業,野本建装工業", rows.map((r) => r.name).join());
  check("7 提出時刻も消える（記録そのものを保存場所から削除。削除済みの印や履歴も残らない）", !all.some((r) => r.name === "西原工業") && !(await page.evaluate(async (id) => !!(await (await import("/js/db.js")).dbGet("kySubmissions", id)), kyIds["西原工業"])));
  const dash = await page.textContent("#siteDashboard");
  const a3 = await page.evaluate(async ([sid, d]) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { listReportsBySite } = await import("/js/reports.js"); const { listKySubmissions } = await import("/js/ky/kySubmissions.js"); const { dbGet } = await import("/js/db.js");
    return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", sid), reports: await listReportsBySite(sid), signatures: [], date: d, kySubmissions: await listKySubmissions(sid, d) }));
  }, [ids.siteId, D]);
  check("7 削除した業者・提出時刻はダッシュボード・現場掲示・A3に残らない", !dash.includes("西原工業") && !a3.includes("西原工業"));

  // ===== 10・13〜17 日報・署名・写真・請求人工は変わらない =====
  const after = await snapshot();
  const rep = JSON.parse(after.report);
  check("10 日報の業者データは残る（ナダカ工業・野本建装工業・協栄工業）", rep.companies.map((c) => c.companyName).join() === "ナダカ工業,野本建装工業,協栄工業");
  check("13・14・17 日報の人数・作業時間・請求人工は変わらない（日報は1文字も変わらない）", after.report === before.report);
  check("15・16 署名・写真は変わらない", after.sigs === before.sigs && after.photos === before.photos);

  // ===== 11・12 他の業者のKY・提出時刻は残る =====
  check("11・12 他の業者（ナダカ工業）のKY提出状況と提出時刻は残る", JSON.stringify(all.find((r) => r.name === "ナダカ工業")) === nadakaBefore && all.some((r) => r.name === "野本建装工業"));

  // 未提出（提出時刻なし）の業者も削除できる（確認文は「提出時刻は記録されていません」）
  await page.click(`[data-ky-delete="${kyIds["野本建装工業"]}"]`); await page.waitForFunction(() => document.getElementById("kyDeleteDialog").open);
  const dlg2 = await page.textContent("#kyDeleteNote");
  await page.click("#kyDeleteConfirmBtn"); await page.waitForTimeout(500);
  check("未提出の業者も削除できる（提出時刻は記録されていない旨を表示）", dlg2.includes("提出時刻は記録されていません") && !(await kyAll()).some((r) => r.name === "野本建装工業"));

  // ===== 18・19 正しい業者を登録し直す =====
  await page.fill("#siteDashboard .dash-ky-name", "西原建設"); await page.click("#siteDashboard .dash-ky-form button[type=submit]"); await page.waitForTimeout(400);
  const newId = (await kyAll()).find((r) => r.name === "西原建設").id;
  await page.click(`[data-ky-id="${newId}"][data-ky-state="submitted"]`); await page.waitForTimeout(300);
  rows = await kyRows();
  check("18・19 誤登録を削除したあと、正しい業者（西原建設）を登録し、提出時刻を記録できる", rows.some((r) => r.name === "西原建設" && r.time !== "—") && (await kyAll()).find((r) => r.name === "西原建設").at);
  // 同じ名前（西原工業）を登録し直すと、新しい記録（提出時刻なし）として作られる
  await page.fill("#siteDashboard .dash-ky-name", "西原工業"); await page.click("#siteDashboard .dash-ky-form button[type=submit]"); await page.waitForTimeout(400);
  const re = (await kyAll()).find((r) => r.name === "西原工業");
  check("削除した業者名を登録し直すと、前の提出時刻・履歴は引き継がない（未提出・提出時刻なし）", re && !re.submitted && !re.at && re.hist === 1 && re.id !== kyIds["西原工業"]);

  // ===== バックアップに削除した記録が入らない =====
  await page.evaluate(async (id) => (await import("/js/ky/kySubmissions.js")).deleteKyVendor(id), re.id);
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await bk.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ky-delete-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await p3.setInputFiles("#restoreFileInput", zipPath);
  await waitForAsync(p3, async () => (await (await import("/js/db.js")).dbGetAll("reports")).length >= 1, null, { timeout: 20000 });
  await p3.waitForTimeout(500);
  const restoredKy = await p3.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("kySubmissions")).map((r) => r.vendorName).sort().join());
  check("バックアップ・復元: 削除した業者（西原工業・野本建装工業）の記録・提出時刻は入らず、残した記録（ナダカ工業・西原建設）は復元される", restoredKy === "ナダカ工業,西原建設", restoredKy);
  await ctx2.close();

  // 工事完了の現場は削除できない（データ層）
  const blocked = await page.evaluate(async ([sid, id]) => { const { dbGet, dbPut } = await import("/js/db.js"); const s = await dbGet("sites", sid); await dbPut("sites", { ...s, completedAt: new Date().toISOString() }); try { await (await import("/js/ky/kySubmissions.js")).deleteKyVendor(id); return "deleted"; } catch (e) { return e.message; } }, [ids.siteId, kyIds["ナダカ工業"]]);
  check("工事完了の現場は削除できない", blocked.includes("工事完了"), blocked);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
