// 現場掲示（画面の「現場掲示」タブ）と A3「今日の現場シート」の印刷が、同じ内容・同じ欄・同じ版になっているかを確かめる（架空データ・Chromium）。
//   ・「🖨 現場掲示をA3印刷」で印刷画面に渡るHTMLが、表示中の日付の最新の内容（版の表示つき）
//   ・画面の現場掲示の欄（BOARD_SECTIONS）がすべてA3にあり、業者・工種・稼働人数・人工・作業時間・作業内容・安全注意事項・
//     流れ・搬入搬出・重点指示・連絡調整・連絡事項・明日の予定・KY（提出済み／未提出／対象外）が両方に出る
//   ・A3に請求人工・監督向けの情報（今日の確認事項・日誌状況など）・操作ボタン・入力欄が無い
//   ・A3横・1ページで欄からあふれない（情報の多い日も）・別の日付ではその日の内容になる・データは変わらない
//   ・Service Worker のキャッシュに入る印刷用のファイルがサーバーの最新と同じ
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-print-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { addKyVendor, setKyState } = await import("/js/ky/kySubmissions.js");
    const site = await createSite({ name: "掲示確認現場", startDate: "2026-09-20", endDate: "2026-10-31", constructionNumber: "KJ-77" });
    const r1 = stampNew({ siteId: site.id, date: "2026-09-28", weather: "晴れ", temperature: "24", progressPercent: 30, dayStatus: "work", siteSupervisorNames: ["監督A"],
      companies: [
        { companyId: "a", companyName: "掲示塗装", occupation: "塗装工事", plannedWorkerCount: "4", actualWorkerCount: "3", workHours: "08:00～17:00", billingManDays: "2.5", workContent: "外壁中塗り 2階東面", foremanName: "職長甲", safetyNotes: "足場上の墜落防止\n塗料の火気厳禁", machinery: "高所作業車" },
        { companyId: "b", companyName: "掲示設備", occupation: "配管工", actualWorkerCount: "2", workHours: "08:30～16:30", workContent: "給水管 3階" }
      ],
      timeline: [{ id: "t1", time: "08:00", title: "全体朝礼", kind: "chorei", status: "done" }, { id: "t2", time: "10:00", title: "設備打合せ", kind: "uchiawase", status: "plan" }, { id: "t3", time: "13:00", title: "昼礼", kind: "churei", status: "plan" }, { id: "t4", time: "15:00", title: "3階巡回", kind: "patrol", status: "plan" }],
      deliveries: [{ id: "d1", direction: "in", time: "09:00", item: "塗料缶", quantity: "12缶", vendor: "掲示商事", origin: "倉庫", destination: "2階", vehicle: "2t車", status: "done", note: "誘導員配置" }, { id: "d2", direction: "out", time: "16:00", item: "廃材", quantity: "1台", status: "plan" }],
      focusInstructions: "開口部の養生を徹底", workCoordination: "午後は塗装と配管が同じ区画", remarks: "明朝は消防検査", tomorrowPlan: "外壁上塗り 3階" });
    const r2 = stampNew({ siteId: site.id, date: "2026-09-29", weather: "雨", progressPercent: 32, dayStatus: "work",
      companies: [{ companyId: "c", companyName: "翌日内装", occupation: "内装", actualWorkerCount: "5", workHours: "08:00～17:00", workContent: "ボード張り" }],
      focusInstructions: "雨天時の足元注意" });
    await dbPut("reports", r1); await dbPut("reports", r2);
    const a = (await addKyVendor({ siteId: site.id, date: "2026-09-28", vendorName: "掲示塗装" })).record;
    await addKyVendor({ siteId: site.id, date: "2026-09-28", vendorName: "掲示設備" });
    const c = (await addKyVendor({ siteId: site.id, date: "2026-09-28", vendorName: "見学業者" })).record;
    await setKyState(a.id, "submitted"); await setKyState(c.id, "excluded");
    return { siteId: site.id };
  });
  const dataDump = () => page.evaluate(async () => { const { dbGetAll } = await import("/js/db.js"); return JSON.stringify([await dbGetAll("reports"), await dbGetAll("kySubmissions"), await dbGetAll("sites")].map((x) => x.sort((p, q) => p.id.localeCompare(q.id)))); });
  const before = await dataDump();

  const openDate = async (date) => {
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.fill("#siteDashboard .dash-date-input", date); await page.dispatchEvent("#siteDashboard .dash-date-input", "change"); await page.waitForTimeout(600);
    await page.click("#siteDashboard .dash-tab[data-tab=board]");
  };
  // 印刷ボタン → 印刷画面に渡るHTML
  const printedHtml = async () => {
    await page.click("#siteDashboard [data-action=print]");
    await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
    const html = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
    await page.click("#reportPrintCloseBtn"); await page.waitForFunction(() => !document.getElementById("reportPrintDialog").open);
    return html;
  };

  await openDate("2026-09-28");
  const board = await page.evaluate(() => ({
    keys: [...document.querySelectorAll("#siteDashboard [data-panel=board] [data-board-section]")].map((s) => s.dataset.boardSection),
    titles: [...document.querySelectorAll("#siteDashboard [data-panel=board] [data-board-section] > h3")].map((h) => h.childNodes[0].textContent.trim()),
    text: (document.querySelector("#siteDashboard .dash-head").textContent + " " + document.querySelector("#siteDashboard [data-panel=board]").textContent).replace(/\s+/g, " "),
    ver: document.querySelector("#siteDashboard .dash-board-ver")?.textContent || ""
  }));
  const html = await printedHtml();
  const a3 = await (async () => {
    const p = await ctx.newPage(); await p.setContent(html); await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      dispatchEvent(new Event("beforeprint"));
      return {
        keys: [...document.querySelectorAll("[data-section]")].map((s) => s.dataset.section),
        titles: Object.fromEntries([...document.querySelectorAll("[data-section]")].map((s) => [s.dataset.section, s.querySelector("h2").textContent])),
        text: document.body.textContent.replace(/\s+/g, " "),
        overflow: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]").dataset.section),
        controls: document.querySelectorAll("button, input, select, textarea").length
      };
    });
    const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1"); await p.close();
    return { ...r, pages: (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, a3Landscape: /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) };
  })();

  check("4 印刷画面に渡るのは新しい現場掲示のA3（見出し「現場掲示　今日の現場シート」・画面と同じレイアウトの版）", html.includes("現場掲示　今日の現場シート") && board.ver.includes("2026-10-03-2") && html.includes("現場掲示レイアウト 2026-10-03-2版") && !html.includes("日誌状況"), board.ver);
  const missingInA3 = board.keys.filter((k) => k !== "safety" && !a3.keys.includes(k));
  const titleMismatch = board.keys.filter((k) => a3.titles[k] && !board.titles[board.keys.indexOf(k)].endsWith(" " + a3.titles[k]) && board.titles[board.keys.indexOf(k)] !== a3.titles[k]);
  check("5 画面の現場掲示の欄がすべてA3にあり、欄名が同じ（安全注意事項はA3では作業の表の列）", missingInA3.length === 0 && titleMismatch.length === 0 && html.includes("安全注意事項・使用機械"), `画面 ${board.keys.join(",")} / A3 ${a3.keys.join(",")} / 不一致 ${titleMismatch.join(",")}`);
  const items = ["掲示塗装", "塗装工事", "掲示設備", "配管工", "08:00～17:00", "08:30～16:30", "外壁中塗り 2階東面", "給水管 3階", "職長甲", "足場上の墜落防止", "全体朝礼", "設備打合せ", "昼礼", "3階巡回", "塗料缶", "12缶", "掲示商事", "誘導員配置", "廃材", "開口部の養生を徹底", "午後は塗装と配管が同じ区画", "明朝は消防検査", "外壁上塗り 3階", "KJ-77", "進捗 30%", "晴れ"];
  const notOnScreen = items.filter((t) => !board.text.includes(t)), notInA3 = items.filter((t) => !a3.text.includes(t));
  check("5・16 同じ内容が画面とA3の両方に出る（業者・工種・作業時間・作業内容・職長・安全注意事項・流れ（朝礼・打合せ・昼礼・巡回）・搬入搬出・重点指示・連絡調整・連絡事項・明日の予定・工事番号・進捗・天候）", notOnScreen.length === 0 && notInA3.length === 0, `画面に無い ${notOnScreen.join(",")} / A3に無い ${notInA3.join(",")}`);
  check("16 稼働人数・人工（1人＝1人工）: 塗装 予定4/実績3・人工3、設備 実績2・人工2、合計5人・人工5", html.includes("4 / <b>3</b></td><td class=\"c\">3</td>") && html.includes(" / <b>2</b></td><td class=\"c\">2</td>") && html.includes("<b>5</b>人</td><td class=\"c\">5</td>"));
  check("6 KY提出状況が画面とA3の両方に出る（掲示塗装 ✓ 提出済み・掲示設備 未提出・見学業者 対象外、対象2）", ["掲示塗装 ✓ 提出済み", "掲示設備 未提出", "見学業者 対象外"].every((t) => a3.text.includes(t)) && a3.text.includes("対象 2 提出済み 1 未提出 1 対象外 1") && ["掲示塗装 ✓ 提出済み", "掲示設備 未提出", "見学業者 対象外"].every((t) => board.text.includes(t)));
  check("7 請求人工が画面の現場掲示にもA3にも出ない（「請求」の文字・2.5 が無い）", !a3.text.includes("請求") && !a3.text.includes("2.5") && !board.text.includes("請求") && !board.text.includes("2.5"));
  check("8 A3に監督専用の情報・操作が混ざらない（今日の確認事項・日誌状況・未承認・未印刷・提出時刻・ボタン・入力欄が無い）", !/今日の確認事項|日誌状況|未承認|未印刷|未署名|提出時刻/.test(a3.text) && a3.controls === 0 && !/\d{1,2}:\d{2}.*提出済み/.test(a3.text.split("本日の危険予知活動表")[1] || ""));
  check("9・10 A3横・1ページで、欄からあふれない", a3.pages === 1 && a3.a3Landscape && a3.overflow.length === 0, a3.overflow.join(","));

  // 情報の多い日（業者12社・流れ14件・搬入搬出10件・長い文章）
  const heavy = await page.evaluate(async (sid) => {
    const { buildDashboardModel } = await import("/js/dashboard/siteDashboardModel.js"); const { buildTodaySheetHtml } = await import("/js/dashboard/todaySheetHtml.js");
    const { dbGet } = await import("/js/db.js");
    const site = await dbGet("sites", sid);
    const long = "作業内容の長い説明を書いた行です。".repeat(3);
    const r = { id: "h", siteId: sid, date: "2026-09-30", dayStatus: "work", weather: "曇り", progressPercent: 40, focusInstructions: "重点\n".repeat(6), workCoordination: "調整\n".repeat(6), remarks: "連絡\n".repeat(6), tomorrowPlan: "予定\n".repeat(6),
      companies: Array.from({ length: 12 }, (_, i) => ({ companyId: "c" + i, companyName: `業者${i + 1}`, occupation: "工種" + i, actualWorkerCount: String(i + 1), workHours: "08:00～17:00", workContent: long, safetyNotes: "注意事項1\n注意事項2" })),
      timeline: Array.from({ length: 14 }, (_, i) => ({ id: "t" + i, time: `${String(7 + (i % 10)).padStart(2, "0")}:00`, title: "流れの項目" + i, kind: "work", status: "plan" })),
      deliveries: Array.from({ length: 10 }, (_, i) => ({ id: "d" + i, direction: i % 2 ? "out" : "in", time: `${String(8 + i).padStart(2, "0")}:30`, item: "資材" + i, quantity: "10", vendor: "商事" + i, origin: "倉庫", destination: "現場", vehicle: "4t", status: "plan", note: "備考" })) };
    const ky = Array.from({ length: 12 }, (_, i) => ({ id: "k" + i, siteId: sid, date: "2026-09-30", vendorName: `業者${i + 1}`, target: true, submitted: i % 3 !== 0, submittedAt: null }));
    return buildTodaySheetHtml(buildDashboardModel({ site, reports: [r], signatures: [], date: "2026-09-30", kySubmissions: ky }));
  }, ids.siteId);
  const ph = await ctx.newPage(); await ph.setContent(heavy); await ph.waitForTimeout(300);
  const hv = await ph.evaluate(() => { dispatchEvent(new Event("beforeprint")); return [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.closest("[data-section]").dataset.section); });
  const hpdf = Buffer.from(await ph.pdf({ preferCSSPageSize: true })).toString("latin1"); await ph.close();
  check("10 情報の多い日（業者12社・流れ14件・搬入搬出10件）もA3横1ページで、欄からあふれない", (hpdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && hv.length === 0, hv.join(","));

  // 別の日付
  await openDate("2026-09-29");
  const board2 = (await page.textContent("#siteDashboard [data-panel=board]")).replace(/\s+/g, " ");
  const html2 = await printedHtml();
  check("11 別の日付（9/29）では、画面も印刷もその日の内容（翌日内装・雨・重点指示）で、前の日の業者は出ない", board2.includes("翌日内装") && html2.includes("翌日内装") && html2.includes("雨天時の足元注意") && html2.includes("2026年9月29日") && !html2.includes("掲示塗装") && !board2.includes("掲示塗装"));

  check("12 画面表示・印刷の前後で日報・KY・現場のデータは変わらない", (await dataDump()) === before);

  // Service Worker のキャッシュに入った印刷用のファイルがサーバーの最新と同じ（古いファイルが混ざらない）
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => !!(await navigator.serviceWorker.getRegistration())?.active && (await caches.keys()).length > 0, null, { timeout: 30000 });
  await waitForAsync(page, async () => { const k = (await caches.keys())[0]; return !!(await (await caches.open(k)).match("./js/dashboard/boardContent.js")); }, null, { timeout: 30000 });
  const swCheck = await page.evaluate(async () => {
    const key = (await caches.keys()).find((k) => k.startsWith("koji-nippou-"));
    const cache = await caches.open(key);
    const out = {};
    for (const f of ["./js/dashboard/todaySheetHtml.js", "./js/dashboard/boardContent.js", "./js/ui/site-dashboard.js"]) {
      const cached = await (await cache.match(f))?.text();
      const server = await (await fetch(f + "?nocache=" + Date.now(), { cache: "no-store" })).text();
      out[f] = cached === server;
    }
    return { key, out };
  });
  check("SWのキャッシュに入った印刷用・現場掲示のファイルがサーバーの最新と同じ", Object.values(swCheck.out).every(Boolean), JSON.stringify(swCheck));
  const swSrc = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  check("SWは新しい版を取り込むとき、ブラウザの一時保存を使わずサーバーから取り直す（cache: \"reload\"）", /cache\.addAll\(PRECACHE_URLS\.map\(\(url\) => new Request\(url, \{ cache: "reload" \}\)\)\)/.test(swSrc));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
