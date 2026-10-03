// 「工期経過」（工期開始日から）と「着工○日目」（現場の着工日＝実際に工事を始めた日から）を別々に表示することを確かめる（架空データ・Chromium）。
//   ・着工日は現場情報の新しい任意の欄（actualStartDate）。工期開始日を自動でコピーしない（未設定なら「着工：未設定」）
//   ・どちらも暦日（休工日・作業なし・事務作業日も数える）。工期開始前「工事開始前」、着工前「着工前」、
//     工期終了後は工期経過を終了日までの日数・残り「工期終了」（マイナスにしない）
//   ・進捗は日報の値だけ（未入力なら「未入力」）、天気はその日の日報の値だけ。画面とA3で同じ・A3横1ページ・請求人工なし
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-groundbreaking-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // A: 工期 2026/10/01〜2027/03/31（182日）・着工日は画面から 10/5 を入れる / B: 工期開始日＝着工日＝10/1 / C: 着工日なし
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const a = await createSite({ name: "着工日の確認現場A", startDate: "2026-10-01", endDate: "2027-03-31" });
    const b = await createSite({ name: "着工日の確認現場B", startDate: "2026-10-01", endDate: "2027-03-31", actualStartDate: "2026-10-01" });
    const c = await createSite({ name: "着工日の確認現場C", startDate: "2026-10-01", endDate: "2027-03-31" });
    const co = [{ companyId: "x", companyName: "サンプル工業", occupation: "足場", actualWorkerCount: "3", workHours: "08:00～17:00", billingManDays: "2.5" }];
    const mk = (date, extra) => stampNew({ siteId: a.id, date, companies: co, ...extra });
    for (const r of [
      mk("2026-10-05", { dayStatus: "work", progressPercent: 3, weather: "晴れ", temperature: "22" }),
      mk("2026-10-06", { dayStatus: "holiday", companies: [], progressPercent: 3, weather: "雨" }),
      mk("2026-10-07", { dayStatus: "nowork", companies: [], progressPercent: 4, weather: "曇り" }),
      mk("2026-10-08", { dayStatus: "office", companies: [], progressPercent: 4, weather: "晴れ" }),
      mk("2026-10-09", { dayStatus: "work", progressPercent: null, weather: "" })
    ]) await dbPut("reports", r);
    return { a: a.id, b: b.id, c: c.id };
  });
  const reportsBefore = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((x, y) => x.id.localeCompare(y.id))));

  // ---- 着工日の入力（現場情報の編集）----
  await page.goto(`${BASE}#/sites/${ids.a}/edit`); await page.waitForSelector("#view-site-form:not([hidden])"); await page.waitForTimeout(300);
  const labels = await page.evaluate(() => ["siteFormStartDate", "siteFormEndDate", "siteFormActualStartDate"].map((id) => document.getElementById(id).closest("label").childNodes[0].textContent.trim()));
  const emptyBefore = await page.inputValue("#siteFormActualStartDate");
  await page.fill("#siteFormActualStartDate", "2026-10-05");
  await page.click("#siteForm button[type=submit], #siteFormSaveBtn").catch(() => {});
  await page.waitForSelector("#view-site-detail:not([hidden])");
  const siteA = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("sites", id), ids.a);
  check("現場情報: 「工期開始日」「工期終了日（竣工予定日）」と別に「着工日」の欄があり、既存の現場は空欄（工期開始日をコピーしない）", labels[0] === "工期開始日" && labels[1].startsWith("工期終了日") && labels[2].startsWith("着工日") && emptyBefore === "", labels.join(" / "));
  check("現場情報: 着工日 10/5 を保存（工期開始日 10/1 は変わらない）・現場詳細に着工日を表示", siteA.actualStartDate === "2026-10-05" && siteA.startDate === "2026-10-01" && siteA.endDate === "2027-03-31" && (await page.textContent("#siteDetailActualStartDate")) === "2026-10-05");
  // 着工日を入れていない現場Cは、編集して保存しても未設定のまま
  await page.goto(`${BASE}#/sites/${ids.c}/edit`); await page.waitForSelector("#view-site-form:not([hidden])"); await page.waitForTimeout(300);
  await page.click("#siteForm button[type=submit], #siteFormSaveBtn").catch(() => {});
  await page.waitForSelector("#view-site-detail:not([hidden])");
  const siteC = await page.evaluate(async (id) => (await import("/js/db.js")).dbGet("sites", id), ids.c);
  check("着工日を入れていない現場は保存しても未設定のまま（工期開始日から推測しない）・現場詳細は「未設定」", !siteC.actualStartDate && siteC.startDate === "2026-10-01" && (await page.textContent("#siteDetailActualStartDate")) === "未設定");

  const band = (siteId, date) => page.evaluate(async ({ siteId, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildInfoBand } = await import("/js/dashboard/boardContent.js");
    const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", siteId), reports: (await dbGetAll("reports")).filter((r) => r.siteId === siteId), signatures: [], date, kySubmissions: [] });
    const html = buildTodaySheetHtml(m);
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { band: Object.fromEntries(buildInfoBand(m).map((b) => [b.label, b.value])), a3: Object.fromEntries([...doc.querySelectorAll(".band .bi")].map((b) => [b.querySelector(".bl").textContent, b.querySelector(".bv").textContent])), html };
  }, { siteId, date });

  const a1001 = await band(ids.a, "2026-10-01"), a1002 = await band(ids.a, "2026-10-02");
  check("1 工期開始日（10/1）＝工期経過1日", a1001.a3["工期経過"] === "1日");
  check("2 10/2＝工期経過2日", a1002.a3["工期経過"] === "2日");
  const b1001 = await band(ids.b, "2026-10-01"), b1003 = await band(ids.b, "2026-10-03");
  check("3 工期開始日と着工日が同じ（10/1）: 工期経過1日・着工1日目、10/3は3日・3日目", b1001.a3["工期経過"] === "1日" && b1001.a3["着工"] === "1日目" && b1003.a3["工期経過"] === "3日" && b1003.a3["着工"] === "3日目");
  const a1005 = await band(ids.a, "2026-10-05");
  check("4 工期開始日（10/1）と着工日（10/5）が違う: 10/5は工期経過5日・着工1日目", a1005.a3["工期経過"] === "5日" && a1005.a3["着工"] === "1日目", JSON.stringify(a1005.a3));
  const c1005 = await band(ids.c, "2026-10-05");
  check("5 着工日が未設定: 着工「未設定」（工期経過は5日）", c1005.a3["着工"] === "未設定" && c1005.a3["工期経過"] === "5日");
  const a0930 = await band(ids.a, "2026-09-30");
  check("6 工期開始日前（9/30）: 工期経過・残り「工事開始前」・着工「着工前」", a0930.a3["工期経過"] === "工事開始前" && a0930.a3["残り"] === "工事開始前" && a0930.a3["着工"] === "着工前");
  check("7 着工日前（10/2。工期中）: 着工「着工前」・工期経過2日", a1002.a3["着工"] === "着工前" && a1002.a3["工期経過"] === "2日");
  for (const [no, date, label, n, g] of [["8", "2026-10-06", "休工日", 6, 2], ["9", "2026-10-07", "作業なし", 7, 3], ["10", "2026-10-08", "事務作業日", 8, 4]]) {
    const r = await band(ids.a, date);
    check(`${no} ${label}（${date}）も暦日で数える: 工期経過${n}日・着工${g}日目`, r.a3["工期経過"] === `${n}日` && r.a3["着工"] === `${g}日目` && r.html.includes(`本日は${label}`), JSON.stringify(r.a3));
  }
  check("11 最新の日報の進捗率（10/5 → 3%）", a1005.a3["進捗"] === "3%");
  const a1009 = await band(ids.a, "2026-10-09");
  check("12 最新の日報（10/9）の進捗率が未入力 → 「未入力」（10/8の4%に戻さない・工期から計算しない）", a1009.a3["進捗"] === "未入力");
  check("13 天気あり（10/5 → 晴れ　22℃）", a1005.a3["天気"] === "晴れ　22℃");
  check("14 天気なし（10/9 の日報は空・10/1 は日報なし）→ 「未入力」", a1009.a3["天気"] === "未入力" && a1001.a3["天気"] === "未入力");
  const aEnd = await band(ids.a, "2027-03-31"), aAfter = await band(ids.a, "2027-04-05");
  check("15 工期終了日（3/31）: 工期経過182日・残り0日・工期（182日）", aEnd.a3["工期経過"] === "182日" && aEnd.a3["残り"] === "0日" && aEnd.a3["工期"].includes("（182日）"));
  check("16・17 工期終了後（4/5）: 工期経過は終了日までの182日・残り「工期終了」（負の日数を出さない）・着工は数え続ける", aAfter.a3["工期経過"] === "182日" && aAfter.a3["残り"] === "工期終了" && !Object.values(aAfter.a3).some((v) => /-\d/.test(v)) && aAfter.a3["着工"] === "183日目", JSON.stringify(aAfter.a3));
  check("画面の情報帯とA3の情報帯が同じ値", [a1001, a1005, a1009, aAfter, c1005].every((r) => JSON.stringify(r.band) === JSON.stringify(r.a3)));

  // 画面のダッシュボード（10/5）と、印刷ボタンで渡るA3
  await page.goto(`${BASE}#/sites/${ids.a}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-10-05"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  const chips = await page.$$eval("#siteDashboard .dash-chips .dash-chip", (cs) => cs.map((c) => c.textContent.replace(/\s+/g, " ").trim()));
  await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.click("#siteDashboard [data-action=print]");
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const printed = await page.$eval("#reportPrintFrame", (f) => f.srcdoc); await page.click("#reportPrintCloseBtn");
  const pBand = await page.evaluate((html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll(".band .bi")].map((b) => `${b.querySelector(".bl").textContent} ${b.querySelector(".bv").textContent}`), printed);
  const expected = ["工期 2026/10/01 ～ 2027/03/31（182日）", "本日 2026/10/05（月）", "工期経過 5日", "着工 1日目", "残り 177日", "進捗 3%", "天気 晴れ　22℃"];
  check("画面の表示と印刷画面に渡るA3が同じ（工期・本日・工期経過・着工・残り・進捗・天気）・レイアウトの版 2026-10-03-4", JSON.stringify(pBand) === JSON.stringify(expected) && expected.every((t) => chips.includes(t.replace("　", " "))) && printed.includes("現場掲示レイアウト 2026-10-03-4版"), pBand.join(" | "));

  // 18〜20 A3横1ページ・既存の欄・請求人工なし
  const p = await ctx.newPage(); await p.setContent(printed); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
  const r = await p.evaluate(() => {
    dispatchEvent(new Event("beforeprint"));
    return {
      overflow: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]")?.dataset.section),
      cut: [...document.querySelectorAll(".band .bv")].filter((v) => v.scrollWidth > v.clientWidth + 1).map((v) => v.textContent),
      sections: [...document.querySelectorAll("[data-section]")].map((s) => s.dataset.section),
      text: document.body.textContent
    };
  });
  const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1"); await p.close();
  check("18 A3横・1ページ（欄・情報帯の文字があふれない）", (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) && r.overflow.length === 0 && r.cut.length === 0, JSON.stringify(r.overflow.concat(r.cut)));
  check("19 既存の現場掲示の欄（作業・流れ・搬入搬出・巡回点検・重点指示・KY・人員・連絡調整・連絡事項・明日の予定・現場メモ）が残っている", ["works", "flow", "deliveries", "patrol", "focus", "ky", "staff", "coordination", "notice", "tomorrow", "memo"].every((k) => r.sections.includes(k)), r.sections.join(","));
  check("20 請求人工は出ない（「請求」の文字・2.5 が無い）", !r.text.includes("請求") && !r.text.includes("2.5") && !chips.join().includes("請求"));

  check("既存の日報は変わらない", (await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((x, y) => x.id.localeCompare(y.id))))) === reportsBefore);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
