// 日報の入力項目とダッシュボードの整理の検証（実ブラウザ・実IndexedDB・画面操作。データは架空）
//   ・作業時間: 開始・終了を30分刻みで選ぶ／時間（開始～終了）を自動計算／保存・開き直し／ダッシュボードに反映
//     以前の作業時間（"8時～17時" や自由入力）を消さない
//   ・本日の現場の流れの種別: 朝礼・打ち合わせ・昼礼・現場巡回を別々に登録・表示。以前の「朝礼・打合せ」も読める
//   ・状態の表示「実績」→「実施済み」（保存値は done のまま）
//   ・「備考」→「連絡事項」（保存先は従来の remarks のまま）。ダッシュボードの「連絡事項」に表示
//   ・業者ごとの安全注意事項をダッシュボードに業者別に表示
//   ・巡回点検記録（03-2の「巡回点検記録」）と職種別の人数（03-2の「稼動人数」）をダッシュボードに表示
//   ・同じ日報から出力した 03-2 Excel の内容が、ダッシュボードの内容と食い違わない
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/dashboard-diary-items.js（鍵ファイルが必要）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-items-"));
  const ctx = await chromium.launchPersistentContext(dir, { acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const today = local(new Date());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const siteId = await page.evaluate(async (start) => (await (await import("/js/sites.js")).createSite({ name: "項目整理の確認現場", startDate: start })).id, local(new Date(Date.now() - 2 * 86400000)));

  // ===== 日報を画面で入力 =====
  await page.goto(`${BASE}#/sites/${siteId}/report/new?date=${today}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.selectOption("#weather", "曇り"); await page.fill("#temperature", "18");
  const a = page.locator(".company-row").first();
  await a.locator(".companyName").fill("サンプル工業"); await a.locator(".occupation").fill("とび工"); await a.locator(".plannedWorkerCount").fill("5"); await a.locator(".actualWorkerCount").fill("5");
  const opts = await a.locator(".workStart option").evaluateAll((os) => os.map((o) => o.value));
  check("作業時間: 開始・終了は30分刻みで選べる（08:00・08:30 あり／08:15 なし）", opts.includes("08:00") && opts.includes("08:30") && !opts.includes("08:15") && opts.length === 49, `${opts.length - 1}件`);
  await a.locator(".workStart").selectOption("08:00");
  const autoEnd = await a.locator(".workEnd").inputValue();
  const info = await a.locator(".workHoursInfo").textContent();
  check("作業時間: 開始を選ぶと終了が9時間後になり、時間（9時間）が自動計算される", autoEnd === "17:00" && info.startsWith("9時間"), `${autoEnd} ${info}`);
  await a.locator(".workContent").fill("足場組立");
  await a.locator(".safetyNotes").fill("・墜落防止\n開口部注意\n足場使用時の安全確認");
  await page.click("#addCompanyBtn");
  const b = page.locator(".company-row").nth(1);
  await b.locator(".companyName").fill("サンプル設備"); await b.locator(".occupation").fill("配管工"); await b.locator(".actualWorkerCount").fill("3");
  await b.locator(".workStart").selectOption("08:30"); await b.locator(".workEnd").selectOption("16:30");
  check("作業時間: 08:30～16:30 は 8時間", (await b.locator(".workHoursInfo").textContent()).startsWith("8時間"));
  await b.locator(".workContent").fill("配管"); await b.locator(".safetyNotes").fill("火気使用時の確認\n感電防止");
  const kinds = [["08:00", "chorei", "全体朝礼"], ["10:00", "uchiawase", "設備打合せ"], ["12:00", "churei", "昼礼・連絡"], ["14:00", "patrol", "3階確認"]];
  const kindOptions = await page.evaluate(() => { document.getElementById("addTimelineBtn").click(); const o = [...document.querySelector(".timeline-row:last-child .flowKind").options].map((x) => x.textContent); document.querySelector(".timeline-row:last-child").remove(); return o; });
  check("種別の選択肢: 朝礼・打ち合わせ・昼礼・現場巡回が別々にある（以前の「朝礼・打合せ」は新しい行には出さない）", ["朝礼", "打ち合わせ", "昼礼", "現場巡回"].every((k) => kindOptions.includes(k)) && !kindOptions.includes("朝礼・打合せ"), kindOptions.join("・"));
  // 新規の通常作業の日報には流れの初期値（基本スケジュール7件）が入るので、この確認では外して確認用の行だけにする
  // （初期値そのものの確認は tests/calendar-quick-edit.js）
  await page.evaluate(() => document.querySelectorAll("#timelineContainer .timeline-row").forEach((r) => r.remove()));
  for (const [t, k, title] of kinds) {
    await page.click("#addTimelineBtn");
    const row = page.locator(".timeline-row").last();
    await row.locator(".flowTime").fill(t); await row.locator(".flowKind").selectOption(k); await row.locator(".flowTitle").fill(title); await row.locator(".flowStatus").selectOption("done");
  }
  const statusLabel = await page.locator(".timeline-row .flowStatus option[value=done]").first().textContent();
  check("状態の表示: 「実績」ではなく「実施済み」", statusLabel === "実施済み");
  const remarksLabel = await page.evaluate(() => document.getElementById("remarks").closest("label").firstChild.textContent.trim());
  check("日報の「備考」の名前が「連絡事項」になっている", remarksLabel === "連絡事項", remarksLabel);
  await page.fill("#remarks", "○○搬入予定\n明日の作業変更");
  await page.selectOption(".patrol-item-row[data-key=openingUsage] select", "bad");
  await page.fill("#patrolComment", "3階開口部の養生を復旧すること");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const rep = await page.evaluate(async (sid) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid), siteId);
  check("保存: 作業時間は従来の項目（workHours）に「08:00～17:00」の形で保存（DBの構造は変えない）", rep.companies[0].workHours === "08:00～17:00" && rep.companies[1].workHours === "08:30～16:30");
  check("保存: 流れの種別は朝礼・打ち合わせ・昼礼・現場巡回として別々に保存", rep.timeline.map((t) => t.kind).join() === "chorei,uchiawase,churei,patrol");
  check("保存: 連絡事項は従来の項目（remarks）に保存", rep.remarks === "○○搬入予定\n明日の作業変更");

  // ===== 開き直す =====
  await page.goto(`${BASE}#/sites/${siteId}/report/${rep.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const re = await page.evaluate(() => [...document.querySelectorAll(".company-row")].map((r) => `${r.querySelector(".workStart").value}-${r.querySelector(".workEnd").value}`));
  check("開き直すと、開始・終了の選択が残っている", re.join() === "08:00-17:00,08:30-16:30", re.join());

  // ===== ダッシュボード =====
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#siteDashboard .dash-flow-item").length >= 4);
  const chips = await page.$$eval("#siteDashboard .dash-flow-item", (els) => els.map((e) => `${e.querySelector(".dash-kind")?.textContent || ""}:${e.querySelector(".dash-badge")?.textContent || ""}`));
  check("ダッシュボード: 流れに種別（朝礼・打ち合わせ・昼礼・現場巡回）と状態「実施済み」が出る", chips.join() === "朝礼:実施済み,打ち合わせ:実施済み,昼礼:実施済み,現場巡回:実施済み", chips.join());
  const dash = await page.textContent("#siteDashboard");
  check("ダッシュボード: 業者別作業に作業時間（08:00～17:00・9時間／08:30～16:30・8時間）", dash.includes("08:00～17:00") && dash.includes("9時間") && dash.includes("08:30～16:30") && dash.includes("8時間"));
  const safety = await page.$$eval("#siteDashboard .dash-safety", (els) => els.map((e) => ({ v: e.querySelector("b").textContent, items: [...e.querySelectorAll("li")].map((l) => l.textContent) })));
  check("ダッシュボード: 安全注意事項が業者別に分かれて表示される", safety.length === 2 && safety[0].v === "サンプル工業" && safety[0].items.join("|") === "墜落防止|開口部注意|足場使用時の安全確認" && safety[1].v === "サンプル設備" && safety[1].items.join("|") === "火気使用時の確認|感電防止", JSON.stringify(safety));
  const notice = await page.evaluate(() => [...document.querySelectorAll("#siteDashboard .dash-card")].find((c) => c.querySelector("h3").textContent.includes("連絡事項"))?.textContent || "");
  check("ダッシュボード: 日報の連絡事項が「連絡事項」として表示される", notice.includes("○○搬入予定") && notice.includes("明日の作業変更"));
  const patrol = await page.evaluate(() => [...document.querySelectorAll("#siteDashboard [data-panel=manage] .dash-card")].find((c) => c.querySelector("h3").textContent.includes("巡回点検"))?.textContent.replace(/\s+/g, " ") || "");
  check("ダッシュボード: 巡回点検（不良1件の項目・是正指示）が表示される", patrol.includes("不良 ×1") && patrol.includes("開口部") && patrol.includes("3階開口部の養生を復旧すること"), patrol.slice(0, 120));
  check("ダッシュボード: 職種別の人数（とび工5人・配管工3人）が人員に出る", dash.includes("とび工5人") && dash.includes("配管工3人"));

  // ===== 同じ日報の 03-2 Excel とダッシュボードが食い違わない =====
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), rep.id)]);
  const xf = path.join(dir, "03-2.xlsx"); await dl.saveAs(xf);
  const cells = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer);
    const s = (await pkg.listSheets())[0];
    const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
    const L = readSheetLayout(await pkg.getText(s.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
    const c = (r) => L.cells.get(r)?.text || "";
    return { A7: c("A7"), B7: c("B7"), D7: c("D7"), E7: c("E7"), G7: c("G7"), A9: c("A9"), B9: c("B9"), D9: c("D9"), G9: c("G9"), M2: c("M2"), M4: c("M4"), L19: c("L19"), F41: c("F41") };
  }, fs.readFileSync(xf).toString("base64"));
  const ok = cells.A7 === "サンプル工業" && cells.B7 === "とび工" && cells.D7 === "5" && cells.E7 === "足場組立" && cells.G7.includes("墜落防止") && cells.A9 === "サンプル設備" && cells.B9 === "配管工" && cells.D9 === "3" && cells.G9.includes("感電防止") && cells.M2.includes("18") && cells.M4.includes("曇り") && cells.L19 === "×" && cells.F41.includes("3階開口部");
  check("03-2 Excel: 業者・職種・実績人数・作業内容・安全注意事項・気温・天候・巡回点検（開口部×）・是正指示がダッシュボードと同じ", ok, JSON.stringify({ ...cells, G7: cells.G7.slice(0, 8), F41: cells.F41.slice(0, 8) }));

  // ===== 以前のデータ（自由入力の作業時間・「8時～17時」・以前の「朝礼・打合せ」）=====
  const oldId = await page.evaluate(async ({ siteId, date }) => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const r = stampNew({ siteId, date, weather: "晴れ", remarks: "以前の備考", companies: [{ companyId: "o1", companyName: "旧工業", actualWorkerCount: "2", workHours: "朝から夕方" }, { companyId: "o2", companyName: "旧設備", actualWorkerCount: "1", workHours: "8時～17時" }], timeline: [{ id: "t", time: "08:00", title: "朝礼", kind: "meeting", status: "done", note: "" }] });
    await dbPut("reports", r); return r.id;
  }, { siteId, date: local(new Date(Date.now() - 86400000)) });
  await page.goto(`${BASE}#/sites/${siteId}/report/${oldId}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const old = await page.evaluate(() => ({ rows: [...document.querySelectorAll(".company-row")].map((r) => ({ s: r.querySelector(".workStart").value, e: r.querySelector(".workEnd").value, info: r.querySelector(".workHoursInfo").textContent })), kind: document.querySelector(".timeline-row .flowKind").value, kindLabel: document.querySelector(".timeline-row .flowKind").selectedOptions[0].textContent, remarks: document.getElementById("remarks").value }));
  check("以前の作業時間: 自由入力（朝から夕方）は消さずに表示し、「8時～17時」は開始08:00・終了17:00として読み込む", old.rows[0].info.includes("以前の入力: 朝から夕方") && old.rows[1].s === "08:00" && old.rows[1].e === "17:00", JSON.stringify(old.rows));
  check("以前の種別「朝礼・打合せ」の行は、その種別のまま開ける。以前の備考は連絡事項の欄に入っている", old.kind === "meeting" && old.kindLabel === "朝礼・打合せ" && old.remarks === "以前の備考");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const saved = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)), oldId);
  check("以前の日報を何も変えずに保存しても、自由入力の作業時間・以前の種別・連絡事項は消えない", saved.companies[0].workHours === "朝から夕方" && saved.companies[1].workHours === "08:00～17:00" && saved.timeline[0].kind === "meeting" && saved.remarks === "以前の備考", `${saved.companies.map((c) => c.workHours).join(" / ")}`);
  const dateBefore = await page.inputValue("#siteDashboard .dash-date-input");
  await page.click("#siteDashboard .dash-nav[data-shift='-1']");
  // 「旧工業」は前の作業日の業者として危険予知活動表の候補にも出るので、日付が変わるのを待つ
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value !== d && document.getElementById("siteDashboard").textContent.includes("旧工業"), dateBefore);
  const oldDash = await page.textContent("#siteDashboard");
  check("ダッシュボード: 以前の日報も表示できる（自由入力の作業時間・「朝礼・打合せ」）", oldDash.includes("朝から夕方") && oldDash.includes("朝礼・打合せ"));

  // ===== A3「今日の現場シート」=====
  await page.click("#siteDashboard .dash-nav[data-today]"); await page.waitForTimeout(300);
  await page.click("#siteDashboard [data-action=print]"); await page.waitForSelector("#reportPrintDialog[open]");
  const a3 = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  check("A3シート: 種別（朝礼など）・連絡事項・安全注意事項が入り、A3横", a3.includes(">朝礼<") && a3.includes("連絡事項") && a3.includes("○○搬入予定") && a3.includes("墜落防止") && a3.includes("size: A3 landscape"));
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
