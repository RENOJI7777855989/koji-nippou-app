// 会社様式（03-2）の印刷画面（「印刷画面を開く」・PDF出力・まとめて印刷）が、iPad の Safari の余白でも A3横・1ページに収まるか（2026-10-18）
//   iOS の Safari（iOS 27・A3横で「PDFに保存」した実物）は @page の用紙の大きさは守るが、余白は使わず、自分の余白（左右約14.1mm・上約16.5mm）と
//   下のフッター（アドレス・日時）の分を取り（1ページに使える高さ約259mm）、表を約1.4%大きく描いた。修正前は表の下の2〜3行が2ページ目に出ていた。
//   さらに Safari は、印刷する内容を余白の内側の幅（約391.8mm）いっぱいに合わせて縮める（2枚目の実物の PDF で確認: 表を縮めても幅いっぱいに戻り、
//   2ページのままだった）。Chromium の PDF 出力で、印刷用HTMLの @page の余白を外し（Safari と同じく使わない）、
//   ①その余白・拡大（1.4%）、②その余白で、内容の幅（紙面の右端）を余白の内側の幅いっぱいにする倍率、で PDF にしてページ数を数える。
//   Safari そのものの印刷ではない（iPad 実機の印刷は未確認）。
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const SAFARI = { preferCSSPageSize: false, width: "420mm", height: "297mm", margin: { top: "16.5mm", bottom: "21.5mm", left: "14.1mm", right: "14.1mm" }, scale: 1.014 };
const stripMargin = (html) => html.replace(/(@page\s*\{\s*size:[^;]+;)\s*margin:[^;]+;/, "$1");
const countPages = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-safari-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const built = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "Safariの余白の試験", startDate: "2026-09-01" });
    const long = (s, n) => Array.from({ length: n }, (_, i) => `${s}${i + 1}`).join("・");
    const normal = stampNew({ siteId: site.id, date: "2026-09-10", dayStatus: "work", weather: "晴れ", companies: [{ companyId: "c1", companyName: "甲工業", occupation: "塗装", actualWorkerCount: "2", workContent: "外壁塗装" }] });
    const heavy = stampNew({ siteId: site.id, date: "2026-09-11", dayStatus: "work", weather: "晴れ", temperature: "20",
      companies: Array.from({ length: 14 }, (_, i) => ({ companyId: "c" + i, companyName: `協力会社${i + 1}`, occupation: "塗装", actualWorkerCount: "3", workContent: long("作業内容", 6), safetyNotes: long("注意", 3) })),
      focusInstructions: long("重点指示", 8), workCoordination: long("連絡調整", 8) });
    await dbPut("reports", normal); await dbPut("reports", heavy);
    const cv = document.createElement("canvas"); cv.width = 200; cv.height = 60; cv.getContext("2d").fillRect(10, 10, 180, 40);
    await dbPut("signatures", stampNew({ reportId: heavy.id, companyId: "c0", role: "foreman", roleLabel: "職長", imageBlob: await new Promise((r) => cv.toBlob(r, "image/png")), signedAt: new Date().toISOString() }));
    const rp = await import("/js/reportPrint.js");
    return { normal: (await rp.buildReportPrintHtml(normal.id)).html, heavy: (await rp.buildReportPrintHtml(heavy.id)).html, bulk: (await rp.buildReportsPrintHtml([normal.id, heavy.id], "まとめて")).html };
  });
  const pdfOf = async (html, opt) => { const p = await ctx.newPage(); await p.setViewportSize({ width: 1600, height: 1200 }); await p.setContent(html); await p.waitForTimeout(500); await p.emulateMedia({ media: "print" });
    if (opt === "fitWidth") {
      // 内容の幅: 紙面（.xlsx-sheet-wrap）の右端（幅の指定があればそれ、無ければ表の右端）
      const contentPx = await p.evaluate(() => Math.max(...[...document.querySelectorAll(".xlsx-sheet-wrap")].map((w) => { const z = parseFloat(w.style.zoom || "1"); const t = w.querySelector("table.xlsx-sheet").getBoundingClientRect().right; return Math.max(t, w.style.width ? parseFloat(w.style.width) * z + w.getBoundingClientRect().left : 0); })));
      opt = { ...SAFARI, scale: Math.min(2, (420 - 14.1 * 2) / ((contentPx * 25.4) / 96)) };
    }
    const pdf = await p.pdf({ printBackground: true, ...opt }); const zoom = await p.evaluate(() => [...document.querySelectorAll(".xlsx-sheet-wrap")].map((w) => +parseFloat(w.style.zoom || "1").toFixed(3))); await p.close(); return { pages: countPages(pdf), zoom }; };
  for (const [label, html, expected] of [["日報1件（普通の日）", built.normal, 1], ["日報1件（業者14社・長い作業内容・サイン）", built.heavy, 1], ["まとめて印刷（2件）", built.bulk, 2]]) {
    const css = await pdfOf(html, { preferCSSPageSize: true });
    const saf = await pdfOf(stripMargin(html), SAFARI);
    check(`${label}: 様式の @page の余白で印刷すると ${expected}ページ（日報1件＝1ページ）`, css.pages === expected, `${css.pages}ページ`);
    check(`${label}: iPad の Safari と同じ余白（左右14.1・上16.5・下21.5mm）・拡大（1.4%）でも ${expected}ページ（表の下が2ページ目に出ない）`, saf.pages === expected, `${saf.pages}ページ`);
    const fit = await pdfOf(stripMargin(html), "fitWidth");
    check(`${label}: iPad の Safari と同じ余白で、内容を幅いっぱいに合わせても ${expected}ページ（表を縮めても幅いっぱいに戻される場合）`, fit.pages === expected, `${fit.pages}ページ`);
    check(`${label}: 縮小の倍率が極端に小さくない（0.8以上）`, saf.zoom.length === expected && saf.zoom.every((z) => z >= 0.8 && z <= 1), JSON.stringify(saf.zoom));
  }
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
