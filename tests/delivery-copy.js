// 日報の搬入・搬出「📋 過去の搬入から選択」「📋 過去の搬出から選択」を確かめる（架空データ・Chromium）。
//   ・同じ現場のほかの日報（この日報自身・この日付より後・削除済み・別の現場は除く）の搬入・搬出を、日付→日報→行の順に選んで「追加」する
//   ・入力中の搬入・搬出は上書き・削除しない。元の日報は変わらない。追加した行は新しいid・状況「予定」
//   ・同じ内容が既にあれば重複の可能性を表示し、追加の前に件数を確認する。キャンセルでは何も変わらない
//   ・現場作業なしの日にも追加でき、人数・人工・請求人工・進捗率・巡回点検は変わらない
//   ・現場掲示・A3・PDF・カレンダーの件数・バックアップ／復元に反映。前の日報から作成は従来どおり
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { restoreViaUi } = require("./helpers/restore");
const { waitForAsync } = require("./helpers/wait");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-copy-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  let dialogAnswer = true;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); dialogAnswer ? d.accept() : d.dismiss(); });
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "搬入搬出コピーの確認現場", startDate: "2026-08-01", endDate: "2026-12-20" });
    const other = await createSite({ name: "別の現場", startDate: "2026-08-01", endDate: "2026-12-20" });
    const d = (id, direction, time, item, extra = {}) => ({ id, direction, time, item, quantity: "", vendor: "", origin: "", destination: "", vehicle: "", status: "done", note: "", ...extra });
    const mk = async (siteId, date, extra) => { const r = stampNew({ siteId, date, dayStatus: "work", siteSupervisorNames: [], companies: [{ companyId: "c" + date, companyName: "前日工業", occupation: "塗装", actualWorkerCount: "3", billingManDays: "2" }], ...extra }); await dbPut("reports", r); await new Promise((x) => setTimeout(x, 15)); return r.id; };
    return {
      siteId: site.id, otherSiteId: other.id,
      old: await mk(site.id, "2026-08-20", { deliveries: [d("o1", "in", "08:30", "八月の足場材", { quantity: "20本", vendor: "足場リース", vehicle: "4t車" })] }),
      prev: await mk(site.id, "2026-09-01", { deliveries: [d("p1", "in", "09:00", "シーリング材", { quantity: "10ケース", vendor: "アオバ塗装工業", origin: "倉庫", destination: "北側ゲート", vehicle: "2t車", note: "誘導員1名" }), d("p2", "in", "13:00", "塗料", { quantity: "5缶", vendor: "○○塗料" }), d("p3", "out", "16:00", "残材", { quantity: "1台分", vendor: "産廃運搬", origin: "現場", destination: "処分場", vehicle: "4tダンプ" })] }),
      sameA: await mk(site.id, "2026-09-02", { deliveries: [d("a1", "in", "10:00", "同日A日報の資材")] }),
      sameB: await mk(site.id, "2026-09-02", { deliveries: [d("b1", "in", "11:00", "同日B日報の資材"), d("b2", "in", "14:00", "同日B日報の追加資材")] }),
      target: await mk(site.id, "2026-09-03", { deliveries: [d("t1", "in", "07:30", "当日の既存の搬入", { vendor: "既存運送" })], progressPercent: 40, patrolChecklist: { morningMeeting: "good" } }),
      nowork: await mk(site.id, "2026-09-04", { dayStatus: "nowork", companies: [], deliveries: [] }),
      future: await mk(site.id, "2026-09-10", { deliveries: [d("f1", "in", "09:00", "未来の搬入")] }),
      otherSite: await mk(other.id, "2026-09-01", { deliveries: [d("x1", "in", "09:00", "別現場の搬入")] })
    };
  });
  const get = (id) => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), id);
  const dumpOthers = () => page.evaluate(async (keep) => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => !keep.includes(r.id)).sort((a, b) => a.id.localeCompare(b.id))), [ids.target, ids.nowork]);
  const othersBefore = await dumpOthers();
  const targetBefore = await get(ids.target);

  const openReport = async (id) => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${ids.siteId}/report/${id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400); };
  const formRows = () => page.$$eval(".delivery-row", (rs) => rs.map((r) => `${r.querySelector(".dlvDirection").value}|${r.querySelector(".dlvTime").value}|${r.querySelector(".dlvItem").value}`));
  const panel = () => page.evaluate(() => ({ title: document.querySelector("#dlvPickPanel .copy-pick-head b")?.textContent || "", reportBtns: [...document.querySelectorAll("#dlvPickPanel [data-dlv-report]")].map((b) => b.dataset.dlvReport), dates: [...document.querySelectorAll("#dlvPickPanel .copy-pick-date")].map((p) => p.textContent), text: document.getElementById("dlvPickPanel").textContent }));
  const save = async () => { await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500); };

  // ===== 1・3・10・11 選べる日報（9/3 の日報を編集）=====
  await openReport(ids.target);
  const startRows = await formRows();
  check("既存の搬入・搬出の入力ボタンはそのまま・「📋 過去の搬入から選択」「📋 過去の搬出から選択」がある", (await page.isVisible("#addDeliveryBtn")) && (await page.isVisible("#addCarryOutBtn")) && (await page.textContent("#pickPastDeliveryBtn")).includes("過去の搬入から選択") && (await page.textContent("#pickPastCarryOutBtn")).includes("過去の搬出から選択"));
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(300);
  let pn = await panel();
  check("過去の搬入: この現場のこの日付までの日報だけ（9/2 の2件・9/1）。未来（9/10）・この日報自身・別の現場は出ない", pn.title === "2026年9月の搬入" && pn.reportBtns.join() === [ids.sameA, ids.sameB, ids.prev].join() && !pn.text.includes("未来の搬入") && !pn.text.includes("別現場") && !pn.reportBtns.includes(ids.target), JSON.stringify(pn));
  check("10 同じ日（9/2）に日報が2件あれば、1件ずつ別に選ぶ（まとめない）", pn.dates[0].includes("日報2件"));

  // ===== 1・4・5・6・7 前日（9/1）の搬入を2件選んで追加 =====
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.prev}"]`); await page.waitForTimeout(200);
  const rowText = await page.textContent("#dlvPickPanel .dlv-pick-list");
  check("その日の搬入だけを一覧（搬出は出ない）・保存されている項目（数量・業者・元・先・車両・備考）を表示", rowText.includes("シーリング材") && rowText.includes("10ケース") && rowText.includes("アオバ塗装工業") && rowText.includes("倉庫") && rowText.includes("北側ゲート") && rowText.includes("2t車") && rowText.includes("誘導員1名") && rowText.includes("塗料") && !rowText.includes("残材"));
  await page.check('#dlvPickPanel [data-dlv-row="0"]'); await page.check('#dlvPickPanel [data-dlv-row="1"]');
  check("4 選んだ件数を表示（選択 2件）・追加ボタンに件数", (await page.textContent("#dlvPickPanel .dlv-pick-count")).includes("選択 2件") && (await page.textContent("#dlvPickPanel [data-dlv-add]")).includes("選択した搬入を追加（2件）"));
  dialogs.length = 0;
  await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(300);
  check("追加の前に件数を確認する（2件追加されます）", dialogs.some((m) => m.includes("2件") && m.includes("追加")), dialogs.join(" / "));
  let rows = await formRows();
  check("1・4・5 前日の搬入2件を末尾に追加・入力中の搬入（当日の既存）は残る", rows.join() === [...startRows, "in|09:00|シーリング材", "in|13:00|塗料"].join() && (await page.isHidden("#dlvPickPanel")), rows.join(","));
  // 2 前日の搬出も追加
  await page.click("#pickPastCarryOutBtn"); await page.waitForTimeout(200);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.prev}"]`); await page.waitForTimeout(200);
  await page.check('#dlvPickPanel [data-dlv-row="0"]'); await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(300);
  rows = await formRows();
  check("2 前日の搬出（区分「搬出」のまま）を追加", rows[rows.length - 1] === "out|16:00|残材", rows.join(","));
  // 3 任意の過去の日（前の月 8/20）から
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(200);
  await page.click('#dlvPickPanel [data-dlv-month="1"]'); await page.waitForTimeout(200);
  pn = await panel();
  check("3 ［◀ 前の月］で過去の任意の日（8/20）まで選べる", pn.title === "2026年8月の搬入" && pn.reportBtns.join() === ids.old);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.old}"]`); await page.waitForTimeout(200);
  await page.check('#dlvPickPanel [data-dlv-row="0"]'); await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(300);
  // 編集できる（時刻・数量を当日に合わせる）
  const last = page.locator(".delivery-row").last();
  await last.locator(".dlvTime").fill("10:15"); await last.locator(".dlvQuantity").fill("15本");
  // 9 キャンセルでは何も変わらない
  const beforeCancel = await formRows();
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(200);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.sameB}"]`); await page.waitForTimeout(200);
  await page.check('#dlvPickPanel [data-dlv-row="0"]');
  await page.click("#dlvPickPanel [data-dlv-cancel]"); await page.waitForTimeout(200);
  check("9 キャンセルすると入力中の搬入・搬出は変わらない（選んでいても追加しない）", JSON.stringify(await formRows()) === JSON.stringify(beforeCancel) && (await page.isHidden("#dlvPickPanel")));
  // 確認で「キャンセル」しても追加しない
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(200);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.sameB}"]`); await page.waitForTimeout(200);
  await page.check('#dlvPickPanel [data-dlv-row="1"]');
  dialogAnswer = false; await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(200); dialogAnswer = true;
  check("9 追加の確認で「キャンセル」を押しても追加しない", JSON.stringify(await formRows()) === JSON.stringify(beforeCancel));
  await page.click("#dlvPickPanel [data-dlv-cancel]");
  // 8 同じ内容をもう一度選ぶと重複の可能性を表示
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(200);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.prev}"]`); await page.waitForTimeout(200);
  const dupShown = await page.$$eval("#dlvPickPanel .dlv-pick-item", (ls) => ls.map((l) => l.classList.contains("is-dup")));
  await page.check('#dlvPickPanel [data-dlv-row="0"]');
  dialogs.length = 0; dialogAnswer = false; await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(200); dialogAnswer = true;
  check("8 同じ内容がこの日報にすでにある行に「重複の可能性」を表示し、追加の確認にも出す（自動で削除・統合しない）", dupShown.join() === "true,true" && dialogs.some((m) => m.includes("重複の可能性")) && JSON.stringify(await formRows()) === JSON.stringify(beforeCancel), dialogs.join(" / "));
  await page.click("#dlvPickPanel [data-dlv-cancel]");
  await save();

  const t = await get(ids.target);
  const added = t.deliveries.slice(1);
  // 日報の保存では項目の並びがそろえられるので、項目ごとに比べる
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  check("5 保存後: 当日の既存の搬入（id・内容）はそのまま", sorted(t.deliveries[0]) === sorted(targetBefore.deliveries[0]), `${sorted(t.deliveries[0])} / ${sorted(targetBefore.deliveries[0])}`);
  check("7 追加した行は新しいid（元の id とも互いにも違う）・状況は「予定」・項目は元のまま（時刻・数量は直した値）", added.length === 4 && new Set(added.map((x) => x.id)).size === 4 && !added.some((x) => ["p1", "p2", "p3", "o1"].includes(x.id)) && added.every((x) => x.status === "plan") && added[0].item === "シーリング材" && added[0].vendor === "アオバ塗装工業" && added[0].note === "誘導員1名" && added[3].time === "10:15" && added[3].quantity === "15本" && added[3].vendor === "足場リース", JSON.stringify(added.map((x) => [x.id, x.time, x.item, x.status])));
  check("6・11 コピー元の日報・ほかの日報・別の現場の日報は1文字も変わらない", (await dumpOthers()) === othersBefore);
  check("搬入・搬出を足しただけで、人数・請求人工・進捗率・巡回点検は変わらない", t.companies.length === 1 && ["companyName", "occupation", "actualWorkerCount", "billingManDays"].every((k) => t.companies[0][k] === targetBefore.companies[0][k]) && t.progressPercent === 40 && JSON.stringify(t.patrolChecklist) === JSON.stringify(targetBefore.patrolChecklist) && t.dayStatus === "work");

  // ===== 12 現場作業なしの日にも追加できる =====
  await openReport(ids.nowork);
  await page.click("#pickPastDeliveryBtn"); await page.waitForTimeout(200);
  pn = await panel();
  check("12 現場作業なしの日（9/4）でも選べる（9/3 で保存した搬入も候補に出る）", pn.reportBtns[0] === ids.target);
  await page.click(`#dlvPickPanel [data-dlv-report="${ids.prev}"]`); await page.waitForTimeout(200);
  await page.check('#dlvPickPanel [data-dlv-row="0"]'); await page.click("#dlvPickPanel [data-dlv-add]"); await page.waitForTimeout(300);
  await save();
  const nw = await get(ids.nowork);
  check("12 現場作業なしの日に搬入を追加・保存。日の状態は現場作業なしのまま・業者は空のまま", nw.dayStatus === "nowork" && nw.deliveries.length === 1 && nw.deliveries[0].item === "シーリング材" && nw.companies.filter((c) => c.companyName).length === 0);

  // ===== 13 現場掲示・A3・PDF・カレンダー =====
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.evaluate((sid) => { window.__dashboardDate = { siteId: sid, date: "2026-09-03" }; }, ids.siteId);
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])"); await page.waitForTimeout(500);
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
  const boardText = await page.textContent('#siteDashboard [data-panel="board"]');
  await page.click('#siteDashboard [data-action="print"]');
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const a3 = await page.$eval("#reportPrintFrame", (f) => f.srcdoc); await page.click("#reportPrintCloseBtn");
  const q = await ctx.newPage(); await q.setContent(a3); await q.emulateMedia({ media: "print" }); await q.waitForTimeout(200);
  const a3dlv = await q.evaluate(() => { dispatchEvent(new Event("beforeprint")); return [...document.querySelectorAll("table.dlv tbody tr")].map((tr) => tr.cells[2].textContent); });
  const pdf = Buffer.from(await q.pdf({ preferCSSPageSize: true })).toString("latin1"); await q.close();
  await page.click('#siteDashboard [data-action="pdf"]');
  await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 30000 });
  const pdfSave = await page.textContent("#boardPdfStatus"); await page.click("#boardPdfCloseBtn");
  check("13 現場掲示・A3に追加した搬入・搬出が出る（A3は1ページ・請求人工なし）・PDF保存も作成できる", ["シーリング材", "塗料", "残材", "八月の足場材"].every((x) => boardText.includes(x) && a3dlv.includes(x)) && (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && !a3.includes("請求") && pdfSave.includes("作成しました"), a3dlv.join(","));
  await page.click("#siteDashboard .dash-tab[data-tab=manage]");
  for (let i = 0; i < 24 && !(await page.$('#reportCalendar .cal-cell[data-date="2026-09-03"]')); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  const cal = await page.$eval('#reportCalendar .cal-cell[data-date="2026-09-03"]', (b) => [...b.querySelectorAll(".cal-dlv")].map((s) => s.textContent).join("／"));
  const cal4 = await page.$eval('#reportCalendar .cal-cell[data-date="2026-09-04"]', (b) => [...b.querySelectorAll(".cal-dlv")].map((s) => s.textContent).join("／"));
  check("13 日報カレンダーの件数に反映（9/3 搬入4件・搬出1件、9/4 搬入1件）", cal === "搬入 4件／搬出 1件" && cal4 === "搬入 1件／搬出 なし", `${cal} / ${cal4}`);

  // ===== 14 バックアップ・復元 =====
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#exportBackupBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, "backup.zip"); await dl.saveAs(zipPath);
  const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "dlv-copy-restore-")), { serviceWorkers: "block" });
  const p3 = await ctx2.newPage(); p3.on("pageerror", (e) => errors.push(e.message)); p3.on("dialog", (d) => d.accept());
  await p3.goto(BASE); await p3.waitForSelector("#view-site-list:not([hidden])");
  await p3.goto(`${BASE}#/backup`); await restoreViaUi(p3, zipPath); // 新しい復元の流れ（検査→復元前のバックアップ→一括適用）
  await waitForAsync(p3, async (id) => !!(await (await import("/js/db.js")).dbGet("reports", id)), ids.target, { timeout: 20000 });
  const restored = await p3.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).deliveries, ids.target);
  check("14 バックアップから別の端末に復元しても、追加した搬入・搬出（id・内容）はそのまま", JSON.stringify(restored) === JSON.stringify(t.deliveries));
  await ctx2.close();

  // ===== 15 前の日報から作成は従来どおり（搬入・搬出はコピーしない）=====
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=2026-09-05`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500);
  await page.click("#copyPrevBtn"); await page.waitForTimeout(300);
  check("15 「📋 前の日報から作成」は従来どおり（一番新しい前の日報＝9/4 現場作業なし から作る。業者は無いので空・搬入搬出はコピーしない）", (await page.$$eval(".company-row .companyName", (xs) => xs.map((x) => x.value).join())) === "" && (await page.locator(".delivery-row").count()) === 0);
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
