// 工事期間の台帳出力（安全衛生作業打合日誌の台帳シート）の検証
// 実ブラウザ・実IndexedDB・実際の会社指定Excel様式で、画面のボタンから出力して確認する。
// 原本テンプレートは読み取りのみ（SHA-256で不変を確認）。
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/ledger-output.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const TEMPLATE = ORIGINAL_TEMPLATE;
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "ledger-output-test");
fs.mkdirSync(OUT, { recursive: true });
// 原本テンプレートに入っていた別工事の記入例・社内パス等（出力に1つも残ってはいけない）。コードには書かず、実行時に原本から取り出す
let LEAK_WORDS = [];

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  if (!fs.existsSync(TEMPLATE)) { console.log("会社指定様式が見つかりません: " + TEMPLATE); process.exit(2); }
  const templateBytes = fs.readFileSync(TEMPLATE);
  const H0 = sha(templateBytes);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());

  await page.goto(BASE);
  await page.waitForSelector("#view-site-list:not([hidden])");
  LEAK_WORDS = await leakWordsFromOriginal(page, templateBytes, { includeRemoveTexts: false }); // 原本（利用者が登録した会社の様式）で出力するので、見出しの会社名は対象外
  // 新規端末の初回起動で自動登録される同梱の標準テンプレート（クリーンな03-2）を取り除き、
  // このテストで登録する会社様式（原本）だけで検証する（同梱の検証は tests/bundled-template.js）
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length > 0, null, { timeout: 2000 }).catch(() => {});
  await page.evaluate(async () => { const { dbDelete, dbGetAll } = await import("/js/db.js"); for (const t of await dbGetAll("reportTemplates")) await dbDelete("reportTemplates", t.id); });

  // ---- 準備: 会社指定様式・現場（2026-04-01〜10-31＝214日、7ヶ月）・日報（日曜は休工）----
  const START = "2026-04-01", END = "2026-10-31";
  const setup = await page.evaluate(async ({ b64, START, END }) => {
    const { createSite } = await import("/js/sites.js");
    const { createReport } = await import("/js/reports.js");
    const { saveSignature } = await import("/js/signatures.js");
    const { createCompanyProfile } = await import("/js/report-output/companyProfiles.js");
    const { createReportTemplate } = await import("/js/report-output/reportTemplates.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const company = await createCompanyProfile({ name: "台帳テスト元請" });
    await createReportTemplate({ companyProfileId: company.id, format: "excel", name: "安全衛生作業打合日誌", rendererId: "xlsx-template-patch", sourceFileBlob: new Blob([bytes]), sourceFileName: "anzen.xlsx", sourceFileMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const site = await createSite({ name: "台帳検証現場", clientName: "台帳テスト元請", startDate: START, endDate: END });
    const ids = {};
    let i = 0;
    for (let t = Date.parse(START + "T00:00:00Z"); t <= Date.parse(END + "T00:00:00Z"); t += 86400000, i++) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (new Date(t).getUTCDay() === 0) continue; // 日曜＝休工日
      if (date === "2026-05-12") continue; // 後から追加する日
      const r = await createReport({
        siteId: site.id, date, weather: ["晴れ", "曇り", "雨"][i % 3], temperature: String(15 + (i % 10)),
        siteSupervisorNames: ["監督A"],
        patrolChecklist: { morningMeeting: "good", helmetWear: i % 5 === 0 ? "bad" : "good" },
        patrolComment: i % 7 === 0 ? `是正${date}` : "",
        companies: [
          { companyId: "c1", companyName: "山田足場工業", occupation: "とび工", plannedWorkerCount: "5", actualWorkerCount: "4", workContent: `足場${date}`, safetyNotes: "墜落注意" },
          { companyId: "c2", companyName: "佐藤電設", occupation: "電工", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: `配線${date}`, safetyNotes: "感電注意" }
        ]
      });
      ids[date] = r.id;
    }
    // 職長サイン（1日分）
    const c = document.createElement("canvas"); c.width = 120; c.height = 40; const g = c.getContext("2d"); g.fillText("山田", 10, 25);
    const png = await new Promise((res) => c.toBlob(res, "image/png"));
    await saveSignature({ reportId: ids["2026-04-02"], companyId: "c1", role: "foreman", blob: png });
    return { siteId: site.id, ids };
  }, { b64: templateBytes.toString("base64"), START, END });

  // 出力された台帳.xlsxをブラウザ内で解析する（アプリ同梱のZIP/セル解析部品を使用）
  const inspect = (b64, probes) => page.evaluate(async ({ b64, probes, LEAK_WORDS }) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const { parseSharedStringsXml, readSheetCells } = await import("/js/report-output/ledger/sheetCells.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(bytes.buffer);
    const sheets = await pkg.listSheets();
    const ss = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
    const cellsOf = {};
    for (const s of sheets) cellsOf[s.name] = readSheetCells(await pkg.getText(s.path), ss);
    const leaks = [];
    for (const p of pkg.listParts()) {
      if (!/\.(xml|rels|vml)$/.test(p)) continue;
      const t = await pkg.getText(p);
      for (const w of LEAK_WORDS) if (t.includes(w)) leaks.push(`${p}:${w}`);
    }
    const out = {};
    for (const [key, { day, ref }] of Object.entries(probes)) {
      const sheet = sheets[Math.floor(day / 20)];
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      const c = sheet && cellsOf[sheet.name].get(`${m[1]}${Number(m[2]) + (day % 20) * 52}`);
      out[key] = c ? { v: c.value, f: !!c.formula } : null;
    }
    const workbook = await pkg.getText("xl/workbook.xml");
    const drawings = [];
    for (const p of pkg.listParts()) if (/drawings\/drawing\d+\.xml$/.test(p)) drawings.push((await pkg.getText(p)).includes("foreman-signature"));
    return { sheetNames: sheets.map((s) => s.name), leaks, out, printAreas: [...workbook.matchAll(/_xlnm\.Print_Area" localSheetId="\d+">([^<]*)</g)].map((m) => m[1]), hasSignature: drawings.some(Boolean), partCount: pkg.listParts().length };
  }, { b64, probes, LEAK_WORDS });

  const dayOf = (date) => Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(START + "T00:00:00Z")) / 86400000);
  const serial = (date) => Math.round((Date.parse(date + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000);

  async function downloadLedger(name) {
    await page.goto(`${BASE}#/sites/${setup.siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])");
    await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click("#ledgerExcelBtn")]);
    const file = path.join(OUT, name); await dl.saveAs(file);
    return { file, suggested: dl.suggestedFilename(), b64: fs.readFileSync(file).toString("base64") };
  }

  // ===== 1. 台帳Excelを画面から出力 =====
  const t0 = Date.now();
  const x1 = await downloadLedger("ledger_1.xlsx");
  const ms = Date.now() - t0;
  const probes = {
    f2first: { day: 0, ref: "F2" }, g4first: { day: 0, ref: "G4" }, e4first: { day: 0, ref: "E4" },
    a7first: { day: 0, ref: "A7" }, j2first: { day: 0, ref: "J2" }, j4first: { day: 0, ref: "J4" },
    g4day19: { day: 19, ref: "G4" }, g4day20: { day: 20, ref: "G4" }, f2day20: { day: 20, ref: "F2" },
    sunE7: { day: dayOf("2026-04-05"), ref: "E7" }, sunG4: { day: dayOf("2026-04-05"), ref: "G4" },
    may12: { day: dayOf("2026-05-12"), ref: "E7" }, jun10: { day: dayOf("2026-06-10"), ref: "E7" },
    d181E7: { day: 180, ref: "E7" }, d181G4: { day: 180, ref: "G4" }, lastG4: { day: 213, ref: "G4" }, lastE7: { day: 213, ref: "E7" },
    p50last: { day: 213, ref: "P50" }, o50last: { day: 213, ref: "O50" }, l10: { day: 0, ref: "L10" }
  };
  const r1 = await inspect(x1.b64, probes);
  const o = r1.out;
  check("1 画面の「台帳Excel」ボタンで台帳を1ファイル出力できる", x1.suggested.includes("台帳") && x1.suggested.includes(`${START}〜${END}`), `${x1.suggested}（${ms}ms）`);
  check("1 7ヶ月（214日）で台帳シートが11枚に自動拡張される（180日の上限なし）", r1.sheetNames.length === 11 && r1.sheetNames[9] === "181～200" && r1.sheetNames[10] === "201～220", r1.sheetNames.join(","));
  check("1 様式シート（手書印刷用）は台帳から外れている", !r1.sheetNames.includes("手書印刷用"));
  check("1 他工事データ（別工事名・業者名・社内パス）が1つも残っていない", r1.leaks.length === 0, r1.leaks.slice(0, 5).join(","));
  check("2 起点: 工事名F2・作業日G4＝工事開始日・打合日E4＝前日", o.f2first.v === "台帳検証現場" && Number(o.g4first.v) === serial(START) && Number(o.e4first.v) === serial(START) - 1, JSON.stringify([o.f2first, o.g4first, o.e4first]));
  check("2 気温は1値（気温：15℃）・天候", o.j2first.v === "気温：15℃" && o.j4first.v === "天候：晴れ", `${o.j2first.v} / ${o.j4first.v}`);
  check("3 1枚目20頁目・2枚目1頁目の作業日が暦日で連続（数式のまま）", Number(o.g4day19.v) === serial(START) + 19 && o.g4day19.f && Number(o.g4day20.v) === serial(START) + 20, JSON.stringify([o.g4day19, o.g4day20]));
  check("3 2枚目以降の工事名は数式（1枚目F2を参照）", o.f2day20.f && o.f2day20.v === "台帳検証現場");
  check("3 休工日（日曜）の頁は日付だけで本文は空欄", !o.sunE7?.v && Number(o.sunG4.v) === serial("2026-04-05"), JSON.stringify([o.sunE7, o.sunG4]));
  check("3 日報の内容が日付どおりの頁に入る（6/10・181日目・最終日）", o.jun10.v === "足場2026-06-10" && o.d181E7.v === "足場2026-09-28" && Number(o.d181G4.v) === serial("2026-09-28") && o.lastE7.v === "足場2026-10-31" && Number(o.lastG4.v) === serial(END), JSON.stringify([o.jun10, o.d181E7, o.lastE7]));
  const expectedCum = Object.keys(setup.ids).length; // 監督Aが1名×日報件数
  check("5 社員累計P50は数式で、最終日の累計＝日報件数", o.p50last.f && Number(o.p50last.v) === expectedCum && Number(o.o50last.v) === 1, JSON.stringify([o.p50last, expectedCum]));
  check("2 巡回点検の○×が状況欄（L列）に入る", o.l10.v === "×" || o.l10.v === "○", JSON.stringify(o.l10));
  check("2 職長サインが台帳の図形として貼り付けられる", r1.hasSignature);
  check("印刷範囲: 最後のシートは工事最終日の頁まで（201～220の14頁目）", r1.printAreas.some((a) => a.includes("201～220") && a.endsWith("$P$728")), r1.printAreas.slice(-1)[0]);
  check("原本テンプレートSHA-256が出力後も不変", sha(fs.readFileSync(TEMPLATE)) === H0 && (!ORIGINAL_SHA256 || H0 === ORIGINAL_SHA256));

  // ===== 4. 同じ期間を再出力 → 同一 =====
  const x2 = await downloadLedger("ledger_2.xlsx");
  check("4 同じ期間を2回出力しても内容が同一（重複・ずれなし）", sha(fs.readFileSync(x1.file)) === sha(fs.readFileSync(x2.file)));

  // ===== 5. 後から日報を追加 → その頁だけ埋まる =====
  await page.evaluate(async ({ siteId }) => {
    const { createReport } = await import("/js/reports.js");
    await createReport({ siteId, date: "2026-05-12", weather: "晴れ", temperature: "20", siteSupervisorNames: ["監督A"], companies: [{ companyId: "c1", companyName: "後追加工業", occupation: "左官", plannedWorkerCount: "1", actualWorkerCount: "1", workContent: "後から追加した作業", safetyNotes: "" }] });
  }, { siteId: setup.siteId });
  const x3 = await downloadLedger("ledger_3.xlsx");
  const r3 = await inspect(x3.b64, { ...probes, may12a: { day: dayOf("2026-05-12"), ref: "A7" } });
  check("5 後から追加した日報が正しい頁（5/12）に入る", r3.out.may12.v === "後から追加した作業" && r3.out.may12a.v === "後追加工業" && !o.may12?.v, JSON.stringify([o.may12, r3.out.may12]));
  const unchanged = ["jun10", "d181E7", "lastE7", "sunE7", "g4day20", "a7first"].every((k) => JSON.stringify(r3.out[k]) === JSON.stringify(o[k]));
  check("5 追加しても他の日の頁は変わらない", unchanged);
  check("5 累計は追加分だけ増える（数式が再計算される）", Number(r3.out.p50last.v) === expectedCum + 1, `${o.p50last.v} → ${r3.out.p50last.v}`);

  // ===== 6. 日報を修正 → 再出力で該当頁だけ変わる =====
  await page.evaluate(async ({ id }) => {
    const { getReport, updateReport } = await import("/js/reports.js");
    const r = await getReport(id);
    await updateReport(id, { companies: [{ ...r.companies[0], workContent: "修正後の作業" }, r.companies[1]] });
  }, { id: setup.ids["2026-06-10"] });
  const x4 = await downloadLedger("ledger_4.xlsx");
  const r4 = await inspect(x4.b64, probes);
  check("6 修正した日報を再出力すると該当頁（6/10）が修正後の内容になる", r4.out.jun10.v === "修正後の作業");
  check("6 修正内容は他の日の頁に上書きされない", ["d181E7", "lastE7", "may12", "a7first"].every((k) => JSON.stringify(r4.out[k]) === JSON.stringify(r3.out[k])));

  // ===== 7. 既存の1日1ファイル出力（他工事データ除去）=====
  await page.goto(`${BASE}#/sites/${setup.siteId}/reports/${setup.ids["2026-04-02"]}`);
  await page.goto(`${BASE}#/sites/${setup.siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  const single = await page.evaluate(async ({ id }) => {
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js");
    const { getSite } = await import("/js/sites.js");
    const { getReport } = await import("/js/reports.js");
    const r = await getReport(id);
    const c = await resolveCompanyTemplateForSite(await getSite(r.siteId));
    const res = await generateReportOutput({ reportId: id, format: "excel", templateId: c.templateId });
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { id: setup.ids["2026-04-02"] });
  const rs = await inspect(single, {});
  fs.writeFileSync(path.join(OUT, "single_day.xlsx"), Buffer.from(single, "base64"));
  check("7 1日1ファイル出力: 他工事データが残らない（台帳シートは含めない）", rs.leaks.length === 0 && rs.sheetNames.length === 1 && rs.sheetNames[0] === "手書印刷用", `${rs.sheetNames.join(",")} ${rs.leaks.join(",")}`);

  // ===== 8. 台帳の印刷・PDF =====
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#ledgerPrintBtn");
  await page.waitForSelector("#reportPrintDialog[open]", { timeout: 120000 });
  const html = await page.evaluate(() => document.getElementById("reportPrintFrame").srcdoc);
  fs.writeFileSync(path.join(OUT, "ledger_print.html"), html);
  const pageSections = (html.match(/<section class="ledger-page"/g) || []).length;
  check("8 台帳の印刷用データは工事期間の全頁（214頁）・A3横", pageSections === 214 && /@page \{ size: 420mm 297mm/.test(html), `${pageSections}頁 ${/@page[^;]*;/.exec(html)?.[0]}`);
  check("8 日付は様式の表示形式どおり（作業日：2026年4月1日(水)）", html.includes("作業日：2026年4月1日(水)") && html.includes("打合日：2026年3月31日(火)"));
  check("8 印刷用データにも他工事データが無い", !LEAK_WORDS.some((w) => html.includes(w)));
  await page.click("#reportPrintCloseBtn");
  {
    const p2 = await ctx.newPage();
    await p2.setContent(html, { timeout: 120000 });
    const pdfBytes = await p2.pdf({ preferCSSPageSize: true, timeout: 300000 });
    await p2.close();
    fs.writeFileSync(path.join(OUT, "ledger.pdf"), pdfBytes);
    const txt = Buffer.from(pdfBytes).toString("latin1");
    const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(txt);
    check("8 実際にPDFを生成でき、1日1頁（214頁）・A3横になる", pages === 214 && box && Math.abs(Number(box[1]) - 1190.55) < 3 && Math.abs(Number(box[2]) - 841.89) < 3, `${pages}頁 ${box && box[1]}x${box && box[2]}pt`);
  }

  // ===== 9. エラーの明示（工事開始日なし・開始日より前の日報）=====
  await page.evaluate(async ({ siteId }) => { const { updateSite } = await import("/js/sites.js"); await updateSite(siteId, { startDate: "" }); }, { siteId: setup.siteId });
  await page.goto(`${BASE}#/sites/${setup.siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#ledgerExcelBtn");
  await page.waitForFunction(() => /台帳を出力できませんでした/.test(document.getElementById("message")?.textContent || document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  const msg1 = await page.evaluate(() => document.getElementById("message")?.textContent || "");
  check("9 工事開始日が未設定なら理由を示して出力しない", /工事開始日が設定されていません/.test(msg1), msg1.slice(0, 80));
  await page.evaluate(async ({ siteId }) => { const { updateSite } = await import("/js/sites.js"); await updateSite(siteId, { startDate: "2026-04-10" }); }, { siteId: setup.siteId });
  await page.goto(`${BASE}#/sites/${setup.siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
  await page.click("#ledgerExcelBtn");
  await page.waitForFunction(() => /台帳を出力できませんでした/.test(document.getElementById("message")?.textContent || ""), null, { timeout: 60000 }).catch(() => {});
  const msg2 = await page.evaluate(() => document.getElementById("message")?.textContent || "");
  check("9 工事開始日より前の日報があれば理由を示して出力しない（別の日へ詰めて上書きしない）", /より前の日付の日報があります/.test(msg2), msg2.slice(0, 80));

  const reports = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reports")).length);
  check("データ保護: 台帳出力で日報は削除・変更されない（日報件数不変）", reports === Object.keys(setup.ids).length + 1, `${reports}`);
  check("原本テンプレートSHA-256（全工程後も不変）", sha(fs.readFileSync(TEMPLATE)) === H0);
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
