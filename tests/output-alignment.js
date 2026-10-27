// 03-2（会社様式）の配置（2026-10-26。架空データ・隔離したプロファイル・同梱の03-2）
//   ・巡回点検の ○×（L7〜L39）: 上下・左右とも中央
//   ・協力会社欄の予定・実績の人数（C・D列）: 上下・左右とも中央
//   ・協力会社欄の職種（B列）: 右揃え（上下は中央）。稼動人数表の職種（M列）は中央のまま
//   Excel（1日分・台帳）・PDF（会社様式の印刷用HTML）・台帳の印刷で確かめる。配置以外の書式（フォント・罫線・塗り・表示形式）、
//   列幅・行の高さ・結合・印刷設定・値は変えないことも確かめる。Microsoft Excel 実機・Safari・iPad の印刷は自動テストでは確認できない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const OCC = "職種配置試験工事"; // 協力会社欄の職種（ほかに同じ文字が無い名前）
const PLAN = "13", ACT = "11"; // 予定・実績（ほかの欄に出ない数）

/** 印刷用HTMLの中で、文字が text と同じセルの、セル（td）・箱（.xc）・文字（span）の位置 */
const MEASURE = (texts) => Object.fromEntries(texts.map((text) => [text, [...document.querySelectorAll("table.xlsx-sheet .xc > span")].filter((s) => s.textContent === text).map((s) => {
  const range = document.createRange(); range.selectNodeContents(s); const r = range.getBoundingClientRect();
  const box = s.parentElement.getBoundingClientRect(); const td = s.closest("td").getBoundingClientRect();
  return { x: td.left, dx: (r.left + r.right) / 2 - (td.left + td.right) / 2, dy: (r.top + r.bottom) / 2 - (box.top + box.bottom) / 2, right: td.right - r.right, left: r.left - td.left, w: td.width };
})]));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "output-align-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // 9/1 通常作業（○と×）・9/2 休工日（点検の記録なし＝斜線）・9/3 通常作業（2頁目以降の頁の確認）
  const ids = await page.evaluate(async ({ OCC, PLAN, ACT }) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { PATROL_CHECKLIST_ITEMS } = await import("/js/patrolChecklist.js");
    const all = (v) => Object.fromEntries(PATROL_CHECKLIST_ITEMS.map((i) => [i.key, v]));
    const site = await createSite({ name: "配置の試験", startDate: "2026-09-01", endDate: "2026-09-03" });
    const co = [{ companyId: "a", companyName: "サンプル工業", occupation: OCC, plannedWorkerCount: PLAN, actualWorkerCount: ACT, workContent: "外壁の作業", workHours: "08:00～17:00" }];
    const d1 = stampNew({ siteId: site.id, date: "2026-09-01", dayStatus: "work", companies: co, patrolChecklist: { ...all("good"), qualificationCheck: "bad" }, patrolComment: "是正" });
    const d2 = stampNew({ siteId: site.id, date: "2026-09-02", dayStatus: "holiday", companies: [] });
    const d3 = stampNew({ siteId: site.id, date: "2026-09-03", dayStatus: "work", companies: co, patrolChecklist: all("good") });
    for (const r of [d1, d2, d3]) await dbPut("reports", r);
    return { site: site.id, d1: d1.id, d2: d2.id, d3: d3.id };
  }, { OCC, PLAN, ACT });

  const x = await page.evaluate(async (ids) => {
    const { getSite } = await import("/js/sites.js"); const rp = await import("/js/reportPrint.js"); const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const { generateLedgerWorkbook } = await import("/js/report-output/ledger/generateLedgerOutput.js"); const { getReportTemplate } = await import("/js/report-output/reportTemplates.js");
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const xr = await import("/js/report-output/xlsxSheetReader.js"); const eng = await import("/js/report-output/xlsxTemplateEngine.js");
    const site = await getSite(ids.site); const t = await rp.resolveCompanyTemplateForSite(site);
    const open = async (blob, sheetName) => {
      const zip = loadZip(await blob.arrayBuffer()); const wb = await readZipEntryText(zip, "xl/workbook.xml"); const rels = await readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
      const sp = sheetName ? eng.resolveSheetPartPath(wb, rels, sheetName) : "xl/" + new RegExp(`Id="${/<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1]}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?xl\//, "");
      const sheetXml = await readZipEntryText(zip, sp); const stylesXml = await readZipEntryText(zip, "xl/styles.xml");
      const lay = xr.readSheetLayout(sheetXml, xr.parseSharedStrings(await readZipEntryText(zip, "xl/sharedStrings.xml")));
      const xfs = [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g))].map((m) => m[0]);
      const sOf = (ref) => Number((new RegExp(`<c r="${ref}"[^>]*?\\ss="(\\d+)"`).exec(sheetXml) || [])[1] || 0);
      // 配置以外の書式（フォント・罫線・塗り・表示形式・保護）。配置の要素と applyAlignment を除いた xf
      const rest = (ref) => xfs[sOf(ref)].replace(/<alignment\b[^>]*\/>|<alignment\b[^>]*>[\s\S]*?<\/alignment>/, "").replace(/\sapplyAlignment="[^"]*"/, "").replace(/<xf([^>]*)><\/xf>/, "<xf$1/>");
      const align = (ref) => { const a = (/<alignment\b[^>]*>/.exec(xfs[sOf(ref)]) || [""])[0]; const g = (k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(a) || [])[1] || "-"; return `${g("horizontal")}/${g("vertical")}${/textRotation/.test(a) ? "/縦" : ""}${/shrinkToFit="1"/.test(a) ? "/縮小" : ""}${/wrapText="1"/.test(a) ? "/折返" : ""}`; };
      const diag = (ref) => /diagonalDown="1"/.test(xfs[sOf(ref)]) || (() => { const bid = Number((/borderId="(\d+)"/.exec(xfs[sOf(ref)]) || [])[1] || 0); const b = [...(/<borders[^>]*>([\s\S]*?)<\/borders>/.exec(stylesXml)[1].matchAll(/<border\b[^>]*\/>|<border\b[^>]*>[\s\S]*?<\/border>/g))][bid]?.[0] || ""; return /diagonalDown="1"/.test(b); })();
      const struct = (s) => ["cols", "mergeCells", "pageSetup", "pageMargins", "rowBreaks", "colBreaks", "printOptions", "headerFooter"].map((k) => (new RegExp(`<${k}\\b[\\s\\S]*?(?:</${k}>|/>)`).exec(s) || [""])[0]).join("\n") + [...s.matchAll(/<row r="(\d+)"[^>]*?(?:\sht="([\d.]+)")?[^>]*>/g)].map((m) => `${m[1]}:${m[2] || ""}`).join(",");
      return { text: (ref) => lay.cells.get(ref)?.text ?? "", align, rest, diag, struct: struct(sheetXml), xfCount: xfs.length, stylesXml };
    };
    const tplBlob = (await getReportTemplate(t.templateId)).sourceFileBlob;
    const tpl = await open(tplBlob, "手書印刷用"); const ledTpl = await open(tplBlob, "1～20");
    const d1 = await open((await generateReportOutput({ reportId: ids.d1, format: "excel", templateId: t.templateId })).blob);
    const d2 = await open((await generateReportOutput({ reportId: ids.d2, format: "excel", templateId: t.templateId })).blob);
    const led = await open((await generateLedgerWorkbook({ siteId: ids.site, templateId: t.templateId })).blob);
    const refs = ["L7", "L8", "L39", "C7", "D7", "C33", "D33", "B7", "B33", "A7", "E7", "G7", "J7", "M7", "O7", "I7", "L6", "B6", "C6", "D6"];
    const pick = (o, rs) => Object.fromEntries(rs.map((r) => [r, o.align(r)]));
    const restSame = (o, base, rs) => rs.filter((r) => o.rest(r) !== base.rest(r));
    // 台帳の頁: 1日目＝1〜52行、2日目＝53〜104行、3日目＝105〜156行
    const ledRefs = ["L7", "L59", "L111", "L143", "C111", "D111", "B111", "A111", "B85", "M111"];
    // 原本の xf（既存の書式）が書き換わっていないか（足すだけ）
    const xfsOf = (s) => [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(s)[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g))].map((m) => m[0]);
    const tx = xfsOf(tpl.stylesXml), ox = xfsOf(d1.stylesXml);
    return {
      tpl: pick(tpl, refs), d1: pick(d1, refs), d2: pick(d2, ["L7", "L39", "C7", "B7"]), led: pick(led, ledRefs), ledTpl: pick(ledTpl, ledRefs),
      restDiff1: restSame(d1, tpl, refs), restDiffLed: restSame(led, ledTpl, ledRefs.filter((r) => !/^L(59)$/.test(r))),
      d2diag: ["L7", "L20", "L39"].every((r) => d2.diag(r)), d2text: ["L7", "L39"].map((r) => d2.text(r)),
      vals: { L7: d1.text("L7"), L8: d1.text("L8"), B7: d1.text("B7"), C7: d1.text("C7"), D7: d1.text("D7"), A7: d1.text("A7") },
      // 印刷設定の「1ページに収める」（fitToWidth・fitToHeight）は従来から出力で付ける（mapping の fitToPage）。それ以外は様式のまま
      structSame: [d1, d2].every((o) => o.struct.replace(/ fitToWidth="1" fitToHeight="1"/, "") === tpl.struct), xfAppendOnly: tx.every((v, i) => ox[i] === v) && ox.length >= tx.length,
      pdf1: (await rp.buildReportPrintHtml(ids.d1)).html, pdf2: (await rp.buildReportPrintHtml(ids.d2)).html, ledHtml: (await rp.buildSiteLedgerPrintHtml(ids.site)).html
    };
  }, ids);

  // ---------- Excel ----------
  check("Excel（1日分）: 値は日報のまま（○・×・職種・予定・実績・協力会社名）", x.vals.L7 === "○" && x.vals.L8 === "×" && x.vals.B7 === OCC && x.vals.C7 === PLAN && x.vals.D7 === ACT && x.vals.A7 === "サンプル工業", JSON.stringify(x.vals));
  check("Excel（1日分）: ○×（L7〜L39）は上下・左右とも中央", ["L7", "L8", "L39"].every((r) => x.d1[r].startsWith("center/center")), JSON.stringify(["L7", "L8", "L39"].map((r) => `${r} ${x.tpl[r]}→${x.d1[r]}`)));
  check("Excel（1日分）: 予定・実績（C・D列。2社目以降の行も）は上下・左右とも中央", ["C7", "D7", "C33", "D33"].every((r) => x.d1[r].startsWith("center/center")), JSON.stringify(["C7", "D7", "C33", "D33"].map((r) => `${r} ${x.tpl[r]}→${x.d1[r]}`)));
  check("Excel（1日分）: 協力会社欄の職種（B列）は右揃え・上下は中央", ["B7", "B33"].every((r) => x.d1[r].startsWith("right/center")), JSON.stringify(["B7", "B33"].map((r) => `${r} ${x.tpl[r]}→${x.d1[r]}`)));
  check("Excel（1日分）: 対象外のセル（協力会社名・作業内容・注意事項・見出し・分類・稼動人数表は従来の中央）は変えない", ["A7", "E7", "G7", "I7", "L6", "B6", "C6", "D6"].every((r) => x.d1[r] === x.tpl[r]) && ["J7", "M7", "O7"].every((r) => x.d1[r].startsWith("center/center")), JSON.stringify(["A7", "E7", "G7", "I7", "B6"].map((r) => `${r} ${x.tpl[r]}→${x.d1[r]}`)));
  check("Excel（1日分）: 配置以外の書式（フォント・罫線・塗り・表示形式）は様式のまま", x.restDiff1.length === 0, x.restDiff1.join("・"));
  check("Excel（1日分）: 列幅・行の高さ・結合・印刷設定（従来の1ページに収める指定のほか）・改頁は様式のまま、原本の書式は書き換えず足すだけ", x.structSame && x.xfAppendOnly);
  check("Excel（休工日・点検の記録なし）: ○×の欄は斜線のまま（文字なし）で中央揃え", x.d2diag && x.d2text.every((t) => t === "") && ["L7", "L39"].every((r) => x.d2[r].startsWith("center/center")), JSON.stringify({ diag: x.d2diag, text: x.d2text, align: x.d2 }));
  check("Excel（台帳）: 全頁の ○×・予定・実績が中央、職種が右揃え（3日目の頁を含む）", ["L7", "L59", "L111", "L143", "C111", "D111", "M111"].every((r) => x.led[r].startsWith("center/center")) && ["B111", "B85"].every((r) => x.led[r].startsWith("right/center")), JSON.stringify(x.led));
  check("Excel（台帳）: 協力会社名は変えない・縮小して全体を表示（shrinkToFit）など他の配置の指定は残す・配置以外の書式は様式のまま", x.led.A111 === x.ledTpl.A111 && /縮小/.test(x.led.B111) === /縮小/.test(x.ledTpl.B111) && /縮小/.test(x.led.L111) === /縮小/.test(x.ledTpl.L111) && x.restDiffLed.length === 0, JSON.stringify({ A: [x.ledTpl.A111, x.led.A111], B: [x.ledTpl.B111, x.led.B111], diff: x.restDiffLed }));

  // ---------- PDF（会社様式の印刷用HTML）・台帳の印刷：実際に描画した位置 ----------
  for (const [name, bt] of [["Chromium", chromium], ["WebKit", webkit]]) {
    const b = await bt.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
    for (const [label, html] of [["PDF", x.pdf1], ["台帳の印刷", x.ledHtml]]) {
      await p.setContent(html); await p.waitForTimeout(700);
      const m = await p.evaluate(MEASURE, ["○", "×", PLAN, ACT, OCC, "サンプル工業"]);
      const centered = (arr) => arr.length > 0 && arr.every((v) => Math.abs(v.dx) <= 1.5 && Math.abs(v.dy) <= 1.5);
      check(`${name} ${label}: ○×はセルの上下・左右とも中央`, centered(m["○"]) && centered(m["×"]), JSON.stringify({ o: m["○"].length, x: m["×"].length, worst: [...m["○"], ...m["×"]].reduce((a, v) => Math.max(a, Math.abs(v.dx), Math.abs(v.dy)), 0).toFixed(2) }));
      check(`${name} ${label}: 予定・実績の人数はセルの上下・左右とも中央`, centered(m[PLAN]) && centered(m[ACT]), JSON.stringify([m[PLAN][0], m[ACT][0]]));
      // 同じ職種名は稼動人数表（M列・中央のまま）の空き行にも出るので、左にある協力会社欄（B列）のものだけを見る
      const minX = Math.min(...m[OCC].map((v) => v.x)); const occB = m[OCC].filter((v) => v.x < minX + 5);
      check(`${name} ${label}: 協力会社欄の職種はセルの右端にそろい（左は空く）・上下は中央`, occB.length > 0 && occB.every((v) => v.right <= 3.5 && v.left > v.right + 4 && Math.abs(v.dy) <= 1.5), JSON.stringify(occB));
      check(`${name} ${label}: 協力会社名は左寄せのまま`, m["サンプル工業"].length > 0 && m["サンプル工業"].every((v) => v.left <= 4 && v.right > v.left), JSON.stringify(m["サンプル工業"]));
      if (label === "PDF") check(`${name} PDF: 箱に収まらない文字が無い`, (await p.evaluate(() => window.__xlsxCellsClipped)) === 0);
    }
    await p.setContent(x.pdf2); await p.waitForTimeout(500);
    const diag = await p.evaluate(() => [...document.querySelectorAll("table.xlsx-sheet td")].filter((td) => /linear-gradient/.test(td.getAttribute("style") || "") || /linear-gradient/.test(getComputedStyle(td).backgroundImage)).length);
    check(`${name} PDF（休工日）: ○×の欄の斜線は残る（33セル以上）`, diag >= 33, `${diag}`);
    await b.close();
  }
  // PDF も A3横・1ページのまま
  const pp = await ctx.newPage(); await pp.setViewportSize({ width: 1600, height: 1200 });
  await pp.setContent(x.pdf1); await pp.waitForTimeout(600); await pp.emulateMedia({ media: "print" });
  const pdf = await pp.pdf({ printBackground: true, preferCSSPageSize: true });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("PDF: A3横・1ページのまま", pages === 1 && /\/MediaBox\s*\[\s*0\s+0\s+119[01]/.test(pdf.toString("latin1")), `${pages}ページ`);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((v) => !v).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
