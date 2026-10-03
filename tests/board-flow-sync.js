// 本日の現場の流れ: 日報データだけを元に、ダッシュボード（現場掲示）・A3印刷・PDFが同じ内容になることを確かめる（架空データ・Chromium）。
// 2026-10-03 の不具合の再発防止: 日報カレンダーから今日以外の日の通常作業日報を作って保存すると、カレンダーには戻るが
// ダッシュボード（現場掲示・A3印刷の元）は今日の日付のままで、保存した日の流れが出なかった。
// 保存後はダッシュボードを保存した日報の日付で表示する。ダッシュボード・A3側で初期値を作らない（日報が無い・特殊な日は出さない）。
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// PDFから取り出した文字は改行で切れ、一部の漢字が互換文字（例: 片→⽚）になるので、NFKCで正規化し空白・改行を除いて「時刻●内容」で照合する
const flatPdf = (text) => String(text || "").normalize("NFKC").replace(/\s+/g, "");
const pdfHas = (text, entries) => entries.every((e) => { const [t, ...rest] = e.split(" "); return flatPdf(text).includes(`${t}●${rest.join(" ")}`); });
const DEFAULT7 = "08:00 朝礼,08:20 作業,10:00 休憩,12:00 昼休憩,15:00 休憩,16:45 片付け開始,17:00 作業終了";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-flow-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // 今日を含む工期。今日の日報は無い。対象日＝今日の3日前（今日以外の日）。既存の日報（流れなし）が5日前にある
  const now = new Date();
  const day = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };
  const T = day(-3);
  const ids = await page.evaluate(async ([start, old]) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "流れ連携の確認現場", startDate: start, endDate: "2099-12-31" });
    const r = stampNew({ siteId: site.id, date: old, dayStatus: "work", weather: "晴れ", progressPercent: 10, siteSupervisorNames: [],
      companies: [{ companyId: "a", companyName: "既存工業", occupation: "塗装", actualWorkerCount: "2", workHours: "08:00～17:00", billingManDays: "2" }], patrolChecklist: { morningMeeting: "good" } });
    await dbPut("reports", r);
    return { siteId: site.id, old: r.id };
  }, [day(-20), day(-5)]);
  const oldBefore = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.old);

  const reportOf = (date) => page.evaluate(async ([sid, d]) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === d) || null, [ids.siteId, date]);
  const openCalendar = async (date) => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])");
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 3 && !(await page.$(`#reportCalendar .cal-cell[data-date="${date}"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  // ダッシュボード（現場掲示タブ）に出ている流れ（搬入・搬出を除く）と表示中の日付
  const boardFlow = async () => {
    await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(300);
    return page.evaluate(() => ({
      date: document.querySelector("#siteDashboard .dash-date-input").value,
      flow: [...document.querySelectorAll('#siteDashboard [data-panel="board"] .dash-flow-item:not(.is-delivery)')].map((x) => `${x.querySelector(".dash-flow-time").textContent} ${x.querySelector(".dash-flow-title").textContent.trim()}`)
    }));
  };
  // 「🖨 現場掲示をA3印刷」で開く印刷画面のHTML（実際に印刷するもの）→ A3表示の流れ、同じHTMLからPDF
  const a3AndPdf = async () => {
    await page.click('#siteDashboard [data-action="print"]');
    await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
    const html = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
    await page.click("#reportPrintCloseBtn");
    const p = await ctx.newPage(); await p.setContent(html); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
    const a3 = await p.evaluate(() => { dispatchEvent(new Event("beforeprint")); return { flow: [...document.querySelectorAll("table.flow tr:not(.dlv)")].map((tr) => `${tr.querySelector(".t").textContent} ${tr.querySelector(".ti").textContent}`), over: [...document.querySelectorAll(".box .content")].filter((c) => c.scrollHeight > c.clientHeight + 1).length, ver: document.querySelector(".ver")?.textContent || "", text: document.body.textContent }; });
    const pdfBuf = Buffer.from(await p.pdf({ preferCSSPageSize: true }));
    await p.close();
    // 作ったPDFから文字を取り出す（アプリ同梱の pdf.js）。流れの欄の「時刻 内容」を順に拾う
    const pdfText = await page.evaluate(async (b64) => {
      const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const doc = await pdfjs.getDocument({ data: u, cMapUrl: "/js/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/js/vendor/pdfjs/standard_fonts/" }).promise;
      const tc = await (await doc.getPage(1)).getTextContent();
      return tc.items.map((i) => i.str).join("\n");
    }, pdfBuf.toString("base64"));
    const pdf = pdfBuf.toString("latin1");
    return { a3, pdfText, pages: (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, a3land: /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) };
  };

  // ===== 1〜6 新規の通常作業日報（カレンダーの日報なしの日＝今日以外）→ 保存 → ダッシュボード・A3・PDF =====
  await openCalendar(T);
  await page.click(`#reportCalendar .cal-cell[data-date="${T}"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
  await page.click('#dayStatusDialog [data-day-status="work"]'); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  check("1 新規の通常作業日報の入力画面に初期値7件", (await page.locator(".timeline-row").count()) === 7);
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
  let r = await reportOf(T);
  check("2・3 保存した日報データに初期値7件が入っている", (r.timeline || []).map((f) => `${f.time} ${f.title}`).join() === DEFAULT7, (r.timeline || []).map((f) => `${f.time} ${f.title}`).join());
  let bf = await boardFlow();
  check("4 ダッシュボード（現場掲示）が保存した日（今日以外）を表示し、7件が出る（不具合の再発防止）", bf.date === T && bf.flow.join() === DEFAULT7, `${bf.date} ${bf.flow.join()}`);
  let out = await a3AndPdf();
  check("5 A3印刷（印刷画面に渡るHTML）に7件", out.a3.flow.join() === DEFAULT7, out.a3.flow.join());
  check("6 PDFの文字に7件（時刻・内容）がある", pdfHas(out.pdfText, DEFAULT7.split(",")), out.pdfText.split("\n").filter((x) => /^\d\d:\d\d$/.test(x.trim())).join(","));
  check("6 PDF（同じHTML）はA3横1ページ・欄からあふれない・レイアウトの版は変えていない・請求人工なし", out.pages === 1 && out.a3land && out.a3.over === 0 && out.a3.ver.includes("2026-10-03-4") && !out.a3.text.includes("請求"), out.a3.ver);

  // ===== 7〜14 日報で変更・追加・削除 → ダッシュボード・A3・PDF =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.locator(".timeline-row").nth(1).locator(".flowTime").fill("08:30");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
  r = await reportOf(T);
  bf = await boardFlow(); out = await a3AndPdf();
  check("7 日報の 08:20 作業 → 08:30", r.timeline.some((f) => f.time === "08:30" && f.title === "作業") && !r.timeline.some((f) => f.time === "08:20"));
  check("8 ダッシュボードも 08:30（保存した日を表示）", bf.date === T && bf.flow.includes("08:30 作業") && !bf.flow.some((x) => x.startsWith("08:20")), bf.flow.join());
  check("9 A3も 08:30", out.a3.flow.includes("08:30 作業") && !out.a3.flow.some((x) => x.startsWith("08:20")));
  check("10 PDFも 08:30（08:20 が無い）", pdfHas(out.pdfText, ["08:30 作業"]) && !out.pdfText.includes("08:20") && out.pages === 1);
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.click("#addTimelineBtn");
  const add = page.locator(".timeline-row").last();
  await add.locator(".flowTime").fill("13:30"); await add.locator(".flowKind").selectOption("patrol"); await add.locator(".flowTitle").fill("現場巡回");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
  bf = await boardFlow(); out = await a3AndPdf();
  check("11・12 1件追加（13:30 現場巡回）→ ダッシュボード・A3・PDFに追加（時刻順）", bf.flow.includes("13:30 現場巡回") && out.a3.flow.includes("13:30 現場巡回") && pdfHas(out.pdfText, ["13:30 現場巡回"]) && bf.flow.length === 8 && out.a3.flow.length === 8 && bf.flow.map((x) => x.slice(0, 5)).join() === [...bf.flow.map((x) => x.slice(0, 5))].sort().join(), bf.flow.join());
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.$$eval(".timeline-row", (rows) => rows.find((x) => x.querySelector(".flowTime").value === "15:00").querySelector(".removeRowBtn").click());
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
  bf = await boardFlow(); out = await a3AndPdf();
  check("13・14 1件削除（15:00 休憩）→ ダッシュボード・A3・PDFから削除", !bf.flow.some((x) => x.startsWith("15:00")) && !out.a3.flow.some((x) => x.startsWith("15:00")) && !out.pdfText.includes("15:00") && bf.flow.length === 7 && out.a3.flow.join() === bf.flow.join(), `${bf.flow.join()} / ${out.a3.flow.join()}`);

  // ===== 15〜18 特殊な日は7件を自動で作らない（日報データ・ダッシュボード・A3）=====
  const specials = [["nowork", day(-4)], ["holiday", day(-6)], ["rain", day(-7)], ["office", day(-8)]];
  for (const [st, d] of specials) {
    await openCalendar(d);
    await page.click(`#reportCalendar .cal-cell[data-date="${d}"]`); await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
    await page.click(`#dayStatusDialog [data-day-status="${st}"]`);
    if (st === "rain") await page.fill("#dayStatusRainWork", "外壁塗装");
    await page.click("#dayStatusSaveBtn"); await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open); await page.waitForTimeout(400);
  }
  for (const [i, [st, d]] of specials.entries()) {
    const rep = await reportOf(d);
    await page.$eval("#siteDashboard .dash-date-input", (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, d); await page.waitForTimeout(400);
    bf = await boardFlow(); out = await a3AndPdf();
    check(`${15 + i} ${st}: 日報データ・ダッシュボード・A3に7件を自動で作らない`, rep.dayStatus === st && !(rep.timeline || []).length && bf.flow.length === 0 && out.a3.flow.length === 0 && !out.a3.text.includes("片付け開始"), `${(rep.timeline || []).length}/${bf.flow.length}/${out.a3.flow.length}`);
  }
  // 現場作業なしの日を日報画面で開いて保存し直しても、7件は入らない
  const nw = await reportOf(day(-4));
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${nw.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(300);
  const nwRows = await page.locator(".timeline-row").count();
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(400);
  check("15 現場作業なしの日報を開いて保存し直しても7件は入らない", nwRows === 0 && !((await reportOf(day(-4))).timeline || []).length);

  // ===== 19 日報なしの日 =====
  const none = day(-9);
  await page.$eval("#siteDashboard .dash-date-input", (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, none); await page.waitForTimeout(400);
  bf = await boardFlow(); out = await a3AndPdf();
  check("19 日報なしの日は架空の流れを表示しない（ダッシュボード・A3）", !(await reportOf(none)) && bf.flow.length === 0 && out.a3.flow.length === 0 && !out.a3.text.includes("片付け開始"));

  // ===== 20 既存日報には一括追加しない =====
  const oldAfter = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.old);
  await page.$eval("#siteDashboard .dash-date-input", (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, day(-5)); await page.waitForTimeout(400);
  bf = await boardFlow();
  check("20 既存の日報には7件を追加しない（データは変わらない・ダッシュボードにも流れなし）", oldAfter === oldBefore && bf.flow.length === 0);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
