// 監督予定・社内連絡（日報の supervisorSchedule）と、A3から現場メモを外したことを確かめる（架空データ・Chromium）。
//   ・日報の入力画面で追加（1件・複数件）・編集・削除・保存。日報の日付に結びつく（別の日には出ない）
//   ・現場掲示（画面）・A3印刷（印刷画面に渡るHTML）・PDF保存（同じHTMLから作る画像PDF）が同じ行を全件出す（件数の上限なし）
//   ・本日の現場の流れは別の欄のまま変わらない。A3に現場メモが無い。請求人工は出ない
//   ・情報の多い日（業者14社・流れ20件・搬入搬出12件・監督予定12件／30件）でもA3横1ページ・どの欄も切れない
//   ・前の日報から作成ではコピーしない。ほかの日報のデータは変わらない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sup-sch-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  // PDF保存で画面の外の枠に入れたHTMLを記録する（PDFの画像がどのHTMLから作られたかを確かめるため）
  await ctx.addInitScript(() => {
    window.__srcdocs = [];
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
    Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", { configurable: true, get() { return d.get.call(this); }, set(v) { window.__srcdocs.push(String(v)); d.set.call(this, v); } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const now = new Date();
  const day = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };
  const A = day(-2), B = day(-1), HEAVY = day(-4), PREV = day(-6);
  const ids = await page.evaluate(async ([start, prev]) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "監督予定の確認現場", startDate: start, endDate: "2099-12-31" });
    // 前の日報（監督予定あり）。前の日報から作成でコピーされないことの確認用
    const r = stampNew({ siteId: site.id, date: prev, dayStatus: "work", siteSupervisorNames: [], companies: [{ companyId: "p", companyName: "前日工業", occupation: "塗装", actualWorkerCount: "2", billingManDays: "3" }],
      supervisorSchedule: [{ id: "s0", start: "09:00", end: "10:00", title: "前日の予定（コピーしない）", place: "本社", note: "" }] });
    await dbPut("reports", r);
    return { siteId: site.id, prev: r.id };
  }, [day(-20), PREV]);
  const prevBefore = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.prev);
  const reportOf = (date) => page.evaluate(async ([sid, d]) => (await (await import("/js/db.js")).dbGetAll("reports")).find((r) => r.siteId === sid && r.date === d && !r.isDeleted) || null, [ids.siteId, date]);
  const fillRow = async (i, v) => { const r = page.locator(".schedule-row").nth(i); for (const [cls, val] of Object.entries(v)) await r.locator(`.${cls}`).fill(val); };
  const save = async () => { await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500); };
  const openDash = async (date) => {
    await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.evaluate(([siteId, d]) => { window.__dashboardDate = { siteId, date: d }; }, [ids.siteId, date]);
    await page.goto(`${BASE}#/sites/${ids.siteId}`); await page.waitForSelector("#siteDashboard:not([hidden])"); await page.waitForTimeout(400);
    await page.click("#siteDashboard .dash-tab[data-tab=board]"); await page.waitForTimeout(200);
  };
  const boardRows = () => page.evaluate(() => ({
    date: document.querySelector("#siteDashboard .dash-date-input").value,
    rows: [...document.querySelectorAll('#siteDashboard [data-panel="board"] .dash-schedule tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join("|")),
    text: document.querySelector('#siteDashboard [data-panel="board"]').textContent,
    flow: [...document.querySelectorAll('#siteDashboard [data-panel="board"] .dash-flow-item:not(.is-delivery)')].map((x) => x.querySelector(".dash-flow-title").textContent.trim())
  }));
  // 「🖨 現場掲示をA3印刷」で印刷画面に渡るHTML → A3として表示（印刷の状態）して中身を読む・PDFにする
  const printedHtml = async () => {
    await page.click('#siteDashboard [data-action="print"]');
    await page.waitForFunction(() => document.getElementById("reportPrintDialog")?.open && (document.getElementById("reportPrintFrame")?.srcdoc || "").length > 1000);
    const html = await page.$eval("#reportPrintFrame", (f) => f.srcdoc);
    await page.click("#reportPrintCloseBtn");
    return html;
  };
  const a3Of = async (html) => {
    const p = await ctx.newPage(); await p.setContent(html); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(300);
    const a3 = await p.evaluate(() => {
      dispatchEvent(new Event("beforeprint"));
      const sch = document.querySelector('[data-section="schedule"] .content');
      const box = sch?.getBoundingClientRect();
      const rows = [...document.querySelectorAll("table.sch tbody tr")];
      return {
        rows: rows.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join("|")),
        // 各セルの文字が隣のセルにはみ出さない（時刻「10:00～11:30」が内容の列に重ならない）
        cellsFit: rows.every((tr) => [...tr.cells].every((td) => { const rg = document.createRange(); rg.selectNodeContents(td); const a = rg.getBoundingClientRect(), b = td.getBoundingClientRect(); return !a.width || (a.left >= b.left - 1 && a.right <= b.right + 1); })),
        rowsInside: rows.every((tr) => { const r = tr.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.right <= box.right + 1; }),
        overflow: window.__a3Overflow || null,
        sections: [...document.querySelectorAll(".box[data-section]")].map((b) => b.dataset.section),
        bottomCols: getComputedStyle(document.querySelector(".bottom")).gridTemplateColumns.split(" ").length,
        flowInFlowBox: [...document.querySelectorAll('[data-section="flow"] table.flow tr:not(.dlv) .ti')].map((x) => x.textContent),
        schInFlow: !!document.querySelector('[data-section="flow"] table.sch'),
        ver: document.querySelector(".ver")?.textContent || "",
        warn: document.querySelector(".a3-overflow-warn")?.textContent || "",
        minPt: Math.min(...[...document.querySelectorAll('[data-section="flow"] .content, [data-section="schedule"] .content')].map((c) => parseFloat(c.style.fontSize || "10.5"))),
        minOtherPt: Math.min(...[...document.querySelectorAll(".box .content")].filter((c) => !["flow", "schedule"].includes(c.parentNode.dataset.section)).map((c) => parseFloat(c.style.fontSize || "10.5"))),
        text: document.body.textContent
      };
    });
    const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true })).toString("latin1");
    await p.close();
    return { ...a3, pages: (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, a3land: /\/MediaBox\s*\[\s*0\s+0\s+1191/.test(pdf) };
  };
  // 「📄 PDF保存・共有」: 画像PDFの元にしたHTML（画面の外の枠）と、PDFの頁数
  const boardPdf = async () => {
    await page.evaluate(() => { window.__srcdocs = []; });
    await page.click('#siteDashboard [data-action="pdf"]');
    await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("boardPdfStatus").textContent), null, { timeout: 30000 });
    const status = await page.textContent("#boardPdfStatus");
    const html = await page.evaluate(() => window.__srcdocs.find((s) => s.includes("今日の現場シート")) || "");
    await page.click("#boardPdfCloseBtn");
    return { status, html };
  };

  // ===== 1 日報の入力画面で1件追加して保存 =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${A}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  check("新規の日報に監督予定・社内連絡の欄があり、初期値は0件（流れの初期値とは別）", (await page.isVisible("#addScheduleBtn")) && (await page.locator(".schedule-row").count()) === 0 && (await page.locator(".timeline-row").count()) === 8);
  // 前の日報から作成: 監督予定はコピーしない
  await page.click("#copyPrevBtn"); await page.waitForTimeout(300);
  check("前の日報から作成で、監督予定・社内連絡はコピーしない", (await page.locator(".schedule-row").count()) === 0);
  await page.click("#addScheduleBtn");
  await fillRow(0, { schStart: "10:00", schEnd: "11:30", schTitle: "発注者打合せ", schPlace: "○○市役所 3階会議室", schNote: "不在中は副所長へ連絡" });
  await save();
  let r = await reportOf(A);
  check("1件追加して保存 → 日報の supervisorSchedule に1件（開始・終了・内容・場所・連絡事項）", r && r.supervisorSchedule.length === 1 && r.supervisorSchedule[0].start === "10:00" && r.supervisorSchedule[0].end === "11:30" && r.supervisorSchedule[0].place === "○○市役所 3階会議室" && r.supervisorSchedule[0].note === "不在中は副所長へ連絡" && !!r.supervisorSchedule[0].id, JSON.stringify(r?.supervisorSchedule));
  check("本日の現場の流れは別のまま（初期値8件。監督予定は流れに入らない）", r.timeline.length === 8 && !r.timeline.some((f) => f.title.includes("発注者")));

  // ===== 2 複数件（合計8件・時刻順でない入力・時刻なし・内容だけ）→ 時刻順で保存 =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  check("保存した監督予定が日報の画面に読み込まれる", (await page.locator(".schedule-row").count()) === 1 && (await page.locator(".schedule-row .schTitle").first().inputValue()) === "発注者打合せ");
  const more = [
    { schStart: "15:00", schEnd: "16:00", schTitle: "社内工程会議", schPlace: "本社", schNote: "" },
    { schStart: "07:45", schEnd: "", schTitle: "現場着・朝礼前確認", schPlace: "現場事務所", schNote: "" },
    { schStart: "13:30", schEnd: "14:00", schTitle: "配筋検査立会", schPlace: "3階スラブ", schNote: "検査員2名" },
    { schStart: "", schEnd: "", schTitle: "見積書の提出（時刻未定）", schPlace: "", schNote: "本日中" },
    { schStart: "12:00", schEnd: "13:00", schTitle: "近隣挨拶", schPlace: "北側の住宅", schNote: "" },
    { schStart: "16:30", schEnd: "17:30", schTitle: "事務所へ戻る", schPlace: "本社", schNote: "17:30以降は携帯へ" },
    { schStart: "09:00", schEnd: "09:30", schTitle: "安全書類の確認", schPlace: "現場事務所", schNote: "" }
  ];
  for (let i = 0; i < more.length; i++) { await page.click("#addScheduleBtn"); await fillRow(i + 1, more[i]); }
  await save();
  r = await reportOf(A);
  const order = r.supervisorSchedule.map((s) => s.title);
  check("8件を保存できる（件数の上限なし）・開始時刻の順（時刻の無い行は最後）", order.join(",") === "現場着・朝礼前確認,安全書類の確認,発注者打合せ,近隣挨拶,配筋検査立会,社内工程会議,事務所へ戻る,見積書の提出（時刻未定）", order.join(","));

  // ===== 3 編集・削除・空の行は保存しない =====
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${r.id}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  const idx = async (title) => (await page.$$eval(".schedule-row .schTitle", (xs) => xs.map((x) => x.value))).indexOf(title);
  await page.locator(".schedule-row").nth(await idx("近隣挨拶")).locator(".schPlace").fill("北側・東側の住宅");
  await page.locator(".schedule-row").nth(await idx("安全書類の確認")).locator(".removeRowBtn").click();
  await page.click("#addScheduleBtn"); // 何も入れない行
  await save();
  r = await reportOf(A);
  check("編集（場所の変更）・削除（1件）・空の行は保存しない → 7件", r.supervisorSchedule.length === 7 && r.supervisorSchedule.find((s) => s.title === "近隣挨拶").place === "北側・東側の住宅" && !r.supervisorSchedule.some((s) => s.title === "安全書類の確認"), r.supervisorSchedule.map((s) => s.title).join(","));
  const expectRows = r.supervisorSchedule.map((s) => `${s.start}${s.start || s.end ? "～" : ""}${s.end}|${s.title}|${s.place}|${s.note}`);

  // 別の日（B）の日報: 監督予定1件
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${B}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  await page.click("#addScheduleBtn"); await fillRow(0, { schStart: "14:00", schEnd: "15:00", schTitle: "B日の別の予定", schPlace: "支店", schNote: "" });
  await save();

  // ===== 4 現場掲示（画面）・A3・PDF が同じ行・日付に結びつく =====
  await openDash(A);
  let bd = await boardRows();
  check("現場掲示（画面）に、その日の監督予定・社内連絡が全7件・日報と同じ内容・同じ順で出る", bd.date === A && JSON.stringify(bd.rows) === JSON.stringify(expectRows), bd.rows.join(" / "));
  check("現場掲示（画面）: 別の日の予定は出ない・本日の現場の流れは別の欄のまま（8件）", !bd.text.includes("B日の別の予定") && bd.flow.length === 8 && !bd.flow.some((t) => t.includes("発注者")));
  let html = await printedHtml();
  let a3 = await a3Of(html);
  check("A3印刷: 画面と同じ7行が同じ順で出る（全件・切れていない・時刻などが隣の列にはみ出さない）", JSON.stringify(a3.rows) === JSON.stringify(expectRows) && a3.rowsInside && a3.cellsFit, a3.rows.join(" / "));
  check("A3: 現場メモが無い・監督予定は流れの欄とは別の欄・下段は3列（作業間の連絡・調整｜連絡事項｜明日の予定）", !a3.sections.includes("memo") && !a3.text.includes("現場メモ") && a3.sections.includes("schedule") && !a3.schInFlow && a3.bottomCols === 3 && ["coordination", "notice", "tomorrow"].every((k) => a3.sections.includes(k)), a3.sections.join(","));
  check("A3: 本日の現場の流れは8件のまま", a3.flowInFlowBox.length === 8);
  check("A3: 横1ページ・欄からあふれない・レイアウトの版 2026-10-06-1・請求人工なし", a3.pages === 1 && a3.a3land && a3.overflow && a3.overflow.length === 0 && a3.ver.includes("2026-10-06-1") && !a3.text.includes("請求"), JSON.stringify(a3.overflow));
  const pdf = await boardPdf();
  const pdfA3 = await a3Of(pdf.html);
  check("PDF保存: A3印刷と同じHTMLから作る（監督予定7行が同じ）", pdf.status.includes("作成しました") && pdf.html === html && JSON.stringify(pdfA3.rows) === JSON.stringify(expectRows), pdf.status);
  await openDash(B);
  bd = await boardRows();
  check("別の日（B）の現場掲示には、B の予定1件だけ", bd.date === B && bd.rows.length === 1 && bd.rows[0].includes("B日の別の予定"), bd.rows.join(" / "));
  await openDash(day(-3));
  bd = await boardRows();
  html = await printedHtml();
  check("日報の無い日は監督予定なし（画面・A3とも。架空の予定は出さない）", bd.rows.length === 0 && html.includes("（本日の監督予定・社内連絡なし）"));

  // ===== 5 情報の多い日: 実際にありうる多さは6pt以上で全件・とても多い日も全件（文字は小さくなる）・極端な日は紙面に注意書き =====
  const heavy = async (n, C, F, D) => {
    const sid = await page.evaluate(async ([siteId, date, n, C, F, D]) => {
      const { dbPut, dbGetAll } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
      for (const old of (await dbGetAll("reports")).filter((x) => x.siteId === siteId && x.date === date)) await dbPut("reports", { ...old, isDeleted: true });
      const T = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const companies = Array.from({ length: C }, (_, i) => ({ companyId: "c" + i, companyName: `協力業者${i + 1}工業`, occupation: ["塗装", "防水", "足場", "内装", "電気", "設備", "左官"][i % 7], plannedWorkerCount: "4", actualWorkerCount: String(2 + (i % 5)), workHours: "08:00～17:00", workContent: `${i + 1}階 外壁下地補修・シーリング打替え（北面・東面）`, safetyNotes: "開口部養生・墜落制止用器具の使用", machinery: i % 3 ? "" : "高所作業車", billingManDays: "9" }));
      const timeline = Array.from({ length: F }, (_, i) => ({ id: "t" + i, time: T(7 + Math.floor(i / 2), (i % 2) * 30), kind: i % 4 ? "work" : "uchiawase", title: `工程${i + 1} 作業・打合せ`, status: "plan", note: "" }));
      const deliveries = Array.from({ length: D }, (_, i) => ({ id: "d" + i, direction: i % 3 ? "in" : "out", time: T(8 + i, 0), item: `資材${i + 1}`, quantity: "10ケース", vendor: "○○商事", origin: "倉庫", destination: "北側ゲート", vehicle: "4t車", status: "plan", note: "誘導員1名" }));
      const titles = ["発注者打合せ", "配筋検査立会", "社内工程会議", "近隣挨拶", "設計事務所と仕上げ確認", "安全パトロール同行", "本社で見積打合せ", "事務所へ戻る", "役所へ書類提出", "材料メーカー来場", "協力会社と翌週工程調整", "所長不在（会議）"];
      const supervisorSchedule = Array.from({ length: n }, (_, i) => ({ id: "s" + i, start: T(7 + Math.floor(i * 10 / Math.max(n, 1)), (i * 7) % 60), end: T(8 + Math.floor(i * 10 / Math.max(n, 1)), 0), title: `${titles[i % titles.length]}${n > 12 ? `（${i + 1}）` : ""}`, place: ["○○市役所", "本社 2階会議室", "3階スラブ", "現場事務所"][i % 4], note: i % 2 ? "不在中は副所長（携帯）へ連絡。急ぎの書類は事務所の棚へ" : "" }));
      const report = stampNew({ siteId, date, dayStatus: "work", weather: "晴れ", temperature: "24", progressPercent: 45, siteSupervisorNames: ["監督A", "監督B"], companies, timeline, deliveries, supervisorSchedule,
        focusInstructions: "足場上の整理整頓\n開口部の養生確認\n重機旋回範囲の立入禁止", workCoordination: "塗装と防水の作業区画を分ける\n3階は午後から内装が入る\n搬入時間の重複に注意\n北側道路の通行止め時間",
        remarks: "明日は午前中に役所の検査あり\n駐車場の割当変更\n詰所の清掃当番\n朝礼場所を東側へ変更", tomorrowPlan: "外壁シーリング北面\n防水下地処理\n内装ボード張り（3階）\n足場一部解体",
        patrolChecklist: { morningMeeting: "good" }, patrolComment: "2階足場の手すり外れを是正" });
      await dbPut("reports", report);
      return report.id;
    }, [ids.siteId, HEAVY, n, C, F, D]);
    await openDash(HEAVY);
    const h = await printedHtml();
    const out = await a3Of(h);
    const rep = await reportOf(HEAVY);
    const want = rep.supervisorSchedule.map((s) => s.title);
    return { sid, out, want, got: out.rows.map((x) => x.split("|")[1]) };
  };
  let hv = await heavy(8, 8, 12, 6);
  check("多い日（業者8社・流れ12件・搬入搬出6件・監督予定8件）: A3横1ページ・どの欄もあふれない・注意書きなし", hv.out.pages === 1 && hv.out.a3land && hv.out.overflow?.length === 0 && !hv.out.warn, JSON.stringify(hv.out.overflow));
  check("多い日: 監督予定8件・流れ12件が全件、枠の中・どの欄も6pt以上（読める大きさ）・請求人工なし", JSON.stringify(hv.got) === JSON.stringify(hv.want) && hv.out.rowsInside && hv.out.cellsFit && hv.out.flowInFlowBox.length === 12 && hv.out.minPt >= 6 && !hv.out.text.includes("請求"), `最小 ${hv.out.minPt}pt ${hv.got.length}/${hv.want.length}`);
  hv = await heavy(12, 14, 20, 12);
  check("とても多い日（業者14社・流れ20件・搬入搬出12件・監督予定12件）: A3横1ページ・あふれない（流れ・監督予定の2欄だけ6ptより小さくしてよい）", hv.out.pages === 1 && hv.out.overflow?.length === 0 && !hv.out.warn && JSON.stringify(hv.got) === JSON.stringify(hv.want) && hv.out.rowsInside && hv.out.flowInFlowBox.length === 20 && hv.out.minOtherPt >= 6, `流れ・監督予定 最小 ${hv.out.minPt}pt／ほかの欄 最小 ${hv.out.minOtherPt}pt`);
  hv = await heavy(30, 14, 20, 12);
  const screen30 = await boardRows();
  check("極端に多い日（監督予定30件＋上の量）: 1枚に収まらないことを紙面に注意書きで出す（黙って切らない）・A3は1ページのまま", hv.out.pages === 1 && hv.out.warn.includes("1枚に収まりません") && hv.out.warn.includes("監督予定・社内連絡"), hv.out.warn);
  check("極端に多い日: データは消えない（日報の30件・画面の現場掲示の30件はそのまま）", hv.want.length === 30 && screen30.rows.length === 30);

  // ===== 6 ほかの日報は変わらない =====
  const prevAfter = await page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), ids.prev);
  check("前の日報（コピー元）は1文字も変わらない", prevAfter === prevBefore);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
