// 現場ダッシュボードの「🗣 朝礼入力」（朝礼で聞いた業者ごとの今日の実績人数を続けて入力）を確かめる（架空データ・Chromium）。
//   ・保存先は日報の実績人数（companies[].actualWorkerCount）だけ。予定人数・請求人工・ほかの項目は変えない
//   ・業者＋工種は日報の行のまま（1社が複数の工種・1つの工種を複数の業者）。空欄＝未入力、0＝0人
//   ・保存すると日報画面・現場掲示・業者別稼働・人工（1人＝1人工）・03-2（協力会社欄D列・稼動人数表の計）に反映
//   ・作業しない日・日報なしの日は入力しない（日報を自動で作らない）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const D = "2026-09-15";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chorei-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  // 03-2（同梱のテンプレート）を登録
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const ids = await page.evaluate(async (date) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "朝礼入力の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const row = (id, name, trade, planned, actual, billing) => ({ companyId: id, companyName: name, occupation: trade, plannedWorkerCount: planned, actualWorkerCount: actual, billingManDays: billing, workHours: "08:00～17:00", workContent: trade + "の作業", safetyNotes: "注意" });
    const r = stampNew({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", progressPercent: 20, siteSupervisorNames: [],
      companies: [row("n1", "ナダカ工業", "外壁下地補修", "3", "", "5"), row("n2", "ナダカ工業", "塗装", "2", "2", ""), row("n3", "ナダカ工業", "防水", "", "", ""),
        row("m1", "野本建装工業", "塗装", "4", "", "4.5"), row("k1", "協栄工業", "足場", "5", "", ""), row("s1", "西原建設", "足場", "3", "", "")],
      patrolChecklist: { morningMeeting: "good" }, remarks: "既存の連絡事項", workerCountTotal: "2" });
    await dbPut("reports", r);
    const hol = stampNew({ siteId: site.id, date: "2026-09-14", dayStatus: "holiday", companies: [row("h1", "休工工業", "塗装", "", "", "")], siteSupervisorNames: [] });
    await dbPut("reports", hol);
    return { siteId: site.id, reportId: r.id };
  }, D);
  const getR = () => page.evaluate(async (id) => (await import("/js/db.js")).dbGet("reports", id), ids.reportId);
  const before = await getR();

  const openDash = async (date) => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, date);
    await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, date); await page.waitForTimeout(300);
  };
  const openChorei = async () => { await page.click('#siteDashboard [data-action="chorei"]'); await page.waitForFunction(() => document.getElementById("choreiDialog").open); await page.waitForTimeout(200); };
  const rows = () => page.$$eval(".chorei-row", (rs) => rs.map((r) => ({ vendor: r.querySelector(".chorei-vendor").textContent, trade: r.querySelector(".chorei-trade").textContent, plan: r.querySelector(".chorei-plan").textContent, value: r.querySelector(".chorei-count").value, state: r.dataset.state, label: r.querySelector(".chorei-state").textContent })));

  // ===== 開く・表示 =====
  await openDash(D);
  await openChorei();
  let rs = await rows();
  check("朝礼入力画面を開ける（表示している日の日報の業者の行がすべて出る）", rs.length === 6 && (await page.textContent("#choreiTitle")).includes("9月15日"), JSON.stringify(rs.map((r) => r.vendor)));
  check("業者と工種は日報の行のまま（ナダカ工業は外壁下地補修・塗装・防水の3行、足場は協栄工業・西原建設の2行）", rs.map((r) => `${r.vendor}/${r.trade}`).join() === "ナダカ工業/外壁下地補修,ナダカ工業/塗装,ナダカ工業/防水,野本建装工業/塗装,協栄工業/足場,西原建設/足場");
  check("予定人数と実績人数を分けて表示（予定3人・予定 未入力、既存の実績2は入っている）", rs[0].plan === "予定 3人" && rs[2].plan === "予定 未入力" && rs[1].value === "2" && rs[0].value === "");
  check("未入力の行は「未入力」、入力済みは人数（入力済み／未入力が分かる）", rs[0].label === "未入力" && rs[0].state === "blank" && rs[1].label === "2人" && rs[1].state === "done" && (await page.textContent("#choreiProgress")).includes("入力済み 1／6"));

  // ===== 連続入力（Enterで次へ・「次へ」ボタン）・0人と未入力 =====
  await page.locator(".chorei-count").nth(0).focus();
  await page.keyboard.type("4"); await page.keyboard.press("Enter");
  const afterEnter = await page.evaluate(() => [...document.querySelectorAll(".chorei-count")].indexOf(document.activeElement));
  await page.waitForTimeout(50); await page.keyboard.type("3"); // ナダカ工業 塗装 2→3（移った欄は中身が選択されているので打ち直せる）
  await page.click(".chorei-next >> nth=1");
  const afterNext = await page.evaluate(() => [...document.querySelectorAll(".chorei-count")].indexOf(document.activeElement));
  await page.keyboard.type("0"); // 防水 0人
  await page.locator(".chorei-count").nth(3).fill("3"); // 野本建装工業 塗装 3
  await page.locator(".chorei-count").nth(4).fill("5"); // 協栄工業 足場 5
  // 西原建設 足場は聞いていない → 空欄のまま（未入力）
  rs = await rows();
  check("複数の業者を続けて入力できる（Enterで次の業者の欄・「次へ」でその次の欄へ移る。移った欄は中身が選択され、2→3と打ち直せる）", afterEnter === 1 && afterNext === 2);
  check("0人と未入力を区別して表示（防水＝0人、西原建設＝未入力）", rs[2].label === "0人" && rs[2].state === "done" && rs[5].label === "未入力" && rs[5].state === "blank" && (await page.textContent("#choreiProgress")).includes("入力済み 5／6"), rs.map((r) => r.label).join(","));
  // 誤った値は保存しない
  await page.locator(".chorei-count").nth(5).fill("-1"); await page.click("#choreiSaveBtn"); await page.waitForTimeout(300);
  const stillOpen = await page.evaluate(() => document.getElementById("choreiDialog").open);
  check("0以上の整数でない値は保存しない（画面は開いたまま）", stillOpen && (await getR()).companies[5].actualWorkerCount === "");
  await page.locator(".chorei-count").nth(5).fill("");
  const saveBox = await page.locator("#choreiSaveBtn").boundingBox();
  check("保存ボタンは画面内の下の方にある（押しやすい）", saveBox && saveBox.y + saveBox.height <= 1180 && saveBox.height >= 50, JSON.stringify(saveBox));
  await page.click("#choreiSaveBtn");
  await page.waitForFunction(() => !document.getElementById("choreiDialog").open); await page.waitForTimeout(600);

  // ===== 保存先・既存データ =====
  const after = await getR();
  const act = after.companies.map((c) => c.actualWorkerCount);
  check("保存: 日報の実績人数（companies[].actualWorkerCount）に 4・3・0・3・5・未入力（空欄）", act.join("|") === "4|3|0|3|5|", act.join("|"));
  check("予定人数は書き換えない", after.companies.map((c) => c.plannedWorkerCount).join() === before.companies.map((c) => c.plannedWorkerCount).join());
  check("請求人工は書き換えない（5・空・空・4.5・空・空のまま）", after.companies.map((c) => c.billingManDays).join() === before.companies.map((c) => c.billingManDays).join());
  const strip = (r) => JSON.stringify({ ...r, companies: r.companies.map((c) => ({ ...c, actualWorkerCount: undefined })), workerCountTotal: undefined, updatedAt: undefined, version: undefined, lastEditedAt: undefined, updatedByUserId: undefined, updatedByUserName: undefined });
  check("ほかの項目（業者・工種・作業時間・作業内容・巡回点検・連絡事項など）は変わらない", strip(after) === strip(before));
  check("作業人数（合計）は実績人数の合計 15人", after.workerCountTotal === "15", after.workerCountTotal);
  check("新しい人数データ（朝礼専用の保存先）は作らない（日報の項目だけ）", !Object.keys(after).some((k) => /chorei/i.test(k)));

  // ===== 現場掲示・業者別稼働・人工 =====
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
  const model = await page.evaluate(async ([sid, d]) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", sid), reports: await listReportsBySite(sid), signatures: [], date: d, kySubmissions: [] });
    return { works: m.works.map((w) => `${w.vendor}/${w.occupation}:${w.actual ?? "未入力"}:${w.manDays ?? "-"}`), today: m.staff.today };
  }, [ids.siteId, D]);
  check("業者別稼働状況・人工（1人＝1人工）に反映（未入力の西原建設は人数なし）", model.works.join() === "ナダカ工業/外壁下地補修:4:4,ナダカ工業/塗装:3:3,ナダカ工業/防水:0:0,野本建装工業/塗装:3:3,協栄工業/足場:5:5,西原建設/足場:未入力:-" && model.today === 15, model.works.join(" ") + " 本日 " + model.today);
  const board = (await page.textContent('#siteDashboard [data-panel="board"]')).replace(/\s+/g, " ");
  check("現場掲示の画面にすぐ反映（本日の実績合計15人）", board.includes("15人"), board.match(/合計[^。]{0,40}/)?.[0]);
  check("現場掲示に請求人工は出ない", !board.includes("請求"));

  // ===== 日報画面 =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.reportId}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const formVals = await page.$$eval(".company-row", (rs2) => rs2.map((r) => `${r.querySelector(".actualWorkerCount").value}/${r.querySelector(".plannedWorkerCount").value}/${r.querySelector(".billingManDays").value}`));
  check("通常の日報画面にも実績人数が出る（予定・請求人工はそのまま）、作業人数（合計）15", formVals.join() === "4/3/5,3/2/,0//,3/4/4.5,5/5/,/3/" && (await page.inputValue("#workerCountTotal")) === "15", formVals.join(" "));
  // 日報画面で他の項目を入れて保存しても実績人数はそのまま
  await page.fill("#remarks", "朝礼のあと連絡事項を入力"); await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const after2 = await getR();
  check("朝礼のあと日報画面で他の項目を入力・保存しても、朝礼の実績人数は残る", after2.remarks === "朝礼のあと連絡事項を入力" && after2.companies.map((c) => c.actualWorkerCount).join("|") === "4|3|0|3|5|");

  // ===== 03-2（1日分のExcel）=====
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), ids.reportId)]);
  const xf = path.join(dir, "03-2.xlsx"); await dl.saveAs(xf);
  const cells = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js"); const pkg = await WorkbookPackage.open(u.buffer);
    const { parseSharedStrings, readSheetLayout } = await import("/js/report-output/xlsxSheetReader.js");
    const sh = (await pkg.listSheets())[0]; const L = readSheetLayout(await pkg.getText(sh.path), parseSharedStrings(await pkg.getText("xl/sharedStrings.xml")));
    const t = (ref) => L.cells.get(ref)?.text || "";
    return { rows: [7, 9, 11, 13, 15, 17].map((r) => `${t("A" + r)}/${t("B" + r)}/${t("C" + r)}/${t("D" + r)}`), o51: t("O51") };
  }, fs.readFileSync(xf).toString("base64"));
  check("03-2: 協力会社欄（A7から2行おき）のD列（実績）に 4・3・0・3・5・空欄、C列（予定）はそのまま", cells.rows.join() === "ナダカ工業/外壁下地補修/3/4,ナダカ工業/塗装/2/3,ナダカ工業/防水//0,野本建装工業/塗装/4/3,協栄工業/足場/5/5,西原建設/足場/3/", cells.rows.join(" "));
  check("03-2: 稼動人数表の計（O51）は実績の合計 15", cells.o51 === "15", cells.o51);

  // ===== 作業しない日・日報なし =====
  await openDash("2026-09-14");
  await openChorei();
  const hol = await page.evaluate(() => ({ text: document.getElementById("choreiBody").textContent, inputs: document.querySelectorAll(".chorei-count").length, save: !document.getElementById("choreiSaveBtn").hidden }));
  await page.click("#choreiCloseBtn");
  check("作業しない日（休工日）は実績人数を入力できない（入力欄・保存なし）", hol.inputs === 0 && !hol.save && hol.text.includes("休工日"), hol.text.slice(0, 60));
  await openDash("2026-09-20");
  const countBefore = await page.evaluate(async (sid) => (await (await import("/js/reports.js")).listReportsBySite(sid)).length, ids.siteId);
  await openChorei();
  const none = await page.evaluate(() => ({ text: document.getElementById("choreiBody").textContent, inputs: document.querySelectorAll(".chorei-count").length }));
  await page.click('[data-chorei-go="new"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  const countAfter = await page.evaluate(async (sid) => (await (await import("/js/reports.js")).listReportsBySite(sid)).length, ids.siteId);
  check("日報なしの日は日報を自動で作らず、「この日の日報を作成する」で日報の作成画面（その日付）へ", none.inputs === 0 && none.text.includes("日報がまだありません") && (await page.inputValue("#date")) === "2026-09-20" && countAfter === countBefore);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
