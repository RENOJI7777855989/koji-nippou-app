// 現場掲示（画面）とA3印刷の上部の情報帯（工期・本日・工事○日目・工期経過・残り・進捗・天気）を確かめる（架空データ・Chromium）。
//   ・工事○日目＝開始日を1日目とした暦日（休工日・作業なし・事務作業日も数える）。工期経過（日）は同じ日数。
//     残り＝表示日から終了日まで（表示日を含めない）。全工期＝開始日〜終了日（両端を含む）。
//   ・進捗は日報に入力された値だけ（工期経過から計算しない）、天気はその日の日報の値だけ。無ければ「未入力」。
//   ・工期未設定・開始前・終了後は「工期未設定」「工事開始前」「工期終了」（0日・マイナスを出さない）。
//   ・基準日はダッシュボードで表示している日付（ブラウザの今日ではない）。画面とA3で同じ値・A3横1ページ。
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const days = (a, b) => Math.round((Date.UTC(...b.split("-").map((v, i) => Number(v) - (i === 1 ? 1 : 0))) - Date.UTC(...a.split("-").map((v, i) => Number(v) - (i === 1 ? 1 : 0)))) / 86400000);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-period-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 工期 2026-04-01〜2026-12-31（275日）。日報: 4/1 通常（進捗5・晴れ） 4/10 通常（進捗12・雨 18℃） 6/1 休工日 6/2 作業なし 6/3 事務作業日
  // 6/4 通常（進捗未入力）。6/5 日報なし。工期未設定の現場も用意
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "工期表示の確認現場", startDate: "2026-04-01", endDate: "2026-12-31", constructionNumber: "K-9" });
    const unset = await createSite({ name: "工期未設定の現場" });
    const co = [{ companyId: "a", companyName: "サンプル工業", occupation: "とび", actualWorkerCount: "3", workHours: "08:00～17:00" }];
    const mk = (date, extra) => stampNew({ siteId: site.id, date, companies: co, ...extra });
    for (const r of [
      mk("2026-04-01", { dayStatus: "work", progressPercent: 5, weather: "晴れ" }),
      mk("2026-04-10", { dayStatus: "work", progressPercent: 12, weather: "雨", temperature: "18" }),
      mk("2026-06-01", { dayStatus: "holiday", companies: [], progressPercent: 30, weather: "曇り" }),
      mk("2026-06-02", { dayStatus: "nowork", companies: [], progressPercent: 30, weather: "晴れ" }),
      mk("2026-06-03", { dayStatus: "office", companies: [], progressPercent: 31, weather: "雨" }),
      mk("2026-06-04", { dayStatus: "work", progressPercent: null, weather: "" })
    ]) await dbPut("reports", r);
    await dbPut("reports", stampNew({ siteId: unset.id, date: "2026-06-01", companies: co, dayStatus: "work", progressPercent: 50, weather: "晴れ" }));
    return { siteId: site.id, unsetId: unset.id };
  });
  const before = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id))));

  // 情報帯（モデル → buildInfoBand）と A3 の情報帯
  const bandOf = (siteId, date) => page.evaluate(async ({ siteId, date }) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildInfoBand } = await import("/js/dashboard/boardContent.js");
    const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
    const m = buildDashboardModel({ site: await dbGet("sites", siteId), reports: (await dbGetAll("reports")).filter((r) => r.siteId === siteId), signatures: [], date, kySubmissions: [] });
    const html = buildTodaySheetHtml(m);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const a3 = Object.fromEntries([...doc.querySelectorAll(".band .bi")].map((b) => [b.querySelector(".bl").textContent, b.querySelector(".bv").textContent]));
    return { band: Object.fromEntries(buildInfoBand(m).map((b) => [b.label, b.value])), a3 };
  }, { siteId, date });
  const same = (r) => JSON.stringify(r.band) === JSON.stringify(r.a3);

  const c1 = await bandOf(ids.siteId, "2026-04-01");
  check("1 開始日当日: 工期経過1日・残り274日・工期 2026/04/01 ～ 2026/12/31（275日）・着工日が無いので着工は未設定", c1.a3["着工"] === "未設定" && c1.a3["工期経過"] === "1日" && c1.a3["残り"] === "274日" && c1.a3["工期"] === "2026/04/01 ～ 2026/12/31（275日）" && same(c1), JSON.stringify(c1.a3));
  const c2 = await bandOf(ids.siteId, "2026-04-10");
  check("2 通常日（4/10）: 工期経過10日・残り265日", c2.a3["工期経過"] === "10日" && c2.a3["残り"] === "265日" && same(c2), JSON.stringify(c2.a3));
  for (const [no, date, label] of [["3", "2026-06-01", "休工日"], ["4", "2026-06-02", "作業なし"], ["5", "2026-06-03", "事務作業日"]]) {
    const r = await bandOf(ids.siteId, date);
    const n = days("2026-04-01", date) + 1;
    check(`${no} ${label}（${date}）でも暦日で数える: 工期経過${n}日・残り${days(date, "2026-12-31")}日・工期275日`, r.a3["工期経過"] === `${n}日` && r.a3["残り"] === `${days(date, "2026-12-31")}日` && r.a3["工期"].includes("（275日）") && same(r), JSON.stringify(r.a3));
  }
  check("6 進捗あり: その日の日報の進捗（4/10 → 12%）", c2.a3["進捗"] === "12%");
  const c7 = await bandOf(ids.siteId, "2026-06-04");
  check("7 進捗未入力の日報（6/4）: 「未入力」（前の日報の31%に戻さない・工期経過から計算しない）", c7.a3["進捗"] === "未入力", c7.a3["進捗"]);
  check("8 天気あり: その日の日報の天気（4/10 → 雨　18℃）", c2.a3["天気"] === "雨　18℃");
  const c9 = await bandOf(ids.siteId, "2026-06-05");
  check("9 天気未入力: 日報の天気が空（6/4）・日報が無い日（6/5）は「未入力」", c7.a3["天気"] === "未入力" && c9.a3["天気"] === "未入力", `${c7.a3["天気"]} / ${c9.a3["天気"]}`);
  check("9 日報が無い日（6/5）の進捗は、それまでで一番新しい日報（6/4）が未入力なので「未入力」", c9.a3["進捗"] === "未入力");
  const c10 = await bandOf(ids.unsetId, "2026-06-01");
  check("10 工期未設定: 工期「未設定」・工期経過／残り「工期未設定」・着工「未設定」（0日を出さない）", c10.a3["工期"] === "未設定" && c10.a3["着工"] === "未設定" && c10.a3["工期経過"] === "工期未設定" && c10.a3["残り"] === "工期未設定" && !Object.values(c10.a3).some((v) => v === "0日"), JSON.stringify(c10.a3));
  const c11 = await bandOf(ids.siteId, "2027-01-05");
  const cEnd = await bandOf(ids.siteId, "2026-12-31");
  check("11 工期終了後（2027/1/5）: 残り「工期終了」（マイナスにしない）・工期経過は終了日までの275日／終了日当日は残り0日・工期経過275日", c11.a3["残り"] === "工期終了" && c11.a3["工期経過"] === "275日" && !Object.values(c11.a3).some((v) => /-\d/.test(v)) && cEnd.a3["残り"] === "0日" && cEnd.a3["工期経過"] === "275日", `${c11.a3["残り"]} / ${cEnd.a3["残り"]}`);
  const c12 = await bandOf(ids.siteId, "2026-03-30");
  check("開始前（3/30）: 工期経過・残り「工事開始前」", c12.a3["工期経過"] === "工事開始前" && c12.a3["残り"] === "工事開始前");

  // 画面（ダッシュボードで表示した日付）と、印刷ボタンで渡るA3
  await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.fill("#siteDashboard .dash-date-input", "2026-04-10"); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(500);
  const screen = await page.$$eval("#siteDashboard .dash-chips .dash-chip", (cs) => cs.map((c) => c.textContent.replace(/\s+/g, " ").trim()));
  await page.click("#siteDashboard .dash-tab[data-tab=board]");
  await page.click("#siteDashboard [data-action=print]");
  await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
  const printed = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
  await page.click("#reportPrintCloseBtn");
  const pBand = await page.evaluate((html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll(".band .bi")].map((b) => `${b.querySelector(".bl").textContent} ${b.querySelector(".bv").textContent}`), printed);
  const expected = ["工期 2026/04/01 ～ 2026/12/31（275日）", "本日 2026/04/10（金）", "工期経過 10日", "着工 未設定", "残り 265日", "進捗 12%", "天気 雨　18℃"];
  check("14 画面の情報帯と印刷ボタンで渡るA3の情報帯が同じ（表示している日 4/10 が基準。ブラウザの今日ではない）", expected.every((t) => screen.includes(t.replace("　", " "))) && JSON.stringify(pBand) === JSON.stringify(expected), `画面 ${screen.join(" | ")}`);
  check("14 A3は新しいレイアウトの版（2026-10-03-4）", printed.includes("現場掲示レイアウト 2026-10-03-4版"));

  // 12・13 A3横1ページ・既存の欄が崩れない（休工日・通常日）
  for (const date of ["2026-04-10", "2026-06-01"]) {
    const html = await page.evaluate(async ({ siteId, date }) => {
      const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js"); const { dbGetAll, dbGet } = await import("/js/db.js");
      return buildTodaySheetHtml(buildDashboardModel({ site: await dbGet("sites", siteId), reports: (await dbGetAll("reports")).filter((r) => r.siteId === siteId), signatures: [], date, kySubmissions: [] }));
    }, { siteId: ids.siteId, date });
    const p = await ctx.newPage(); await p.setContent(html); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      dispatchEvent(new Event("beforeprint"));
      const sheet = document.querySelector(".sheet").getBoundingClientRect();
      return {
        overflow: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]")?.dataset.section),
        bandCut: [...document.querySelectorAll(".band .bv")].filter((v) => v.scrollWidth > v.clientWidth + 1).map((v) => v.textContent),
        sections: [...document.querySelectorAll("[data-section]")].map((s) => s.dataset.section),
        inside: [...document.querySelectorAll("[data-section]")].every((s) => s.getBoundingClientRect().bottom <= sheet.bottom + 0.5)
      };
    });
    const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1"); await p.close();
    check(`12・13 A3（${date}）: A3横1ページ・情報帯の文字が切れない・各欄があふれずシートの中に収まる`, (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) && r.overflow.length === 0 && r.bandCut.length === 0 && r.inside && ["works", "flow", "deliveries", "patrol", "focus", "ky", "staff", "notice", "tomorrow"].every((k) => r.sections.includes(k)), JSON.stringify({ overflow: r.overflow, cut: r.bandCut }));
  }

  check("既存の日報は変わらない", (await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("reports")).sort((a, b) => a.id.localeCompare(b.id))))) === before);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
