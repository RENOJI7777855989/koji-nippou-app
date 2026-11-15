// Excel 出力の前の確認の条件（2026-11-01。架空データ・隔離したプロファイル・同梱の03-2）
//   ダウンロードの前に確認するのは、①協力会社欄に書けない作業行がある ②その日の人数を稼動人数表の業種の行に書けない、の2つだけ。
//   累計だけの業種・搬入・搬出の「ほか n件」は確認せずに出力し、出力後の注意として表示する。出力の中身・日報のデータは変えない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warn-confirm-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const answers = []; const seen = [];
  page.on("dialog", async (d) => { seen.push({ type: d.type(), message: d.message() }); const a = answers.shift(); if (a === false) await d.dismiss(); else await d.accept(); });
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 判定（文言の分け方）
  const unit = await page.evaluate(async () => {
    const w = await import("/js/ui/output-warnings.js");
    return {
      rows: w.isBlockingWarning("協力会社欄に書けるのは14行までのため、作業行16行のうち2行を帳票に書けません: 15行目（塗装／協力15）"),
      today: w.isBlockingWarning("業種「特殊作業7」（本日1人）は稼動人数表に書ける行が足りないため業種の行には出していません（人数は計・累計に含めています）"),
      noTradeToday: w.isBlockingWarning("工種が未入力の業者の人数（本日2人）は、稼動人数表の業種の行には出せません（人数は計・累計に含めています）"),
      cum: w.isBlockingWarning("業種「特殊作業7」（累計1人）は稼動人数表に書ける行が足りないため業種の行には出していません（人数は累計に含めています）"),
      dlv: w.isBlockingWarning("搬入・搬出が4件あり、様式の3行に収まらないため「ほか2件」と書きました"),
      dated: w.isBlockingWarning("2026-10-06: 協力会社欄に書けるのは14行までのため…"),
      empty: w.confirmOutputWarnings(["搬入・搬出が4件あり…"], "Excelを出力")
    };
  });
  check("判定: 協力会社欄に書けない作業行・その日の人数を業種の行に書けない（工種未入力を含む）はダウンロード前に確認する", unit.rows && unit.today && unit.noTradeToday && unit.dated, JSON.stringify(unit));
  check("判定: 累計だけの業種・搬入の「ほか n件」は確認しない（確認の画面を出さずに出力してよい）", !unit.cum && !unit.dlv && unit.empty === true && seen.length === 0, JSON.stringify(unit));

  // 架空データ: 1日目に様式に無い業種7つ（空き行は6つ）→ 2日目以降は累計だけの業種が1つ書けない
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const site = await createSite({ name: "出力前の確認の試験", startDate: "2026-10-01", endDate: "2026-12-31" });
    const row = (i, name, trade, n = "1") => ({ companyId: `c${i}`, companyName: name, occupation: trade, plannedWorkerCount: n, actualWorkerCount: n, workContent: "作業" });
    const mk = (date, companies, extra = {}) => createReport({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", companies, ...extra });
    const custom = Array.from({ length: 7 }, (_, i) => row(i, `協力${i + 1}`, `特殊作業${i + 1}`));
    await mk("2026-10-02", custom);
    const cumOnly = await mk("2026-10-03", [row(0, "アオバ塗装工業", "塗装", "2")]);
    const dlv = await mk("2026-10-04", [row(0, "アオバ塗装工業", "塗装", "1")], { deliveries: Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, direction: "in", time: `0${8 + i}:00`, item: `資材${i + 1}`, quantity: "1式", vendor: "イズミ足場工業", status: "plan" })) });
    const today = await mk("2026-10-05", custom);
    const rows = await mk("2026-10-06", Array.from({ length: 16 }, (_, i) => row(i, `協力${i + 1}`, "塗装")));
    return { site: site.id, cumOnly: cumOnly.id, dlv: dlv.id, today: today.id, rows: rows.id };
  });
  const snap = (id) => page.evaluate(async (id) => { const r = await (await import("/js/reports.js")).getReport(id); return JSON.stringify({ c: r.companies, d: r.deliveries, date: r.date, s: r.dayStatus }); }, id);
  const sheetOf = (b64) => page.evaluate(async (b64) => {
    const z = await import("/js/zipUtil.js"); const eng = await import("/js/report-output/xlsxTemplateEngine.js");
    const zip = z.loadZip(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const wb = await z.readZipEntryText(zip, "xl/workbook.xml"), rels = await z.readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
    const p = "xl/" + new RegExp(`Id="${/<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1]}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?xl\//, "");
    return (await z.readZipEntryText(zip, p)).replace(/<sheetData>/, "");
  }, b64);
  const freshSheet = async (id) => sheetOf(await page.evaluate(async (id) => {
    const { getReport } = await import("/js/reports.js"); const { getSite } = await import("/js/sites.js"); const { resolveReportTemplateForSite } = await import("/js/report-output/templateResolver.js"); const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const r = await getReport(id); const t = await resolveReportTemplateForSite(await getSite(r.siteId));
    const u = new Uint8Array(await (await generateReportOutput({ reportId: id, format: "excel", templateId: t.templateId })).blob.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s);
  }, id));

  // 日報画面の［Excel出力］を押す。確認が出たら answer（true=出力する／false=やめる）
  const excelFromReport = async (id, answer = true) => {
    await page.goto(`${BASE}#/sites/${ids.site}`); await page.goto(`${BASE}#/sites/${ids.site}/report/${id}`); await page.waitForSelector("#reportExcelBtn");
    await page.waitForTimeout(300);
    seen.length = 0; answers.length = 0; answers.push(answer);
    const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => { document.getElementById("message").textContent = ""; }); // 前の操作のメッセージを読まないように
    await page.click("#reportExcelBtn");
    // メッセージは、出力をやめたときは3秒で消えるので、表示されたらすぐに読む
    await page.waitForFunction(() => document.getElementById("message").textContent.trim() !== "", null, { timeout: 8000 }).catch(() => {});
    const msg = await page.textContent("#message");
    const d = await dl;
    let b64 = null;
    if (d) b64 = fs.readFileSync(await d.path()).toString("base64");
    return { confirm: seen.find((x) => x.type === "confirm")?.message || "", downloaded: !!d, msg, b64 };
  };

  const before = { cumOnly: await snap(ids.cumOnly), dlv: await snap(ids.dlv), today: await snap(ids.today), rows: await snap(ids.rows) };

  const a = await excelFromReport(ids.cumOnly);
  check("累計だけの業種: ダウンロード前の確認は出ず、そのまま出力する", !a.confirm && a.downloaded, a.confirm.slice(0, 80));
  check("累計だけの業種: 出力後の注意として表示する", /注意:/.test(a.msg) && a.msg.includes("（累計1人）"), a.msg.slice(0, 160));
  await page.waitForTimeout(5000);
  check("出力後の注意は長めに表示する（5秒後も残っている）", (await page.textContent("#message")).includes("（累計1人）"));
  check("累計だけの業種: 出力した Excel の中身は、確認の有無に関係なく同じ（出力処理は変えていない）", (await sheetOf(a.b64)) === (await freshSheet(ids.cumOnly)));

  const b = await excelFromReport(ids.dlv);
  check("搬入・搬出の「ほか n件」: ダウンロード前の確認は出ず、そのまま出力する", !b.confirm && b.downloaded, b.confirm.slice(0, 80));
  check("搬入・搬出の「ほか n件」: 出力後の注意として表示する", b.msg.includes("ほか") && b.msg.includes("搬入・搬出が4件"), b.msg.slice(0, 160));

  const c = await excelFromReport(ids.today, false);
  check("その日の人数を業種の行に書けない: ダウンロード前に確認する（業種名と本日の人数）", c.confirm.includes("（本日1人）") && c.confirm.includes("業種「"), c.confirm.slice(0, 160));
  check("その日の人数を業種の行に書けない: 確認で「やめる」とダウンロードしない", !c.downloaded && /やめました/.test(c.msg), c.msg.slice(0, 80));

  const d = await excelFromReport(ids.rows, true);
  check("協力会社欄に書けない作業行: ダウンロード前に確認する（行番号・業者）", d.confirm.includes("15行目") && d.confirm.includes("16行目") && d.confirm.includes("協力16"), d.confirm.slice(0, 160));
  check("協力会社欄に書けない作業行: 確認で「出力する」とダウンロードする・中身は従来どおり", d.downloaded && (await sheetOf(d.b64)) === (await freshSheet(ids.rows)));

  // まとめて出力（ZIP）: 確認するのは書けない作業行・本日の人数があるときだけ
  const bulk = await page.evaluate(async (ids) => {
    const rp = await import("/js/reportPrint.js"); const w = await import("/js/ui/output-warnings.js");
    const calls = [];
    const r1 = await rp.exportReportsExcelZip([ids.cumOnly, ids.dlv], "a.zip", { beforeDownload: (ws) => { calls.push(w.splitOutputWarnings(ws).blocking.length); return true; } });
    const r2 = await rp.exportReportsExcelZip([ids.cumOnly, ids.rows], "b.zip", { beforeDownload: (ws) => { calls.push(w.splitOutputWarnings(ws).blocking.length); return true; } });
    return { calls, w1: r1.warnings.length, w2: r2.warnings.length };
  }, ids);
  check("まとめて出力: 累計だけ・ほか n件だけなら確認しない、書けない作業行がある日報を含めば確認する（注意はすべて残す）", bulk.calls[0] === 0 && bulk.calls[1] > 0 && bulk.w1 >= 2 && bulk.w2 >= 2, JSON.stringify(bulk));

  const after = { cumOnly: await snap(ids.cumOnly), dlv: await snap(ids.dlv), today: await snap(ids.today), rows: await snap(ids.rows) };
  check("日報のデータ（作業行・搬入搬出・日付・日の状態）は出力・確認の前後で変わらない", JSON.stringify(before) === JSON.stringify(after));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
