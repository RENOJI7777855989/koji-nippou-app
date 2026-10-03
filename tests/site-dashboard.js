// 現場ダッシュボード・A3「今日の現場シート」の検証（実ブラウザ・実IndexedDB・画面操作）
// 日誌に入力 → 保存 → ダッシュボードに自動反映 → A3横印刷。03-2のExcel出力に影響しないことも確認する。
// 搬入・搬出: 区分（direction）の無い従来の搬入データが「搬入」として扱われること、搬出の新規登録も確認する。
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/site-dashboard.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "site-dashboard-test");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1180, height: 820 } }); // iPad横相当
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  const today = local(new Date());
  const start = local(new Date(Date.now() - 3 * 86400000));
  const end = local(new Date(Date.now() + 60 * 86400000));

  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // ===== 現場: 工事番号・進捗率 =====
  await page.goto(`${BASE}#/sites/new`); await page.waitForSelector("#view-site-form:not([hidden])");
  await page.fill("#siteFormName", "ダッシュボード検証現場"); await page.fill("#siteFormStartDate", start); await page.fill("#siteFormEndDate", end);
  await page.fill("#siteFormConstructionNumber", "2026-015");
  await page.click("#siteForm button[type=submit]"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const site = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("sites"))[0]);
  check("1 現場に工事番号を保存できる（進捗率は現場ではなく日誌ごとに入力）", site.constructionNumber === "2026-015" && site.progressPercent == null);
  check("1 現場詳細に工事番号が表示される", (await page.textContent("#siteDetailConstructionNumber")) === "2026-015");
  await page.waitForSelector("#siteDashboard:not([hidden])");
  const emptyDash = await page.textContent("#siteDashboard");
  check("2 日誌が無い日のダッシュボード: 「この日の日誌はまだありません」・進捗は未入力・天気は未入力・工事番号", emptyDash.includes("この日の日誌はまだありません") && /進捗\s*未入力/.test(emptyDash) && /天気\s*未入力/.test(emptyDash) && emptyDash.includes("工事番号 2026-015"), emptyDash.replace(/\s+/g, " ").slice(0, 120));

  // ===== 日誌に入力（ダッシュボードの「＋日誌」から開く）=====
  await page.click("#siteDashboard [data-action=diary]"); await page.waitForSelector("#view-report-form:not([hidden])");
  check("3 「＋日誌」で表示中の日付の日誌を新規作成できる", (await page.inputValue("#date")) === today);
  await page.selectOption("#weather", "晴れ"); await page.fill("#temperature", "25");
  const r1 = page.locator(".company-row").first();
  await r1.locator(".companyName").fill("山田型枠"); await r1.locator(".occupation").fill("型枠工"); await r1.locator(".plannedWorkerCount").fill("6"); await r1.locator(".actualWorkerCount").fill("5");
  await r1.locator(".workStart").selectOption("08:00"); await r1.locator(".workEnd").selectOption("17:00"); await r1.locator(".workContent").fill("2階型枠建込"); await r1.locator(".foremanName").fill("山田");
  await page.click("#addCompanyBtn");
  const r2 = page.locator(".company-row").nth(1);
  await r2.locator(".companyName").fill("佐藤鉄筋"); await r2.locator(".occupation").fill("鉄筋工"); await r2.locator(".actualWorkerCount").fill("4"); await r2.locator(".workContent").fill("2階配筋");
  const flows = [["08:00", "chorei", "朝礼・KY", "done"], ["13:00", "work", "午後作業", "plan"], ["17:00", "other", "片付け", "plan"], ["08:30", "work", "型枠工事", "done"]];
  // 新規の通常作業の日報には流れの初期値（基本スケジュール8件）が入るので、この確認では外して確認用の行だけにする
  // （初期値そのものの確認は tests/calendar-quick-edit.js）
  check("新規の通常作業の日報に流れの初期値8件が入っている", (await page.locator(".timeline-row").count()) === 8);
  await page.evaluate(() => document.querySelectorAll("#timelineContainer .timeline-row").forEach((r) => r.remove()));
  for (const [t, k, title, st] of flows) {
    await page.click("#addTimelineBtn");
    const row = page.locator(".timeline-row").last();
    await row.locator(".flowTime").fill(t); await row.locator(".flowKind").selectOption(k); await row.locator(".flowTitle").fill(title); await row.locator(".flowStatus").selectOption(st);
  }
  const dlvs = [["15:00", "仮設材", "1式", "□□産業", "□□倉庫", "南側ゲート", "4t車", "", "plan"], ["10:00", "鉄筋", "10t", "○○建設", "○○工場", "北側ゲート", "10t車", "北側道路から進入\n誘導員1名配置", "done"]];
  for (const [t, item, q, vendor, origin, dest, veh, note, st] of dlvs) {
    await page.click("#addDeliveryBtn");
    const row = page.locator(".delivery-row").last();
    await row.locator(".dlvTime").fill(t); await row.locator(".dlvItem").fill(item); await row.locator(".dlvQuantity").fill(q); await row.locator(".dlvVendor").fill(vendor);
    await row.locator(".dlvOrigin").fill(origin); await row.locator(".dlvDestination").fill(dest); await row.locator(".dlvVehicle").fill(veh); await row.locator(".dlvNote").fill(note); await row.locator(".dlvStatus").selectOption(st);
  }
  // 搬出（「＋ 搬出を追加」から。区分に応じて項目名が搬出元・搬出先になる）
  const outs = [["16:00", "型枠材", "2t", "△△運送", "現場", "△△資材置場", "4t車", "", "plan"], ["13:00", "残土", "8m3", "△△運送", "現場", "○○処分場", "10tダンプ", "マニフェスト持参", "done"]];
  for (const [t, item, q, vendor, origin, dest, veh, note, st] of outs) {
    await page.click("#addCarryOutBtn");
    const row = page.locator(".delivery-row").last();
    await row.locator(".dlvTime").fill(t); await row.locator(".dlvItem").fill(item); await row.locator(".dlvQuantity").fill(q); await row.locator(".dlvVendor").fill(vendor);
    await row.locator(".dlvOrigin").fill(origin); await row.locator(".dlvDestination").fill(dest); await row.locator(".dlvVehicle").fill(veh); await row.locator(".dlvNote").fill(note); await row.locator(".dlvStatus").selectOption(st);
  }
  const outLabels = await page.locator(".delivery-row").last().evaluate((r) => ({ dir: r.querySelector(".dlvDirection").value, labels: [...r.querySelectorAll("[data-label]")].map((e) => e.textContent).join(","), cls: r.classList.contains("is-out") }));
  check("B2 「＋ 搬出を追加」で区分=搬出の行ができ、項目名が搬出時刻・搬出物・搬出業者・搬出元・搬出先になる", outLabels.dir === "out" && outLabels.labels === "搬出時刻,搬出物,搬出業者,搬出元,搬出先" && outLabels.cls, JSON.stringify(outLabels));
  const inLabels = await page.locator(".delivery-row").first().evaluate((r) => [...r.querySelectorAll("[data-label]")].map((e) => e.textContent).join(","));
  check("B2 搬入の行は項目名が搬入時刻・搬入物・搬入業者・搬入元・搬入先", inLabels === "搬入時刻,搬入物,搬入業者,搬入元,搬入先", inLabels);
  // 区分を切り替えると項目名も変わる（切り替えて戻す）
  const firstDir = page.locator(".delivery-row").first().locator(".dlvDirection");
  await firstDir.selectOption("out");
  const switched = await page.locator(".delivery-row").first().locator("[data-label=origin]").textContent();
  await firstDir.selectOption("in");
  check("B2 区分を搬出に切り替えると項目名が「搬出元」になる", switched === "搬出元");
  await page.click("#addTimelineBtn"); // 空の行は保存されない
  await page.fill("#tomorrowPlan", "3階床配筋"); await page.fill("#remarks", "北側道路の片側通行に注意");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const rep = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports"))[0]);
  check("4 日誌に「本日の現場の流れ」4件・搬入2件（全項目）・作業時間を保存（空の行は保存しない）", rep.timeline.length === 4 && rep.deliveries.filter((d) => d.direction === "in").length === 2 && rep.deliveries.some((d) => d.direction === "in" && d.origin === "○○工場" && d.destination === "北側ゲート" && d.vehicle === "10t車" && d.note.includes("誘導員") && d.status === "done") && rep.companies[0].workHours === "08:00～17:00", JSON.stringify({ t: rep.timeline.length, d: rep.deliveries.length }));
  check("B3 搬入2件・搬出2件を1つの日誌に複数登録でき、搬出は区分 out・元／先・車両・状況・備考つきで保存される", rep.deliveries.length === 4 && rep.deliveries.filter((d) => d.direction === "out").length === 2 && rep.deliveries.some((d) => d.direction === "out" && d.item === "残土" && d.origin === "現場" && d.destination === "○○処分場" && d.vehicle === "10tダンプ" && d.status === "done" && d.note === "マニフェスト持参"), JSON.stringify(rep.deliveries.map((d) => d.direction + ":" + d.item)));

  // ===== ダッシュボードへ自動反映 =====
  await page.waitForFunction(() => document.querySelectorAll("#siteDashboard .dash-flow-item").length > 0);
  const flowItems = await page.$$eval("#siteDashboard .dash-flow-item", (els) => els.map((e) => `${e.querySelector(".dash-flow-time").textContent}${e.querySelector(".dash-flow-mark").textContent}${(() => { const t = e.querySelector(".dash-flow-title").cloneNode(true); t.querySelector(".dash-kind")?.remove(); return t.textContent; })()}`));
  check("5 B5 B7 本日の現場の流れが時刻順に表示され、搬入◆・搬出◇が日誌の搬入・搬出から自動的に入る（二重入力なし）", flowItems.join(",") === "08:00●朝礼・KY,08:30●型枠工事,10:00◆鉄筋　10t 搬入,13:00●午後作業,13:00◇残土　8m3 搬出,15:00◆仮設材　1式 搬入,16:00◇型枠材　2t 搬出,17:00●片付け", flowItems.join(" / "));
  const outFlowClass = await page.$$eval("#siteDashboard .dash-flow-item.is-out", (els) => els.length);
  check("B7 流れの搬出は搬入と色を分ける（is-out）", outFlowClass === 2);
  const dash = await page.textContent("#siteDashboard");
  const dlvRows = await page.$$eval("#siteDashboard .dash-delivery summary", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
  check("6 B6 本日の搬入・搬出: 時刻順に、区分（◆搬入／◇搬出）・品名・状況・業者・元 → 先を表示", dlvRows.length === 4 && dlvRows[0] === "10:00◆搬入鉄筋10t完了○○建設○○工場→北側ゲート" && dlvRows[1] === "13:00◇搬出残土8m3完了△△運送現場→○○処分場" && dlvRows[2].startsWith("15:00◆搬入仮設材") && dlvRows[3].startsWith("16:00◇搬出型枠材"), dlvRows.join(" | "));
  check("6 カードの見出しが「本日の搬入・搬出」で、件数（搬入2件・搬出2件）が出る", dash.includes("本日の搬入・搬出") && dash.includes("搬入2件・搬出2件"));
  const outCards = await page.$$eval("#siteDashboard .dash-delivery.is-out", (els) => els.length);
  check("6 搬出のカード行は搬入と色で区別される（is-out）", outCards === 2);
  await page.locator("#siteDashboard .dash-delivery summary").first().click();
  await page.locator("#siteDashboard .dash-delivery summary").nth(1).click();
  const outDetail = await page.locator("#siteDashboard .dash-delivery").nth(1).textContent();
  check("6 搬出をタップすると詳細（搬出業者・搬出元・搬出先・車両・備考）が見える", outDetail.includes("搬出元現場") && outDetail.includes("搬出先○○処分場") && outDetail.includes("10tダンプ") && outDetail.includes("マニフェスト持参"), outDetail.replace(/\s+/g, " ").slice(0, 120));
  const detail = await page.locator("#siteDashboard .dash-delivery").first().textContent();
  check("6 搬入をタップすると詳細（搬入元・搬入先・車両・備考）が見える", detail.includes("○○工場") && detail.includes("10t車") && detail.includes("誘導員1名配置"), detail.replace(/\s+/g, " ").slice(0, 100));
  check("7 本日の人員: 実績9人（予定6）・職長1人・業者2社・累計9人・延べ労働時間72時間", /9人/.test(dash) && dash.includes("予定 6人") && dash.includes("職長1人") && dash.includes("業者2社") && dash.includes("累計（監督・職員を含む）9人") && dash.includes("延べ労働時間72時間"), dash.match(/本日の人員[\s\S]{0,120}/)?.[0].replace(/\s+/g, " "));
  check("8 本日の作業: 業者・職種・予定/実績・作業時間・作業内容・職長", dash.includes("山田型枠") && dash.includes("08:00～17:00") && dash.includes("9時間") && dash.includes("2階型枠建込") && dash.includes("6 / 5"));
  check("9 今日の日誌: 天候・気温・作業・明日の予定", dash.includes("晴れ　25℃") && dash.includes("3階床配筋"));
  await page.click("#siteDashboard .dash-tab[data-tab=manage]"); // 日誌状況は「監督管理」タブ
  const status = await page.$$eval("#siteDashboard .dash-status-row", (els) => Object.fromEntries(els.map((e) => [e.querySelector("span").textContent, e.querySelector("b").textContent])));
  check("10 日誌状況: 提出予定4・未提出3・未署名1・未承認1・未印刷1", status["提出予定"] === "4" && status["未提出"] === "3" && status["未署名"] === "1" && status["未承認（未確認）"] === "1" && status["未印刷"] === "1", JSON.stringify(status));
  await page.click("#siteDashboard .dash-status-row[data-filter=missing]");
  await page.waitForFunction(() => document.getElementById("reportListFilter").value === "missing");
  check("10 日誌状況の「未提出」を押すと、日報一覧が「未入力（日報のない日）」に絞り込まれる", (await page.inputValue("#reportListFilter")) === "missing");

  // 日付の切り替え
  await page.click("#siteDashboard .dash-nav[data-shift='-1']");
  await page.waitForFunction(() => document.getElementById("siteDashboard").textContent.includes("この日の日誌はまだありません"));
  const prevStatus = await page.$$eval("#siteDashboard .dash-status-row b", (els) => els.map((e) => e.textContent));
  check("11 前の日に切り替えると、その日の内容と、その日までの日誌状況になる", prevStatus[0] === "3");
  await page.click("#siteDashboard .dash-nav[data-today]");
  await page.waitForFunction(() => document.querySelectorAll("#siteDashboard .dash-flow-item").length === 8);

  // 「🚚搬入」から日誌の搬入欄へ
  await page.click("#siteDashboard [data-action=deliveries]"); await page.waitForSelector("#view-report-form:not([hidden])");
  const inView = await page.evaluate(() => { const r = document.getElementById("deliveriesHeading").getBoundingClientRect(); return r.top >= -5 && r.top < window.innerHeight; });
  check("12 「🚚搬入・搬出」で、その日の日誌の搬入・搬出の欄が開く（既存の日誌を編集）", inView && (await page.locator(".delivery-row").count()) === 4);
  const reloadedDirs = await page.$$eval(".delivery-row", (rows) => rows.map((r) => `${r.querySelector(".dlvDirection").value}:${r.querySelector(".dlvItem").value}:${r.querySelector("[data-label=origin]").textContent}`));
  check("B4 保存した日誌を開き直すと、搬入・搬出の区分と項目名（搬入元／搬出元）がそのまま", reloadedDirs.join(",") === "in:仮設材:搬入元,in:鉄筋:搬入元,out:型枠材:搬出元,out:残土:搬出元", reloadedDirs.join(","));
  const reopened = { flow: await page.locator(".timeline-row").count(), hours: await page.locator(".company-row .workHours").first().inputValue(), note: await page.locator(".delivery-row .dlvNote").nth(1).inputValue() };
  check("4 保存した日誌を開き直すと、流れ・搬入・作業時間が入っている", reopened.flow === 4 && reopened.hours === "08:00～17:00" && reopened.note.includes("誘導員"), JSON.stringify(reopened));
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");

  // ===== A3横「今日の現場シート」=====
  await page.waitForSelector("#siteDashboard [data-action=print]");
  await page.click("#siteDashboard [data-action=print]"); await page.waitForSelector("#reportPrintDialog[open]");
  const html = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  fs.writeFileSync(path.join(OUT, "today-sheet.html"), html);
  check("13 A3印刷: 今日の現場シート（A3横）の印刷データが作られる", html.includes("今日の現場シート") && /@page \{ size: A3 landscape/.test(html) && html.includes("鉄筋") && html.includes("北側ゲート") && html.includes("連絡事項") && html.includes("現場メモ"));
  const a3 = await page.evaluate((h) => { const d = new DOMParser().parseFromString(h, "text/html"); const t = d.querySelector("table.dlv"); return { title: [...d.querySelectorAll(".box h2")].map((e) => e.textContent).includes("本日の搬入・搬出"), head: t ? [...t.querySelectorAll("th")].map((e) => e.textContent).join("｜") : "", rows: t ? [...t.querySelectorAll("tbody tr")].map((r) => [...r.cells].slice(0, 3).map((c) => c.textContent).join(" ")) : [], flowOut: [...d.querySelectorAll(".flow tr.dlv.out")].length }; }, html);
  check("B8 A3: 「本日の搬入・搬出」の表（時刻｜区分｜品名｜数量｜業者｜元｜先｜車両｜状況｜備考）が時刻順", a3.title && a3.head === "時刻｜区分｜品名｜数量｜業者｜元｜先｜車両｜状況｜備考" && a3.rows.join(",") === "10:00 ◆搬入 鉄筋,13:00 ◇搬出 残土,15:00 ◆搬入 仮設材,16:00 ◇搬出 型枠材" && a3.flowOut === 2, JSON.stringify(a3));
  await page.click("#reportPrintCloseBtn");
  const pdfInfo = async (h, name) => {
    const p2 = await ctx.newPage(); await p2.setContent(h); await p2.waitForTimeout(300);
    await p2.emulateMedia({ media: "print" });
    // 縮小後に、はみ出して切れている欄が無いか（各欄の中身が枠に収まっているか）
    const clipped = await p2.evaluate(() => { dispatchEvent(new Event("beforeprint")); return [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.previousElementSibling?.textContent); });
    const pdf = await p2.pdf({ preferCSSPageSize: true }); await p2.close();
    fs.writeFileSync(path.join(OUT, name), pdf);
    const t = Buffer.from(pdf).toString("latin1"); const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t);
    return { pages: (t.match(/\/Type\s*\/Page[^s]/g) || []).length, w: Number(box?.[1]), h: Number(box?.[2]), clipped };
  };
  const pdf1 = await pdfInfo(html, "today-sheet.pdf");
  check("13 PDFにすると1ページ・A3横（1191×842pt）で、切れている欄が無い", pdf1.pages === 1 && Math.abs(pdf1.w - 1190.55) < 3 && Math.abs(pdf1.h - 841.89) < 3 && pdf1.clipped.length === 0, JSON.stringify(pdf1));
  // 情報が多い日（流れ30件・搬入10件・業者12社）でも1ページに収まる
  const bigHtml = await page.evaluate(async ({ siteId, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js");
    const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const site = await (await import("/js/sites.js")).getSite(siteId);
    const r = { id: "x", date, companies: Array.from({ length: 12 }, (_, i) => ({ companyId: "c" + i, companyName: "業者" + i, actualWorkerCount: "3", workContent: "作業内容の説明が長い場合の表示確認 " + i, workHours: "8:00～17:00" })),
      timeline: Array.from({ length: 30 }, (_, i) => ({ time: `${String(7 + Math.floor(i / 3)).padStart(2, "0")}:${String((i % 3) * 20).padStart(2, "0")}`, title: "作業項目 " + i, kind: "work", status: "plan" })),
      deliveries: Array.from({ length: 12 }, (_, i) => ({ direction: i % 3 === 2 ? "out" : undefined, time: `${String(7 + i).padStart(2, "0")}:30`, item: (i % 3 === 2 ? "残土・産廃" : "資材") + i, quantity: "10t", vendor: "株式会社○○運送" + i, origin: "○○工場第2倉庫", destination: "現場北側ゲート", vehicle: "10tダンプ", note: "誘導員1名・北側道路から進入 " + i, status: "plan" })) };
    return buildTodaySheetHtml(buildDashboardModel({ site, reports: [r], signatures: [], date }));
  }, { siteId: site.id, date: today });
  fs.writeFileSync(path.join(OUT, "today-sheet-busy.html"), bigHtml);
  const pdf2 = await pdfInfo(bigHtml, "today-sheet-busy.pdf");
  check("14 情報が多い日（流れ30件・搬入8件＋搬出4件・業者12社）でも1ページのA3横に収まり、切れている欄が無い", pdf2.pages === 1 && Math.abs(pdf2.w - 1190.55) < 3 && pdf2.clipped.length === 0, JSON.stringify(pdf2));

  // ===== 03-2 Excel出力に影響しない =====
  const key = (() => { try { return require("./helpers/templateKey.js").loadKey(); } catch { return null; } })();
  if (key) {
    await page.goto(`${BASE}#setup=${key}`); await page.waitForSelector("#view-site-list:not([hidden])");
    await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), rep.id)]);
    const f = path.join(OUT, "03-2.xlsx"); await dl.saveAs(f);
    const x = await page.evaluate(async (b64) => {
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const pkg = await WorkbookPackage.open(u.buffer); const sheet = await pkg.getText((await pkg.listSheets())[0].path);
      return { sheets: (await pkg.listSheets()).map((s) => s.name), work: sheet.includes("2階型枠建込"), flowLeak: ["朝礼・KY", "午後作業", "8:00～17:00", "08:00～17:00"].filter((w) => sheet.includes(w)), deliveries: ["搬入 鉄筋", "搬出 残土"].filter((w) => sheet.includes(w)) };
    }, fs.readFileSync(f).toString("base64"));
    check("15 03-2のExcel出力（1日分の様式・業者欄が入る）。流れ・作業時間は03-2に書き込まず、搬入・搬出はダッシュボードと同じく資材・機材搬入の欄に入る", x.sheets[0] === "手書印刷用" && x.work && x.flowLeak.length === 0 && x.deliveries.length === 2, JSON.stringify(x));
  } else {
    check("15 03-2への影響（鍵ファイルが無いため確認できず）", false);
  }

  // ===== 既存の日誌（流れ・搬入の項目が無い古いデータ）でも表示できる =====
  await page.evaluate(async (siteId) => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const d = new Date(Date.now() - 86400000); const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await dbPut("reports", stampNew({ siteId, date, weather: "曇り", companies: [{ companyId: "o1", companyName: "旧データ工業", actualWorkerCount: "3", workContent: "旧データの作業" }] }));
  }, site.id);
  await page.goto(`${BASE}#/sites/${site.id}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.click("#siteDashboard .dash-nav[data-shift='-1']");
  await page.waitForFunction(() => document.getElementById("siteDashboard").textContent.includes("旧データの作業"));
  const oldDash = await page.textContent("#siteDashboard");
  check("16 流れ・搬入の項目が無い古い日誌でも、ダッシュボードが表示される（人員3人）", oldDash.includes("旧データ工業：旧データの作業") && /3人/.test(oldDash) && oldDash.includes("本日の搬入・搬出はありません"));

  // ===== 前の版（区分の無い搬入事項）で保存した日誌との互換性 =====
  const legacy = await page.evaluate(async (siteId) => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const d = new Date(Date.now() - 2 * 86400000); const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // v18（搬入のみの版）が保存した形そのまま: direction が無く、状況 done は当時「搬入済」と表示していた
    const rec = stampNew({ siteId, date, weather: "晴れ", companies: [{ companyId: "l1", companyName: "旧搬入工業", actualWorkerCount: "2", workContent: "旧搬入の日" }],
      timeline: [{ id: "t1", time: "08:00", title: "朝礼", kind: "meeting", status: "done", note: "" }],
      deliveries: [{ id: "d2", time: "14:00", item: "合板", quantity: "50枚", vendor: "旧資材", origin: "旧倉庫", destination: "南側ゲート", vehicle: "4t車", status: "plan", note: "" },
                   { id: "d1", time: "09:00", item: "H鋼", quantity: "3t", vendor: "旧鋼材", origin: "旧工場", destination: "北側ゲート", vehicle: "トレーラー", status: "done", note: "旧備考" }] });
    await dbPut("reports", rec);
    return { id: rec.id, date, before: JSON.stringify(rec.deliveries) };
  }, site.id);
  await page.goto(`${BASE}#/sites/${site.id}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", legacy.date); await page.dispatchEvent("#siteDashboard .dash-date-input", "change");
  await page.waitForFunction(() => document.getElementById("siteDashboard").textContent.includes("旧搬入の日"));
  const legacyRows = await page.$$eval("#siteDashboard .dash-delivery summary", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
  const legacyFlow = await page.$$eval("#siteDashboard .dash-flow-item", (els) => els.map((e) => e.querySelector(".dash-flow-mark").textContent + (() => { const t = e.querySelector(".dash-flow-title").cloneNode(true); t.querySelector(".dash-kind")?.remove(); return t.textContent; })()));
  check("B1 区分の無い従来の搬入データが「◆ 搬入」として時刻順に表示される（状況 done は「完了」）", legacyRows.length === 2 && legacyRows[0] === "09:00◆搬入H鋼3t完了旧鋼材旧工場→北側ゲート" && legacyRows[1].startsWith("14:00◆搬入合板50枚予定") && legacyFlow.join(",") === "●朝礼,◆H鋼　3t 搬入,◆合板　50枚 搬入", legacyRows.join(" | ") + " / " + legacyFlow.join(","));
  const stored = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGet("reports", id)).deliveries), legacy.id);
  check("B1 表示しただけでは従来のデータを書き換えない（保存済みの搬入データは元のまま）", stored === legacy.before);
  await page.goto(`${BASE}#/sites/${site.id}/report/${legacy.id}`); await page.waitForSelector("#view-report-form:not([hidden])");
  const legacyForm = await page.$$eval(".delivery-row", (rows) => rows.map((r) => [r.querySelector(".dlvDirection").value, r.querySelector(".dlvItem").value, r.querySelector(".dlvOrigin").value, r.querySelector(".dlvStatus").value, r.querySelector("[data-label=origin]").textContent].join(":")));
  check("B1 従来の日誌を開くと、搬入データが区分=搬入・項目名「搬入元」で入っている", legacyForm.join(",") === "in:合板:旧倉庫:plan:搬入元,in:H鋼:旧工場:done:搬入元", legacyForm.join(","));
  // 従来の日誌に搬出を1件追加して保存 → 既存の搬入はそのまま残る
  await page.click("#addCarryOutBtn");
  const lr = page.locator(".delivery-row").last();
  await lr.locator(".dlvTime").fill("15:30"); await lr.locator(".dlvItem").fill("廃材"); await lr.locator(".dlvDestination").fill("中間処理場");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  const after = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).deliveries, legacy.id);
  const keep = (id) => { const o = JSON.parse(legacy.before).find((x) => x.id === id); const n = after.find((x) => x.id === id); return n && ["time", "item", "quantity", "vendor", "origin", "destination", "vehicle", "status", "note"].every((k) => (o[k] || "") === (n[k] || "")) && n.direction === "in"; };
  check("B1 従来の日誌に搬出を追加して保存しても、既存の搬入2件は全項目そのまま（区分=搬入）で残り、搬出が1件増える", after.length === 3 && keep("d1") && keep("d2") && after.some((x) => x.direction === "out" && x.item === "廃材" && x.destination === "中間処理場"), JSON.stringify(after.map((x) => x.direction + ":" + x.item)));

  // 閲覧専用の日誌（工事完了で確定した日報）では、流れ・搬入・搬出の追加・削除ボタンが出ない
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); await dbPut("reports", { ...r, finalizedAt: new Date().toISOString() }); }, legacy.id);
  await page.goto(`${BASE}#/sites/${site.id}/report/${legacy.id}`); await page.waitForSelector("#view-report-form:not([hidden])");
  // 画面は日報を読み込む途中で表示され、閲覧専用（read-only-form）になるのは読み込みの後。閲覧専用になってから数える（負荷が高いと先に数えていた）
  await page.waitForSelector("#reportForm.read-only-form");
  const roButtons = await page.evaluate(() => ["#addTimelineBtn", "#addDeliveryBtn", "#addCarryOutBtn", ".delivery-row .removeRowBtn"].filter((sel) => { const el = document.querySelector(sel); return el && el.offsetParent !== null; }));
  check("閲覧専用の日誌では、流れ・搬入・搬出の追加・削除ボタンが表示されない", roButtons.length === 0, roButtons.join(","));
  await page.evaluate(async (id) => { const { dbGet, dbPut } = await import("/js/db.js"); const r = await dbGet("reports", id); delete r.finalizedAt; await dbPut("reports", r); }, legacy.id);
  await page.goto(`${BASE}#/sites/${site.id}`); await page.waitForSelector("#siteDashboard:not([hidden])");

  // 画面のスクリーンショット（目視確認用）
  await page.click("#siteDashboard .dash-nav[data-today]"); await page.waitForTimeout(500);
  await page.locator("#siteDashboard").screenshot({ path: path.join(OUT, "dashboard-ipad.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("17 スマホ幅（390px）でもダッシュボードが横にはみ出さない", !overflow);
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
