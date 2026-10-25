// 台帳の印刷（台帳を印刷・PDF）の配置（2026-10-26。架空データ・隔離したプロファイル・同梱の03-2）
//   ・行が伸びない（文字を Excel の行の高さの箱に入れる）→ 様式の図（測量機器の表）が置く行（Excel のアンカー）と同じ高さに出る
//   ・CSS の zoom で縮めない（iPad の Safari の印刷は zoom を文字に効かせず、文字だけ大きくなる）。まねても文字が罫線をまたがない
//   ・頁の高さ÷幅が 0.63 以下（Safari が幅いっぱいに合わせても1日分＝1ページ）。A3横。職長サインは欄の箱の中
//   本物の Safari・iPad の印刷は自動テストでは確認できない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const SAFARI = { preferCSSPageSize: false, width: "420mm", height: "297mm", margin: { top: "16.5mm", bottom: "21.5mm", left: "14.1mm", right: "14.1mm" } };
const countPages = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

/** 頁の測定（行の伸び・図の位置・高さ÷幅・zoom・サインが欄の中か） */
const MEASURE = () => [...document.querySelectorAll(".ledger-page")].map((w) => {
  const t = w.querySelector("table.xlsx-sheet"); const tr = t.getBoundingClientRect(); const rows = [...t.rows];
  const spec = (n) => rows.slice(0, n).reduce((s, r) => s + parseFloat(r.style.height || 0), 0);
  const fig = w.querySelector(".xlsx-overlay-img, .xlsx-overlay-crop"); const figTop = fig ? fig.getBoundingClientRect().top - tr.top : null;
  const signs = [...w.querySelectorAll(".ledger-sign")].map((img) => { const c = img.closest("td").getBoundingClientRect(), r = img.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.left + parseFloat(img.style.width) + 1 && r.height > 5; });
  return { zoom: w.style.zoom || "", stretched: rows.filter((r) => r.getBoundingClientRect().height > parseFloat(r.style.height) + 1.5).length, height: tr.height, spec: spec(rows.length), row45: rows[44] ? rows[44].getBoundingClientRect().top - tr.top : null, spec45: spec(44), figTop, ratio: tr.height / tr.width, signs };
});

/** iPad の Safari のまね（紙面は zoom で縮むが文字は縮まない）をして、文字が罫線をまたぐセルを数える */
const CROSS_IPAD = () => {
  for (const w of document.querySelectorAll(".ledger-page")) { const z = parseFloat(w.style.zoom || "1"); if (z < 1) w.querySelectorAll("td").forEach((td) => { td.style.fontSize = parseFloat(getComputedStyle(td).fontSize) / z + "px"; }); }
  const segV = []; for (const td of document.querySelectorAll("table.xlsx-sheet td")) { const cs = getComputedStyle(td), rc = td.getBoundingClientRect(); if (parseFloat(cs.borderRightWidth) > 0 && cs.borderRightStyle !== "none") segV.push([rc.right, rc.top, rc.bottom]); if (parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== "none") segV.push([rc.left, rc.top, rc.bottom]); }
  let n = 0; for (const xc of document.querySelectorAll("table.xlsx-sheet .xc")) { const range = document.createRange(); range.selectNodeContents(xc.firstElementChild); for (const t of range.getClientRects()) { if (t.width < 1) continue; if (segV.some(([x, y1, y2]) => x > t.left + 2 && x < t.right - 2 && Math.min(y2, t.bottom) - Math.max(y1, t.top) > 3)) { n++; break; } } }
  return n;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-print-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const html = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "台帳の印刷の配置の試験", startDate: "2026-09-01", endDate: "2026-09-03" });
    const long = (s, n) => Array.from({ length: n }, (_, i) => `${s}${i + 1}`).join("・");
    const companies = (k) => Array.from({ length: k }, (_, i) => ({ companyId: `c${i}`, companyName: `協力会社${i + 1}株式会社`, occupation: i % 2 ? "型枠解体工事" : "足場", plannedWorkerCount: "3", actualWorkerCount: "3", workContent: long("作業内容", 4), safetyNotes: long("注意", 2) }));
    const r1 = stampNew({ siteId: site.id, date: "2026-09-01", dayStatus: "work", weather: "晴れ", temperature: "20", companies: companies(3), focusInstructions: long("重点指示", 6) });
    const r2 = stampNew({ siteId: site.id, date: "2026-09-02", dayStatus: "work", weather: "曇り", temperature: "18", companies: companies(14), workCoordination: long("連絡調整", 6) });
    for (const r of [r1, r2]) await dbPut("reports", r);
    const cv = document.createElement("canvas"); cv.width = 300; cv.height = 80; const g = cv.getContext("2d"); g.lineWidth = 3; g.beginPath(); g.moveTo(20, 60); g.lineTo(280, 20); g.stroke();
    await dbPut("signatures", stampNew({ reportId: r1.id, companyId: "c0", role: "foreman", roleLabel: "職長", imageBlob: await new Promise((r) => cv.toBlob(r, "image/png")), signedAt: new Date().toISOString() }));
    return (await (await import("/js/reportPrint.js")).buildSiteLedgerPrintHtml(site.id)).html;
  });
  check("台帳の印刷用HTMLに viewport と text-size-adjust（iPad の文字の自動拡大を止める）", /name="viewport"/.test(html) && /text-size-adjust: 100%/.test(html));
  check("@page は A3横で、左右の余白が同じ", /@page \{ size: 420mm 297mm; margin: [\d.]+mm ([\d.]+)mm [\d.]+mm \1mm; \}/.test(html), (html.match(/@page[^}]*\}/) || [""])[0]);

  for (const [name, bt] of [["Chromium", chromium], ["WebKit", webkit]]) {
    const b = await bt.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
    await p.setContent(html); await p.waitForTimeout(800);
    const m = await p.evaluate(MEASURE);
    check(`${name}: 頁は3頁（工期3日）・CSS の zoom で縮めていない`, m.length === 3 && m.every((x) => ["", "1"].includes(x.zoom)), JSON.stringify(m.map((x) => x.zoom)));
    check(`${name}: 行が伸びない（表の高さ＝Excel の行の高さの合計）`, m.every((x) => x.stretched === 0 && Math.abs(x.height - x.spec) < 3), JSON.stringify(m.map((x) => [x.stretched, Math.round(x.height), Math.round(x.spec)])));
    check(`${name}: 様式の図は Excel のアンカーの行（45行目）の高さに出る（ずれ 1行未満）`, m.every((x) => x.figTop != null && Math.abs(x.row45 - x.spec45) < 3 && x.figTop >= x.row45 - 2 && x.figTop - x.row45 < 20), JSON.stringify(m.map((x) => [Math.round(x.figTop), Math.round(x.row45)])));
    check(`${name}: 頁の高さ÷幅が 0.632 以下（Safari が幅いっぱいに合わせても1ページ）`, m.every((x) => x.ratio <= 0.632), JSON.stringify(m.map((x) => x.ratio.toFixed(3))));
    check(`${name}: 職長サインは欄の箱の中`, m[0].signs.length === 1 && m[0].signs.every(Boolean), JSON.stringify(m[0].signs));
    const clipped = await p.evaluate(() => window.__xlsxCellsClipped);
    check(`${name}: 箱に収まらない文字が無い（業者14社・長い文の日を含む）`, clipped === 0, `${clipped}`);
    check(`${name}: iPad の Safari のまね（文字だけ 1/zoom 倍）でも、文字が罫線をまたがない`, (await p.evaluate(CROSS_IPAD)) === 0);
    await b.close();
  }
  const pp = await ctx.newPage(); await pp.setViewportSize({ width: 1600, height: 1200 });
  await pp.setContent(html); await pp.waitForTimeout(600); await pp.emulateMedia({ media: "print" });
  const css = await pp.pdf({ printBackground: true, preferCSSPageSize: true });
  await pp.setContent(html.replace(/(@page\s*\{\s*size:[^;]+;)\s*margin:[^;]+;/, "$1")); await pp.waitForTimeout(600); await pp.emulateMedia({ media: "print" });
  const px = await pp.evaluate(() => Math.max(...[...document.querySelectorAll(".ledger-page")].map((w) => { const z = parseFloat(w.style.zoom || "1"); const t = w.querySelector("table").getBoundingClientRect().right; return Math.max(t, w.style.width ? parseFloat(w.style.width) * z + w.getBoundingClientRect().left : 0); })));
  const saf = await pp.pdf({ printBackground: true, ...SAFARI, scale: Math.min(2, (420 - 28.2) / ((px * 25.4) / 96)) });
  check("PDF: 様式の余白で A3横・3ページ（1日1ページ）", countPages(css) === 3 && /\/MediaBox\s*\[\s*0\s+0\s+119[01]/.test(css.toString("latin1")), `${countPages(css)}ページ`);
  check("PDF: Safari と同じ余白で幅いっぱいに合わせても3ページ（1日分が2ページに分かれない）", countPages(saf) === 3, `${countPages(saf)}ページ`);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
