// 日報カレンダーから搬入・搬出だけを登録する（現場作業なし・雨天作業不可日の「この日の日報」→［搬入・搬出を追加］）を確かめる（架空データ・Chromium）。
//   ・保存先は既存の日報の搬入・搬出（deliveries）だけ。日の状態・人数・人工・請求人工・雨天の記録は変えない
//   ・保存して戻ると「搬入：あり（n件）」と内容。続けて追加できる。現場掲示・A3・PDF・日報画面にそのまま出る
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-quick-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const site = await createSite({ name: "搬入簡単登録の確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const base = { siteId: site.id, siteSupervisorNames: [], companies: [] };
    const work = stampNew({ ...base, date: "2026-09-09", dayStatus: "work", progressPercent: 30,
      companies: [{ companyId: "a", companyName: "ナダカ工業", occupation: "塗装", actualWorkerCount: "3", workHours: "08:00～17:00", billingManDays: "3.5" }],
      deliveries: [{ id: "old1", direction: "in", time: "09:00", item: "既存の塗料", vendor: "既存商事", status: "done" }], patrolChecklist: { morningMeeting: "good" } });
    const nowork = stampNew({ ...base, date: "2026-09-10", dayStatus: "nowork", remarks: "資材待ち", staffCount: 1, staffWork: "書類" });
    const rain = stampNew({ ...base, date: "2026-09-12", dayStatus: "rain", weather: "雨", rainCancelledWork: "外壁塗装", rainReason: "朝から降雨", staffCount: 2, staffWork: "役所協議", remarks: "明日再開" });
    for (const r of [work, nowork, rain]) await dbPut("reports", r);
    await saveSignature({ reportId: work.id, companyId: "a", blob: png });
    await addPhoto(work.id, site.id, new File([png], "p.png", { type: "image/png" }));
    return { siteId: site.id, work: work.id, nowork: nowork.id, rain: rain.id };
  });
  const getR = (id) => page.evaluate(async (x) => (await import("/js/db.js")).dbGet("reports", x), id);
  const before = { work: JSON.stringify(await getR(ids.work)), nowork: await getR(ids.nowork), rain: await getR(ids.rain), others: await page.evaluate(async () => { const { dbGetAll } = await import("/js/db.js"); return JSON.stringify([await dbGetAll("signatures"), (await dbGetAll("photos")).map((p) => [p.id, p.blob?.size])]); }) };

  const openCal = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$('#reportCalendar .cal-cell[data-date="2026-09-10"]')); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  const cal = (d) => page.$eval(`#reportCalendar .cal-cell[data-date="${d}"]`, (b) => b.className.match(/cal-(?!cell)(\w+)/)?.[1]);
  const openPanel = async (d) => { await page.click(`#reportCalendar .cal-cell[data-date="${d}"]`); await page.waitForFunction(() => document.getElementById("dayPanelDialog").open); };
  const panelText = async () => (await page.textContent("#dayPanelDialog")).replace(/\s+/g, " ");
  const fillDlv = async ({ dir, time, item, quantity = "", vendor = "", origin = "", destination = "", vehicle = "", note = "" }) => {
    await page.click(`#deliveryQuickForm [name=direction][value=${dir}] + span`);
    await page.fill("#deliveryQuickForm [name=time]", time); await page.fill("#deliveryQuickForm [name=item]", item);
    if (quantity) await page.fill("#deliveryQuickForm [name=quantity]", quantity);
    if (vendor) await page.fill("#deliveryQuickForm [name=vendor]", vendor);
    if (origin) await page.fill("#deliveryQuickForm [name=origin]", origin);
    if (destination) await page.fill("#deliveryQuickForm [name=destination]", destination);
    if (vehicle) await page.fill("#deliveryQuickForm [name=vehicle]", vehicle);
    if (note) await page.fill("#deliveryQuickForm [name=note]", note);
  };
  const saveBack = async () => { await page.click('#deliveryQuickForm button[type=submit]'); await page.waitForFunction(() => !document.getElementById("deliveryQuickDialog").open && document.getElementById("dayPanelDialog").open, null, { timeout: 10000 }); await page.waitForTimeout(300); };
  const saveContinue = async (n) => { await page.click("#deliveryQuickForm .delivery-quick-continue"); await page.waitForFunction((k) => document.querySelectorAll("#deliveryQuickSaved li").length === k, n); };

  await openCal();
  // ===== ボタンの有無 =====
  await openPanel("2026-09-09");
  const workBtn = await page.$("[data-day-dlv]");
  await page.click("#dayPanelCloseBtn");
  check("通常作業の日の「この日の日報」には［搬入・搬出を追加］は出ない（日報画面で入力）", !workBtn);

  // ===== 1 現場作業なしの日から搬入を1件（最小入力: 区分・時刻・品名）=====
  await openPanel("2026-09-10");
  const p0 = await panelText();
  check("10（表示）搬入・搬出が無い日は「搬入：なし」「搬出：なし」", p0.includes("搬入：なし") && p0.includes("搬出：なし"), p0.slice(0, 160));
  await page.click("[data-day-dlv]"); await page.waitForFunction(() => document.getElementById("deliveryQuickDialog").open);
  // 必須の確認（品名なし）
  await page.fill("#deliveryQuickForm [name=time]", "10:00"); await page.click('#deliveryQuickForm button[type=submit]'); await page.waitForTimeout(300);
  const req = await page.textContent("#deliveryQuickStatus");
  check("必須（区分・時刻・品名）が足りなければ保存しない", req.includes("品名") && await page.evaluate(() => document.getElementById("deliveryQuickDialog").open) && !((await getR(ids.nowork)).deliveries || []).length, req);
  await fillDlv({ dir: "in", time: "10:00", item: "外壁材" });
  await saveBack();
  let r = await getR(ids.nowork);
  let pt = await panelText();
  check("1 現場作業なしの日に搬入を1件（最小入力）→ 保存して「この日の日報」に戻り「搬入：あり（1件）」", r.deliveries.length === 1 && r.deliveries[0].direction === "in" && r.deliveries[0].item === "外壁材" && pt.includes("搬入：あり（1件）") && pt.includes("10:00 外壁材"), pt.slice(0, 200));
  check("未入力の欄は空欄のまま（0・なし などにしない）", ["quantity", "vendor", "origin", "destination", "vehicle", "note"].every((k) => r.deliveries[0][k] === "") && r.deliveries[0].status === "plan");

  // ===== 2・3・5（続けて追加）搬入・搬出を複数 =====
  await page.click("[data-day-dlv]"); await page.waitForFunction(() => document.getElementById("deliveryQuickDialog").open);
  await fillDlv({ dir: "in", time: "14:00", item: "足場材", quantity: "2t", vendor: "△△運輸", origin: "資材置場", destination: "北側", vehicle: "4t車", note: "誘導員1名" });
  await saveContinue(1);
  const kept = await page.evaluate(() => ({ dir: document.querySelector('#deliveryQuickForm [name=direction]:checked').value, item: document.querySelector("#deliveryQuickForm [name=item]").value }));
  await fillDlv({ dir: "out", time: "16:00", item: "残材", vendor: "□□産業" });
  await saveBack();
  r = await getR(ids.nowork); pt = await panelText();
  check("3・5 続けて追加（2件目の入力欄は空・区分はそのまま）で搬入2件目と搬出を登録", kept.dir === "in" && kept.item === "" && r.deliveries.length === 3);
  check("2・7・8 搬出も登録でき、「搬入：あり（2件）」「搬出：あり（1件）」と時刻・品名・数量・業者が出る", pt.includes("搬入：あり（2件）") && pt.includes("14:00 足場材 2t △△運輸") && pt.includes("搬出：あり（1件）") && pt.includes("16:00 残材 □□産業"), pt.slice(0, 260));
  const d2 = r.deliveries.find((d) => d.item === "足場材");
  check("8 登録内容（数量・業者・搬入元・搬入先・車両・備考）が既存の項目のまま保存される", d2.quantity === "2t" && d2.vendor === "△△運輸" && d2.origin === "資材置場" && d2.destination === "北側" && d2.vehicle === "4t車" && d2.note === "誘導員1名");
  await page.click("#dayPanelCloseBtn");
  check("9 「現場作業なし」のまま（通常作業にならない）・カレンダーも現場作業なし", r.dayStatus === "nowork" && (await cal("2026-09-10")) === "nowork");
  const nw0 = before.nowork;
  check("11 監督・職員・連絡事項・人数は変わらない（作業員の行も作らない）", r.staffCount === nw0.staffCount && r.staffWork === nw0.staffWork && r.remarks === nw0.remarks && !(r.companies || []).length);

  // ===== 4・5・6 雨天作業不可日 =====
  await openPanel("2026-09-12");
  await page.click("[data-day-dlv]"); await page.waitForFunction(() => document.getElementById("deliveryQuickDialog").open);
  await fillDlv({ dir: "in", time: "11:00", item: "シーラー", vendor: "○○商会" }); await saveContinue(1);
  await fillDlv({ dir: "out", time: "15:00", item: "空缶", quantity: "1式" }); await saveContinue(2);
  await fillDlv({ dir: "in", time: "13:00", item: "養生材" }); await saveBack();
  r = await getR(ids.rain); pt = await panelText();
  check("4・5・6 雨天作業不可日に搬入2件・搬出1件 →「搬入：あり（2件）」「搬出：あり（1件）」（時刻順）", r.deliveries.length === 3 && pt.includes("搬入：あり（2件）") && pt.includes("搬出：あり（1件）") && pt.indexOf("11:00 シーラー") < pt.indexOf("13:00 養生材"), pt.slice(0, 260));
  await page.click("#dayPanelCloseBtn");
  const rb = before.rain;
  check("10・16 雨天作業不可日のまま、天気・中止となった予定作業・中止理由・監督/職員・作業内容・連絡事項は変わらない", r.dayStatus === "rain" && (await cal("2026-09-12")) === "rain" && r.weather === rb.weather && r.rainCancelledWork === rb.rainCancelledWork && r.rainReason === rb.rainReason && r.staffCount === rb.staffCount && r.staffWork === rb.staffWork && r.remarks === rb.remarks);
  // 日の状態・搬入以外の項目が1つも変わっていない（搬入・搬出と更新の記録だけ）
  const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  check("日報で変わったのは搬入・搬出（と更新日時などの記録）だけ", diffKeys(before.nowork, await getR(ids.nowork)).every((k) => ["deliveries", "updatedAt", "version", "lastEditedAt", "updatedByUserId", "updatedByUserName"].includes(k)) && diffKeys(before.rain, r).every((k) => ["deliveries", "updatedAt", "version", "lastEditedAt", "updatedByUserId", "updatedByUserName"].includes(k)), JSON.stringify(diffKeys(before.rain, r)));

  // ===== 11・12・13・14 人数・人工・請求人工・現場掲示・A3・PDF =====
  const m = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { listReportsBySite } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js");
    const out = {};
    for (const d of ["2026-09-10", "2026-09-12"]) { const model = buildDashboardModel({ site: await dbGet("sites", sid), reports: await listReportsBySite(sid), signatures: [], date: d, kySubmissions: [] }); out[d] = { html: buildTodaySheetHtml(model), workers: model.staff.today, manDays: model.works.reduce((s, w) => s + (w.manDays || 0), 0) }; }
    return out;
  }, ids.siteId);
  check("11 作業員の人数・人工は0のまま（搬入したから作業員1人、などにしない）", m["2026-09-10"].workers === 0 && m["2026-09-10"].manDays === 0 && m["2026-09-12"].workers === 0);
  check("12 請求人工は変わらない（通常作業の日の3.5のまま）", (await getR(ids.work)).companies[0].billingManDays === "3.5");
  const t10 = m["2026-09-10"].html.replace(/<[^>]+>/g, " ");
  check("13 A3現場掲示に登録した搬入・搬出（外壁材・足場材・残材）と「本日は現場作業なし」", t10.includes("本日は現場作業なし") && t10.includes("外壁材") && t10.includes("足場材") && t10.includes("残材") && t10.includes("△△運輸"));
  const pp = await ctx.newPage(); await pp.setContent(m["2026-09-12"].html); await pp.emulateMedia({ media: "print" }); await pp.waitForTimeout(300);
  const pdf = Buffer.from(await pp.pdf({ preferCSSPageSize: true })); await pp.close();
  const pdfText = await page.evaluate(async (b64) => {
    const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const doc = await pdfjs.getDocument({ data: u, cMapUrl: "/js/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/js/vendor/pdfjs/standard_fonts/" }).promise;
    return { pages: doc.numPages, text: (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join("").normalize("NFKC").replace(/\s+/g, "") };
  }, pdf.toString("base64"));
  check("14 PDF（A3横1ページ）に雨天作業不可日の搬入・搬出（シーラー・養生材・空缶）", pdfText.pages === 1 && pdfText.text.includes("シーラー") && pdfText.text.includes("養生材") && pdfText.text.includes("空缶"));

  // ===== 17 通常の日報画面で確認・編集できる／通常の日報入力が壊れていない =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.nowork}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const formDlv = await page.$$eval(".delivery-row", (rs) => rs.map((x) => `${x.querySelector(".dlvDirection").value}:${x.querySelector(".dlvTime").value}:${x.querySelector(".dlvItem").value}`));
  await page.locator(".delivery-row").nth(0).locator(".dlvQuantity").fill("30枚");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  r = await getR(ids.nowork);
  check("17 カレンダーから登録した搬入・搬出は通常の日報画面に出て、編集・保存できる（日の状態は現場作業なしのまま）", formDlv.join() === "in:10:00:外壁材,in:14:00:足場材,out:16:00:残材" && r.deliveries[0].quantity === "30枚" && r.dayStatus === "nowork", formDlv.join());

  // ===== 15・18・19 既存データ・カレンダー =====
  await openCal();
  check("18 カレンダーの状態は既存のまま（9/9 日報あり系・9/10 現場作業なし・9/12 雨天作業不可日・9/11 日報なし）", ["ok", "partial"].includes(await cal("2026-09-09")) && (await cal("2026-09-10")) === "nowork" && (await cal("2026-09-12")) === "rain" && (await cal("2026-09-11")) === "none");
  const others = await page.evaluate(async () => { const { dbGetAll } = await import("/js/db.js"); return JSON.stringify([await dbGetAll("signatures"), (await dbGetAll("photos")).map((p) => [p.id, p.blob?.size])]); });
  check("15・19 既存の日報（通常作業の日の既存の搬入を含む）・写真・署名はテストの前後で変わらない", JSON.stringify(await getR(ids.work)) === before.work && others === before.others);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
