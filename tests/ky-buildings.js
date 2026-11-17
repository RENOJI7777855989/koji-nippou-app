// 危険予知活動表を棟ごとに表示（2026-11-17、v83）。架空データ・Chromium
//   ・KY の記録は業者ごとに1件のまま。その日の日報の作業行の棟で業者を並べ直す（同じ業者が2つの棟なら両方に出す）
//   ・棟の無い作業行の業者は「棟未設定」、日報に無い業者は「日報に無い業者」。件数は業者ごと（重複して数えない）
//   ・現場掲示の画面・A3・監督管理の表。棟を使わない現場は従来どおり分けない。状態の切り替えは両方の棟の表示にそろう
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const DAY = "2026-10-20";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const seed = (page) => page.evaluate(async (day) => {
  const { createSite, updateSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
  const ky = await import("/js/ky/kySubmissions.js");
  const a = await createSite({ name: "棟ありの確認現場", startDate: "2026-10-01", endDate: "2026-12-20" });
  await updateSite(a.id, { buildings: [{ id: "bTA", name: "TA号棟", active: true, order: 0 }, { id: "bTB", name: "TB号棟", active: true, order: 1 }] });
  const row = (id, b, name, trade) => ({ companyId: id, buildingId: b ? `b${b}` : "", buildingName: b ? `${b}号棟` : "", companyName: name, occupation: trade, actualWorkerCount: "2" });
  await dbPut("reports", stampNew({ siteId: a.id, date: day, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [
    row("c1", "TA", "アオバ塗装工業", "塗装"), row("c2", "TB", "アオバ塗装工業", "塗装"), row("c3", "TB", "イズミ足場工業", "足場"), row("c4", "", "ウエノ建設", "土工")] }));
  const b = await createSite({ name: "道路の確認現場", startDate: "2026-10-01", endDate: "2026-12-20" });
  await dbPut("reports", stampNew({ siteId: b.id, date: day, dayStatus: "work", weather: "晴れ", siteSupervisorNames: [], companies: [{ companyId: "o1", companyName: "オリーブ警備", occupation: "警備", actualWorkerCount: "2" }] }));
  return { a: a.id, b: b.id, addKy: typeof ky.addKyVendor };
}, DAY);
const openDash = async (page, siteId) => {
  await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, DAY);
  await page.waitForFunction((d) => document.querySelector("#siteDashboard .dash-date-input")?.value === d, DAY); await page.waitForTimeout(800);
};
const boardKy = (page) => page.evaluate(() => { const sec = document.querySelector('[data-board-section="ky"]'); return { groups: [...sec.querySelectorAll(".dash-ky-group")].map((g) => g.textContent), lists: [...sec.querySelectorAll(".dash-ky-list")].map((u) => [...u.querySelectorAll("li")].map((l) => l.textContent.replace(/\s+/g, " ").trim())), sum: sec.querySelector(".dash-ky-summary")?.textContent.replace(/\s+/g, " ") || "" }; });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ky-buildings-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  const ids = await seed(page);
  await openDash(page, ids.a);
  // 日報に無い業者を手で登録（監督管理の入力欄）
  await page.click('.dash-tab[data-tab="manage"], [data-dash-tab="manage"]').catch(() => {});
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /監督管理/.test(x.textContent)); b?.click(); });
  await page.waitForSelector(".dash-ky-form"); await page.fill(".dash-ky-name", "クスノキ設備"); await page.click(".dash-ky-form button[type=submit]"); await page.waitForTimeout(800);
  const kyModel = await page.evaluate(async ([s, d]) => {
    const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const { listKySubmissions } = await import("/js/ky/kySubmissions.js"); const m = await import("/js/dashboard/siteDashboardModel.js");
    const k = m.buildKyModel({ records: await listKySubmissions(s, d), reports: await listReportsBySite(s), date: d, site: await getSite(s) });
    return { groups: k.groups.map((g) => [g.label, g.rows.map((r) => r.vendorName).sort()]), target: k.targetCount, not: k.notSubmittedCount };
  }, [ids.a, DAY]);
  check("1. 棟ごと: TA号棟（アオバ）・TB号棟（アオバ・イズミ）・棟未設定（ウエノ）・日報に無い業者（クスノキ）", JSON.stringify(kyModel.groups) === JSON.stringify([["TA号棟", ["アオバ塗装工業"]], ["TB号棟", ["アオバ塗装工業", "イズミ足場工業"]], ["棟未設定", ["ウエノ建設"]], ["日報に無い業者", ["クスノキ設備"]]]), JSON.stringify(kyModel));
  check("2. 件数は業者ごと（2つの棟にいるアオバも1業者）: 対象4・未提出4", kyModel.target === 4 && kyModel.not === 4);
  // 監督管理の表: 棟の見出しの行・アオバを TA で「提出済み」にすると TB の表示もそろう
  const groupRows = await page.$$eval(".dash-ky-table .dash-ky-group-row", (rs) => rs.map((r) => r.textContent.trim()));
  check("3. 監督管理の提出状況の表に棟の見出しの行", JSON.stringify(groupRows) === JSON.stringify(["TA号棟", "TB号棟", "棟未設定", "日報に無い業者"]), JSON.stringify(groupRows));
  await page.click('.dash-ky-table tr.ky-not_submitted:has-text("アオバ塗装工業") >> nth=0 >> [data-ky-state="submitted"]'); await page.waitForTimeout(800);
  const aoba = await page.$$eval(".dash-ky-table tr", (rs) => rs.filter((r) => r.textContent.includes("アオバ塗装工業")).map((r) => r.className));
  check("4. 1つの棟の表示で提出済みにすると、もう1つの棟の表示もそろう（記録は1件）", aoba.length === 2 && aoba.every((c) => c === "ky-submitted"), JSON.stringify(aoba));
  // 現場掲示の画面
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /現場掲示/.test(x.textContent) && x.closest(".dash-tabs")); b?.click(); }); await page.waitForTimeout(400);
  const board = await boardKy(page);
  check("5. 現場掲示の画面: 棟ごとの見出しと業者（提出済み／未提出）・合計は業者ごと（対象4・提出済み1）", JSON.stringify(board.groups) === JSON.stringify(["TA号棟", "TB号棟", "棟未設定", "日報に無い業者"]) && board.lists[1].length === 2 && /対象 4業者 提出済み 1業者 未提出 3業者/.test(board.sum), JSON.stringify(board));
  // A3
  const a3 = await page.evaluate(async ([s, d]) => {
    const { getSite } = await import("/js/sites.js"); const { listReportsBySite } = await import("/js/reports.js"); const { listKySubmissions } = await import("/js/ky/kySubmissions.js"); const m = await import("/js/dashboard/siteDashboardModel.js"); const t = await import("/js/dashboard/todaySheetHtml.js");
    const html = t.buildTodaySheetHtml(m.buildDashboardModel({ site: await getSite(s), reports: await listReportsBySite(s), date: d, kySubmissions: await listKySubmissions(s, d) }));
    const doc = new DOMParser().parseFromString(html, "text/html"); return [...doc.querySelectorAll(".ky-group")].map((g) => g.textContent.replace(/\s+/g, " ").trim());
  }, [ids.a, DAY]);
  check("6. A3（今日の現場シート）も棟ごと", a3.length === 4 && a3[0].startsWith("TA号棟") && /TB号棟.*アオバ塗装工業.*提出済み.*イズミ足場工業/.test(a3[1]), JSON.stringify(a3));
  // 棟を使わない現場
  await openDash(page, ids.b);
  const boardB = await boardKy(page);
  check("7. 棟を使わない現場は分けない（棟の見出しなし）", boardB.groups.length === 0 && boardB.lists.length === 1, JSON.stringify(boardB));
  check("8. ページエラーが無い", errors.length === 0, errors.join(" / "));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
