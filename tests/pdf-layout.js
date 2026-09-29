// 日誌 → PDF（会社様式 03-2 の印刷用HTML）のレイアウト崩れの検証（実ブラウザ・実IndexedDB）
// 量の違う日誌で印刷用HTMLを作り、次を確かめる:
//   ・A3横・1日1ページ（Chromium は実際にPDFを作って確認。WebKit は Playwright でPDFを作れないため画面上の配置で確認）
//   ・表の行がExcelの行の高さから伸びない（伸びると職長サイン・様式の図の位置がずれる）
//   ・別々のセルの文字が重ならない・表の外にはみ出さない・文字を最小まで縮めても収まらないセルが無い（省略しない）
//   ・職長サインが業者の行の位置に入る・見出し（気温など）が縮められていない
//   ・まとめて印刷（2日分）が1日1ページ
//   ・会社様式が無いときのアプリ独自レイアウト（写真あり）も1ページ
// 03-2 の様式ファイル（テンプレート）そのもの・Excel出力は変えていないことも確認する。
// 実行: 静的サーバー（http://localhost:8934）を起動した状態で node tests/pdf-layout.js（鍵ファイルが必要）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const OUT = process.env.TEST_OUT_DIR || path.join(os.tmpdir(), "pdf-layout-test");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

const long = (s, n) => Array.from({ length: n }, (_, i) => `${s}${i + 1}`).join("、");
const VARIANTS = {
  通常の日: { companies: Array.from({ length: 5 }, (_, i) => ({ companyName: `協力会社${i + 1}`, occupation: "型枠工", plannedWorkerCount: "5", actualWorkerCount: "4", workContent: "2階型枠建込・清掃", safetyNotes: "開口部養生確認" })) },
  空欄が多い日: { companies: [{ companyName: "A工業", actualWorkerCount: "2" }] },
  長文: { companies: Array.from({ length: 5 }, (_, i) => ({ companyName: `株式会社サンプル建設工業協力会社${i + 1}`, occupation: "型枠大工・鉄筋工", actualWorkerCount: "4", workContent: long("2階東側スラブ型枠建込および配筋検査前の清掃と墨出し作業", 3), safetyNotes: long("開口部の手すり・養生ネット確認、重機作業半径内立入禁止の徹底", 3) })) },
  業者多数: { companies: Array.from({ length: 14 }, (_, i) => ({ companyName: `協力会社${i + 1}`, occupation: "土工", actualWorkerCount: "3", workContent: "掘削・残土搬出", safetyNotes: "重機誘導" })) },
  作業内容が多い: { companies: Array.from({ length: 8 }, (_, i) => ({ companyName: `協力会社${i + 1}`, actualWorkerCount: "5", workContent: "作業内容の1行目\n作業内容の2行目\n作業内容の3行目\n作業内容の4行目", safetyNotes: "注意事項1\n注意事項2\n注意事項3" })) },
  搬入搬出が多い: { companies: [{ companyName: "A工業", actualWorkerCount: "2", workContent: "搬入受入" }], deliveries: Array.from({ length: 12 }, (_, i) => ({ id: "d" + i, direction: i % 2 ? "out" : "in", time: `${String(8 + i).padStart(2, "0")}:00`, item: "資材" + i, status: "plan" })) },
  署名あり: { companies: Array.from({ length: 6 }, (_, i) => ({ companyId: "c" + i, companyName: `協力会社${i + 1}`, actualWorkerCount: "3", workContent: long("長い作業内容", 6) })), signatures: 6 }
};

// 印刷用HTMLの中の配置を測る（ページ内で実行）
function measureInPage() {
  const wrap = document.querySelector(".xlsx-sheet-wrap");
  wrap.style.zoom = "1";
  dispatchEvent(new Event("beforeprint")); // 印刷直前と同じ処理（セルの収め直し・全体の縮小）
  const zoom = parseFloat(wrap.style.zoom) || 1;
  const t = document.querySelector("table.xlsx-sheet");
  const trs = [...t.rows];
  let declared = 0, grown = 0;
  for (const tr of trs) { const d = parseFloat(tr.style.height) || 0; declared += d; if (tr.getBoundingClientRect().height / zoom > d + 1.5) grown++; }
  const tb = t.getBoundingClientRect();
  const clip = (r, c) => { if (!c.classList.contains("xc-fit")) return r; const b = c.getBoundingClientRect(); return { left: Math.max(r.left, b.left), right: Math.min(r.right, b.right), top: Math.max(r.top, b.top), bottom: Math.min(r.bottom, b.bottom) }; };
  const boxes = [...document.querySelectorAll(".xc > span")].flatMap((sp) => [...sp.getClientRects()].map((r) => ({ r: clip(r, sp.parentElement), id: sp })));
  let overlap = 0, outside = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i].r;
    if (a.right > tb.right + 1 || a.bottom > tb.bottom + 1 || a.left < tb.left - 1) outside++;
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].id === boxes[j].id) continue;
      const b = boxes[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap++;
    }
  }
  // 職長サイン（表の中の「サイン」列の行に重ねた画像）: 画像の上端が、どれかの表の行の上端と一致するか
  const rowTops = trs.map((tr) => tr.getBoundingClientRect().top);
  const sigs = [...document.querySelectorAll(".xlsx-overlay-img")].filter((img) => img.src.startsWith("data:image/png") && img.getBoundingClientRect().width < 200);
  const sigMisaligned = sigs.filter((img) => !rowTops.some((top) => Math.abs(top - img.getBoundingClientRect().top) < 1.5)).length;
  const temp = [...document.querySelectorAll(".xc")].find((c) => c.textContent.startsWith("気温"));
  return { zoom, declared: Math.round(declared), actual: Math.round(t.getBoundingClientRect().height / zoom), grown, overlap, outside, clipped: window.__xlsxCellsClipped, sigs: sigs.length, sigMisaligned, tempShrunk: !!temp && temp.classList.contains("xc-fit") };
}

async function run(name, browserType, canPdf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-layout-"));
  const ctx = await browserType.launchPersistentContext(dir, { viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const N = (t) => `${name}: ${t}`;
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
  const siteId = await page.evaluate(async () => (await (await import("/js/sites.js")).createSite({ name: "PDFレイアウト確認現場", startDate: "2026-09-01" })).id);
  const templateSha = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).find((t) => t.bundledId).sourceFileSha256);

  const reportIds = [];
  for (const [label, v] of Object.entries(VARIANTS)) {
    const { id, html } = await page.evaluate(async ({ siteId, v, day }) => {
      const { dbPut } = await import("/js/db.js");
      const { stampNew } = await import("/js/utils.js");
      const r = stampNew({ siteId, date: `2026-09-${String(day).padStart(2, "0")}`, weather: "晴れ", temperature: "20", companies: v.companies.map((c, i) => ({ companyId: c.companyId || "x" + i, ...c })), deliveries: v.deliveries || [] });
      await dbPut("reports", r);
      for (let i = 0; i < (v.signatures || 0); i++) {
        const cv = document.createElement("canvas"); cv.width = 200; cv.height = 60;
        const g = cv.getContext("2d"); g.font = "30px sans-serif"; g.fillText("署名" + i, 10, 40);
        await dbPut("signatures", stampNew({ reportId: r.id, companyId: "c" + i, role: "foreman", roleLabel: "職長", imageBlob: await new Promise((res) => cv.toBlob(res, "image/png")), signedAt: new Date().toISOString() }));
      }
      return { id: r.id, html: (await (await import("/js/reportPrint.js")).buildReportPrintHtml(r.id)).html };
    }, { siteId, v, day: reportIds.length + 1 });
    reportIds.push(id);
    const p2 = await ctx.newPage();
    await p2.setContent(html); await p2.waitForTimeout(300);
    const m = await p2.evaluate(measureInPage);
    const size = /@page\s*\{\s*size:\s*([\d.]+)mm\s+([\d.]+)mm/.exec(html);
    let pdfInfo = "";
    let pagesOk = true;
    if (canPdf) {
      const pdf = await p2.pdf({ preferCSSPageSize: true });
      fs.writeFileSync(path.join(OUT, `${label}.pdf`), pdf);
      const txt = Buffer.from(pdf).toString("latin1");
      const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(txt);
      const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
      pagesOk = pages === 1 && box && Math.abs(Number(box[1]) - 1190.55) < 3 && Math.abs(Number(box[2]) - 841.89) < 3;
      pdfInfo = ` PDF ${pages}頁 ${box ? Math.round(box[1]) + "x" + Math.round(box[2]) : "?"}pt`;
    }
    await p2.close();
    const ok = size && Math.round(size[1]) === 420 && Math.round(size[2]) === 297 && pagesOk && m.grown === 0 && m.overlap === 0 && m.outside === 0 && m.clipped === 0 && !m.tempShrunk && (v.signatures ? m.sigs === v.signatures && m.sigMisaligned === 0 : true);
    check(N(`${label}: A3横・1ページ・行が伸びない・文字の重なり/はみ出し/収まらないセル無し${v.signatures ? "・職長サインが業者の行の位置" : ""}`), ok,
      `用紙${size ? size[1] + "×" + size[2] + "mm" : "?"}${pdfInfo} 縮小${m.zoom.toFixed(2)} 行の伸び${m.grown} 重なり${m.overlap} 表の外${m.outside} 収まらず${m.clipped}${v.signatures ? ` サイン${m.sigs}件(ずれ${m.sigMisaligned})` : ""}`);
  }

  // まとめて印刷（2日分）: 1日1ページ
  const bulk = await page.evaluate(async (ids) => (await (await import("/js/reportPrint.js")).buildReportsPrintHtml(ids, "まとめて")).html, reportIds.slice(0, 2));
  const pb = await ctx.newPage();
  await pb.setContent(bulk); await pb.waitForTimeout(300);
  const bulkMeasure = await pb.evaluate(() => { dispatchEvent(new Event("beforeprint")); return { sheets: document.querySelectorAll(".xlsx-sheet-wrap").length, clipped: window.__xlsxCellsClipped, pages: document.querySelectorAll(".bulk-report-page").length }; });
  let bulkPages = "（PDFは未作成）";
  let bulkOk = bulkMeasure.sheets === 2 && bulkMeasure.clipped === 0;
  if (canPdf) {
    const pdf = await pb.pdf({ preferCSSPageSize: true });
    const n = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    bulkPages = `PDF ${n}頁`;
    bulkOk = bulkOk && n === 2;
  }
  await pb.close();
  check(N("まとめて印刷（2日分）: 1日1ページ・収まらないセル無し"), bulkOk, `${bulkPages} シート${bulkMeasure.sheets}`);

  // 03-2 の様式ファイル（テンプレート）そのものは変わっていない・Excel出力は従来どおり
  const after = await page.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).find((t) => t.bundledId).sourceFileSha256);
  check(N("03-2 の様式ファイル（登録済みテンプレート）は変わっていない"), after === templateSha);

  // 会社様式が無いときのアプリ独自レイアウト（写真・署名あり、長文）も1ページ
  const own = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js");
    const { dbPut, dbGetAll } = await import("/js/db.js");
    const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "独自レイアウト確認", startDate: "2026-09-01" });
    const r = stampNew({ siteId: site.id, date: "2026-09-10", weather: "雨", remarks: "長い備考".repeat(40), companies: Array.from({ length: 6 }, (_, i) => ({ companyId: "o" + i, companyName: "協力会社" + i, actualWorkerCount: "2", workContent: "長い作業内容".repeat(15) })) });
    await dbPut("reports", r);
    const cv = document.createElement("canvas"); cv.width = 800; cv.height = 600; cv.getContext("2d").fillRect(0, 0, 400, 300);
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg"));
    for (let i = 0; i < 3; i++) await dbPut("photos", stampNew({ reportId: r.id, siteId: site.id, blob, mimeType: "image/jpeg", order: i, caption: "" }));
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    return (await generateReportOutput({ reportId: r.id, format: "pdf", pdfVariant: "original" })).html;
  });
  if (canPdf) {
    const po = await ctx.newPage();
    await po.setContent(own); await po.waitForTimeout(500);
    const pdf = await po.pdf({ preferCSSPageSize: true });
    const txt = Buffer.from(pdf).toString("latin1");
    const n = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(txt);
    await po.close();
    check(N("会社様式が無いときのアプリ独自レイアウト（写真3枚・長文）: 従来どおりA4縦で1ページ"), n === 1 && box && Math.abs(Number(box[1]) - 595.28) < 3, `${n}頁 ${box ? Math.round(box[1]) + "x" + Math.round(box[2]) : "?"}pt`);
  }
  check(N("ページエラーが無い"), errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await run("Chromium", chromium, true);
  await run("WebKit", webkit, false);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e.stack || e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
