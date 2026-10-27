// 日報カレンダーの日の状態を 03-2（1日分のExcel・台帳のExcel・会社様式PDF・台帳の印刷）に書く（2026-10-27。架空データ・隔離したプロファイル・同梱の03-2）
//   記入位置: 協力会社欄の2業者目（A9 の行）の作業内容（E9。台帳は頁ごとに +52 行）。【現場作業なし】【休工日】【雨天作業不可日】【事務作業日】
//   雨天作業不可日の中止作業・理由、事務作業日の内容は同じ欄の2行目（E10）。2業者目の作業内容があれば消さずに後ろへ足す。通常作業は書かない
//   Microsoft Excel 実機・Safari・iPad の印刷は自動テストでは確認できない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const RAIN = { work: "外壁塗装", reason: "朝から降雨" };
const OFFICE = "書類作成・施工計画書の修正";
// 期待する E9（2業者目の作業内容）と E10（同じ欄の2行目）。日付の日（01〜08）ごと
const EXPECT = {
  "01": ["外壁洗浄", ""], // 通常作業: 2業者目の作業内容のまま
  "02": ["【休工日】", ""],
  "03": ["【雨天作業不可日】", `中止作業：${RAIN.work}　理由：${RAIN.reason}`],
  "04": ["【事務作業日】", `内容：${OFFICE}`],
  "05": ["資材整理　【休工日】", ""], // 休工日だが2業者目の作業内容がある: 消さずに後ろへ足す
  "06": ["【現場作業なし】", ""],
  "07": ["【雨天作業不可日】", "中止作業：足場点検"], // 1業者だけの日: 2業者目の欄に書き、1業者目は変えない
  "08": ["外壁洗浄", ""] // 通常作業
};
const LABEL = /【(現場作業なし|休工日|雨天作業不可日|事務作業日)】/;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "day-status-out-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 現場A（試験の現場）と現場B（同じ日付に通常作業。Aの区分が混ざらないことの確認）
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { PATROL_CHECKLIST_ITEMS } = await import("/js/patrolChecklist.js");
    const good = Object.fromEntries(PATROL_CHECKLIST_ITEMS.map((i) => [i.key, "good"]));
    const a = await createSite({ name: "日の状態の出力の試験A", startDate: "2026-10-01", endDate: "2026-10-08" });
    const b = await createSite({ name: "日の状態の出力の試験B", startDate: "2026-10-01", endDate: "2026-10-08" });
    const co = (name, occ, n, work) => ({ companyId: Math.random().toString(36).slice(2), companyName: name, occupation: occ, plannedWorkerCount: n, actualWorkerCount: n, workContent: work });
    const two = () => [co("イズミ足場工業", "足場", "3", "外壁足場組立"), co("アオバ塗装工業", "洗浄", "2", "外壁洗浄")];
    const reps = [
      stampNew({ siteId: a.id, date: "2026-10-01", dayStatus: "work", companies: two(), patrolChecklist: good }),
      stampNew({ siteId: a.id, date: "2026-10-05", dayStatus: "holiday", companies: [co("イズミ足場工業", "足場", "1", "足場点検"), co("アオバ塗装工業", "洗浄", "1", "資材整理")] }),
      stampNew({ siteId: a.id, date: "2026-10-07", dayStatus: "rain", rainCancelledWork: "足場点検", companies: [co("イズミ足場工業", "足場", "2", "足場の養生確認")] }),
      stampNew({ siteId: a.id, date: "2026-10-08", dayStatus: "work", companies: two(), patrolChecklist: good }),
      stampNew({ siteId: b.id, date: "2026-10-02", dayStatus: "work", companies: [co("ウエノ建設", "足場工事", "2", "B現場の足場"), co("エノキ建装", "塗装", "2", "B現場の塗装")], patrolChecklist: good }),
      stampNew({ siteId: b.id, date: "2026-10-03", dayStatus: "work", companies: [co("ウエノ建設", "足場工事", "2", "B現場の足場")], patrolChecklist: good })
    ];
    for (const r of reps) await dbPut("reports", r);
    return { a: a.id, b: b.id };
  });

  // ---------- 画面（日報カレンダー）から 10/2 休工日・10/3 雨天作業不可日・10/4 事務作業日・10/6 現場作業なし を登録 ----------
  const openCal = async () => {
    await page.goto(`${BASE}#/sites`); await page.waitForTimeout(150);
    await page.goto(`${BASE}#/sites/${ids.a}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(500);
    await page.click("#siteDashboard .dash-tab[data-tab=manage]");
    for (let i = 0; i < 24 && !(await page.$(`#reportCalendar .cal-cell[data-date="2026-10-02"]`)); i++) { await page.click("#reportCalendar .cal-nav[data-shift='-1']"); await page.waitForTimeout(150); }
  };
  await openCal();
  const register = async (day, status, fill) => {
    await page.click(`#reportCalendar .cal-cell[data-date="2026-10-${day}"]`);
    await page.waitForFunction(() => document.getElementById("dayStatusDialog").open);
    await page.click(`#dayStatusDialog [data-day-status="${status}"]`);
    if (fill) await fill();
    await page.click("#dayStatusSaveBtn");
    await page.waitForFunction(() => !document.getElementById("dayStatusDialog").open); await page.waitForTimeout(300);
  };
  await register("02", "holiday");
  await register("03", "rain", async () => { await page.fill("#dayStatusRainWork", RAIN.work); await page.fill("#dayStatusRainReason", RAIN.reason); });
  await register("04", "office", async () => { await page.fill("#dayStatusRemarks", OFFICE); });
  await register("06", "nowork");
  await page.reload(); await page.waitForTimeout(400); await openCal();
  const calState = (day) => page.$eval(`#reportCalendar .cal-cell[data-date="2026-10-${day}"]`, (c) => c.dataset.state || c.className);
  const saved = await page.evaluate(async (sid) => Object.fromEntries((await (await import("/js/db.js")).dbGetAll("reports")).filter((r) => r.siteId === sid && !r.isDeleted).map((r) => [r.date.slice(8), { st: r.dayStatus, rw: r.rainCancelledWork || "", rr: r.rainReason || "", rm: r.remarks || "", co: (r.companies || []).length }])), ids.a);
  check("1 休工日を登録し、再読み込みしても残る（業者なし）", saved["02"]?.st === "holiday" && saved["02"].co === 0 && /holiday/.test(await calState("02")), JSON.stringify(saved["02"]));
  check("2 雨天作業不可日を登録し、再読み込みしても残る（中止作業・理由）", saved["03"]?.st === "rain" && saved["03"].rw === RAIN.work && saved["03"].rr === RAIN.reason && /rain/.test(await calState("03")), JSON.stringify(saved["03"]));
  check("3 事務作業日を登録し、再読み込みしても残る（内容）", saved["04"]?.st === "office" && saved["04"].rm === OFFICE && /office/.test(await calState("04")), JSON.stringify(saved["04"]));
  check("現場作業なしを登録し、再読み込みしても残る", saved["06"]?.st === "nowork" && saved["06"].co === 0 && /nowork/.test(await calState("06")), JSON.stringify(saved["06"]));

  // ---------- 出力 ----------
  const x = await page.evaluate(async (ids) => {
    const { dbGetAll } = await import("/js/db.js"); const { getSite } = await import("/js/sites.js"); const rp = await import("/js/reportPrint.js");
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js"); const { generateLedgerWorkbook } = await import("/js/report-output/ledger/generateLedgerOutput.js");
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const xr = await import("/js/report-output/xlsxSheetReader.js");
    const snapshot = async () => JSON.stringify((await dbGetAll("reports")).sort((p, q) => p.id.localeCompare(q.id)));
    const before = await snapshot();
    const open = async (blob) => {
      const zip = loadZip(await blob.arrayBuffer()); const wb = await readZipEntryText(zip, "xl/workbook.xml"); const rels = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
      const sp = "xl/" + new RegExp(`Id="${/<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1]}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?xl\//, "");
      const sheetXml = await readZipEntryText(zip, sp);
      const lay = xr.readSheetLayout(sheetXml, xr.parseSharedStrings(await readZipEntryText(zip, "xl/sharedStrings.xml")));
      return { text: (ref) => lay.cells.get(ref)?.text ?? "", all: [...lay.cells.values()].map((c) => c.text || "").join("\n"), sheetXml };
    };
    const out = {};
    for (const sid of [ids.a, ids.b]) {
      const site = await getSite(sid); const t = await rp.resolveCompanyTemplateForSite(site);
      const reps = (await dbGetAll("reports")).filter((r) => r.siteId === sid && !r.isDeleted).sort((p, q) => p.date.localeCompare(q.date));
      const days = {};
      for (const r of reps) {
        const e = await open((await generateReportOutput({ reportId: r.id, format: "excel", templateId: t.templateId })).blob);
        days[r.date.slice(8)] = { E7: e.text("E7"), E9: e.text("E9"), E10: e.text("E10"), G9: e.text("G9"), G10: e.text("G10"), A9: e.text("A9"), O51: e.text("O51"), L7style: (/<c r="L7"[^>]*?\ss="(\d+)"/.exec(e.sheetXml) || [])[1], all: e.all, html: (await rp.buildReportPrintHtml(r.id)).html };
      }
      const led = await open((await generateLedgerWorkbook({ siteId: sid, templateId: t.templateId })).blob);
      const ledE = {}; for (let d = 0; d < 8; d++) ledE[`0${d + 1}`] = { E7: led.text(`E${7 + 52 * d}`), E9: led.text(`E${9 + 52 * d}`), E10: led.text(`E${10 + 52 * d}`) };
      const bulk = (await rp.buildReportsPrintHtml(reps.map((r) => r.id), "まとめて印刷")).html; // まとめて印刷（1日報1ページ。日付の順）
      // 1ページのPDF（A3）: 同じ印刷用HTMLの紙面を画像にした PDF（日報1件＝1ページ）
      const { buildCompanyOnePagePdf } = await import("/js/ui/company-pdf.js");
      let onePagePages = null; try { const pdf = await buildCompanyOnePagePdf(bulk, "test"); const bytes = new Uint8Array(await (pdf.blob || pdf.file || pdf).arrayBuffer()); onePagePages = (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page[^s]/g) || []).length; } catch (e) { onePagePages = String(e.message || e); }
      out[sid === ids.a ? "a" : "b"] = { days, ledE, ledAll: led.all, ledHtml: (await rp.buildSiteLedgerPrintHtml(sid)).html, bulk, dates: reps.map((r) => r.date.slice(8)), onePagePages };
    }
    out.unchanged = (await snapshot()) === before;
    return out;
  }, ids);

  const A = x.a, B = x.b;
  const both = (v) => [v.E9, v.E10];
  const eq = (v, d) => v.E9 === EXPECT[d][0] && v.E10 === EXPECT[d][1];
  const dayE = Object.fromEntries(Object.entries(A.days).map(([d, v]) => [d, both(v)]));
  check("4 Excel（1日分）: 4区分とも2業者目の作業内容（E9）に入り、雨天作業不可日の中止作業・理由・事務作業日の内容は同じ欄の2行目（E10）", ["02", "03", "04", "06"].every((d) => eq(A.days[d], d)), JSON.stringify(dayE));
  check("Excel（1日分）: 2業者目に作業内容がある日は消さずに後ろへ足す（10/5 休工日）・協力会社名・1業者目は変えない", eq(A.days["05"], "05") && A.days["05"].A9 === "アオバ塗装工業" && A.days["05"].E7 === "足場点検", JSON.stringify({ E7: A.days["05"].E7, A9: A.days["05"].A9, E9: A.days["05"].E9 }));
  check("Excel（1日分）: 1業者だけの雨天作業不可日は2業者目の欄に書き、1業者目の作業内容はそのまま", eq(A.days["07"], "07") && A.days["07"].E7 === "足場の養生確認" && A.days["07"].A9 === "", JSON.stringify(both(A.days["07"])));
  check("Excel（1日分）: 通常作業の日は区分を書かない（10/1・10/8）", ["01", "08"].every((d) => eq(A.days[d], d) && !LABEL.test(A.days[d].all)), JSON.stringify({ "01": both(A.days["01"]), "08": both(A.days["08"]) }));
  check("Excel（1日分）: 安全注意事項の欄（G9・G10）など他の欄には書かない", Object.values(A.days).every((v) => !LABEL.test(v.G9) && !LABEL.test(v.G10)));
  check("Excel（1日分）: 区分を書く日も、人数は数えない（稼動人数の計が空・0）・巡回点検の欄は斜線のまま（書式が通常作業の日と違う）", ["02", "05", "06"].every((d) => ["", "0"].includes(A.days[d].O51)) && A.days["02"].L7style !== A.days["01"].L7style, JSON.stringify({ O51: [A.days["02"].O51, A.days["05"].O51], L7: [A.days["01"].L7style, A.days["02"].L7style] }));
  check("6 台帳（Excel）: 各日の頁の2業者目の作業内容（E9・E10 +52×日）が1日分と同じ（混在しても日付がずれない）", Object.keys(EXPECT).every((d) => eq(A.ledE[d], d)), JSON.stringify(Object.fromEntries(Object.entries(A.ledE).map(([d, v]) => [d, both(v)]))));
  check("台帳（Excel）: 1業者目の作業内容も1日分と同じ", ["01", "05", "07", "08"].every((d) => A.ledE[d].E7 === A.days[d].E7), JSON.stringify(Object.fromEntries(Object.entries(A.ledE).map(([d, v]) => [d, v.E7]))));
  check("7 別の現場（B）には区分が入らない（1日分・台帳。同じ日付 10/2・10/3 は通常作業のまま）", B.days["02"].E9 === "B現場の塗装" && B.days["03"].E9 === "" && ["02", "03"].every((d) => !LABEL.test(B.days[d].all)) && !LABEL.test(B.ledAll) && B.ledE["02"].E9 === "B現場の塗装", JSON.stringify({ d2: B.days["02"].E9, l2: B.ledE["02"].E9 }));
  check("出力しても日報のデータは変わらない（業者・人数・作業内容など）", x.unchanged);

  // ---------- PDF（会社様式の印刷用HTML）・台帳の印刷：描画して位置と内容を確かめる ----------
  const LOC = (texts) => { // 文字のあるセルの行番号（表の行）と、セルの左端・幅
    const out = {};
    for (const s of document.querySelectorAll("table.xlsx-sheet .xc > span")) {
      const t = /^作\s*業\s*内\s*容/.test(s.textContent) ? "作業内容" : s.textContent; if (!texts.some((x) => t === x)) continue;
      const td = s.closest("td"), tr = td.closest("tr"), page = td.closest(".ledger-page, .xlsx-sheet-wrap"), pages = [...document.querySelectorAll(".ledger-page, .xlsx-sheet-wrap")];
      const r = td.getBoundingClientRect(), t0 = tr.closest("table").getBoundingClientRect();
      (out[t] = out[t] || []).push({ row: tr.rowIndex, left: Math.round(r.left - t0.left), page: pages.indexOf(page) });
    }
    return out;
  };
  for (const [name, bt] of [["Chromium", chromium], ["WebKit", webkit]]) {
    const b = await bt.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
    // 1日分の PDF: 区分の文字が、通常作業の日の2業者目の作業内容（10/1 の「外壁洗浄」）と同じセルの位置
    await p.setContent(A.days["01"].html); await p.waitForTimeout(500);
    // 列の幅は文字の量で日ごとに少し変わる（widenColumnsToFill）ので、横の位置は同じ頁の見出し「作業内容」（E列）と比べる
    const ref = (await p.evaluate(LOC, ["外壁洗浄", "外壁足場組立", "作業内容"]));
    const pos = {};
    const days5 = ["02", "03", "04", "05", "06", "07"];
    for (const d of days5) {
      await p.setContent(A.days[d].html); await p.waitForTimeout(400);
      const l = await p.evaluate(LOC, [...EXPECT[d].filter(Boolean), "作業内容"]);
      pos[d] = { v: l[EXPECT[d][0]] || [], w: EXPECT[d][1] ? l[EXPECT[d][1]] || [] : null, head: (l["作業内容"] || [])[0], clipped: await p.evaluate(() => window.__xlsxCellsClipped) };
    }
    const row9 = ref["外壁洗浄"]?.[0]?.row;
    const same = (o) => o.v.length === 1 && o.head && o.v[0].row === row9 && Math.abs(o.v[0].left - o.head.left) <= 1 && (o.w == null || (o.w.length === 1 && o.w[0].row === row9 + 1 && Math.abs(o.w[0].left - o.head.left) <= 1)) && o.clipped === 0;
    check(`5 ${name} PDF（1日分）: 4区分とも Excel と同じ内容が、2業者目の作業内容のセル（E9。中止作業・理由・内容はその下の行 E10）に出て、収まらない文字が無い`, ref["外壁洗浄"]?.length === 1 && row9 === ref["外壁足場組立"][0].row + 2 && Math.abs(ref["外壁洗浄"][0].left - ref["作業内容"][0].left) <= 1 && days5.every((d) => same(pos[d])), JSON.stringify({ ref, pos }));
    await p.setContent(A.days["01"].html); await p.waitForTimeout(300);
    const noLabel = await p.evaluate((re) => !new RegExp(re).test(document.body.textContent), LABEL.source);
    await p.setContent(B.days["02"].html); await p.waitForTimeout(300);
    const noLabelB = await p.evaluate((re) => !new RegExp(re).test(document.body.textContent), LABEL.source);
    check(`${name} PDF: 通常作業の日・別の現場の日には区分が出ない`, noLabel && noLabelB);
    // まとめて印刷: 日報ごとの頁（日付の順）に、その日の区分が同じ位置に出る
    await p.setContent(A.bulk); await p.waitForTimeout(800);
    const bl = await p.evaluate(LOC, [...new Set(Object.values(EXPECT).flat().filter(Boolean))]);
    const okBulk = A.dates.every((d, i) => { const [v9, v10] = EXPECT[d]; return (bl[v9] || []).some((l) => l.page === i && l.row === row9) && (!v10 || (bl[v10] || []).some((l) => l.page === i && l.row === row9 + 1)); });
    check(`${name} まとめて印刷: 日報ごとの頁に、その日の区分が1日分の PDF と同じ位置に出る（日付の順がずれない）`, okBulk && A.dates.length === 8, JSON.stringify({ dates: A.dates, bl }));
    // 台帳の印刷: 1日1頁で、各日の頁の2業者目の作業内容のセルに出る
    await p.setContent(A.ledHtml); await p.waitForTimeout(700);
    const led = await p.evaluate(LOC, [...new Set(Object.values(EXPECT).flat().filter(Boolean))]);
    const okLed = Object.entries(EXPECT).every(([d, [v9, v10]]) => (led[v9] || []).some((l) => l.page === Number(d) - 1 && l.row === row9) && (!v10 || (led[v10] || []).some((l) => l.page === Number(d) - 1 && l.row === row9 + 1)));
    check(`${name} 台帳の印刷: 各日の頁の2業者目の作業内容のセルに、台帳Excelと同じ内容が出る`, okLed, JSON.stringify(led));
    await b.close();
  }
  check("1ページのPDF（A3）: まとめて印刷と同じ印刷用HTMLから作り、日報8件で8ページ", A.onePagePages === 8, String(A.onePagePages));
  check("8 ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((v) => !v).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
