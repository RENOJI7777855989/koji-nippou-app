// 会社様式（03-2）の印刷用HTML・PDFの余白と文字のはみ出し、所長欄の電子印を確かめる（2026-10-24。架空データ・隔離したプロファイル）
//   ・iPad の Safari の印刷では CSS の zoom が文字に効かず、文字だけが 1/zoom 倍（約1.21倍）に描かれて罫線・隣の欄にはみ出していた。
//     印刷用HTMLを最初から縮めた大きさで作り、zoom を使わない（zoom が 1 のまま）ことを確かめる
//   ・表の右に足していた空白を列の幅に配り、左右の余白がほぼ同じになること（Safari と同じ余白・幅いっぱいに合わせる印刷、様式の余白の印刷）
//   ・A3横・日報1件＝1ページ（まとめて2件＝2ページ）、文字が罫線をまたがない（Chromium・WebKit）、空欄の日報も崩れない
//   ・所長印: 日報画面で押印・位置の変更・取り消し、保存・開き直し、所長欄からはみ出さない、印刷用HTML・PDF・1ページのPDFに出る、
//     増えない、職長サイン・Excel出力に影響しない
//   iPad の Safari そのものの印刷・プリンターでの印刷は自動テストでは確認できない
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
const stripMargin = (html) => html.replace(/(@page\s*\{\s*size:[^;]+;)\s*margin:[^;]+;/, "$1");
const countPages = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
const SEAL_NAME = "山田"; // 架空の名前

/** 印刷用HTMLの紙面を調べる: zoom・文字が罫線をまたぐ箇所・縮めた文字・所長欄と印・職長サインの数 */
const GEOMETRY = () => {
  const segV = [], segH = [];
  for (const td of document.querySelectorAll("table.xlsx-sheet td")) {
    const cs = getComputedStyle(td), rc = td.getBoundingClientRect();
    if (parseFloat(cs.borderRightWidth) > 0 && cs.borderRightStyle !== "none") segV.push([rc.right, rc.top, rc.bottom]);
    if (parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== "none") segV.push([rc.left, rc.top, rc.bottom]);
    if (parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== "none") segH.push([rc.bottom, rc.left, rc.right]);
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") segH.push([rc.top, rc.left, rc.right]);
  }
  const cross = []; let shrunk = 0;
  for (const xc of document.querySelectorAll("table.xlsx-sheet .xc")) {
    if (xc.style.fontSize) shrunk++;
    const range = document.createRange(); range.selectNodeContents(xc.firstElementChild);
    for (const t of range.getClientRects()) {
      if (t.width < 1) continue;
      const v = segV.some(([x, y1, y2]) => x > t.left + 2 && x < t.right - 2 && Math.min(y2, t.bottom) - Math.max(y1, t.top) > 3);
      const h = segH.some(([y, x1, x2]) => y > t.top + 3 && y < t.bottom - 3 && Math.min(x2, t.right) - Math.max(x1, t.left) > 3);
      if (v || h) { cross.push(xc.textContent.slice(0, 12)); break; }
    }
  }
  const sheets = [...document.querySelectorAll(".xlsx-sheet-wrap")].map((w) => {
    const label = [...w.querySelectorAll("td")].find((td) => td.textContent.replace(/[\s　]/g, "") === "所長");
    const lr = label?.getBoundingClientRect();
    const box = lr && [...w.querySelectorAll("td")].find((td) => { const r = td.getBoundingClientRect(); return Math.abs(r.top - lr.bottom) < 2 && Math.abs(r.left - lr.left) < 2; });
    // 所長欄: 見出しの真下のセルから、罫線で区切られていない空のセルが続く限り下へ（アプリの signatureBoxOf と同じ決まり）
    let br = box?.getBoundingClientRect();
    if (br) {
      const tds = [...w.querySelectorAll("td")];
      for (let cur = box; ;) {
        const r = cur.getBoundingClientRect();
        const next = tds.find((td) => { const q = td.getBoundingClientRect(); return Math.abs(q.top - r.bottom) < 2 && Math.abs(q.left - r.left) < 2 && Math.abs(q.width - r.width) < 2; });
        if (!next || next.textContent.trim() || parseFloat(getComputedStyle(cur).borderBottomWidth) > 0 || parseFloat(getComputedStyle(next).borderTopWidth) > 0) break;
        const q = next.getBoundingClientRect(); br = { left: br.left, right: br.right, top: br.top, bottom: q.bottom, width: br.width, height: q.bottom - br.top }; cur = next;
      }
    }
    const seals = [...w.querySelectorAll(".xlsx-overlay-seal")].map((i) => i.getBoundingClientRect());
    const inside = seals.every((s) => br && s.left >= br.left - 0.5 && s.right <= br.right + 0.5 && s.top >= br.top - 0.5 && s.bottom <= br.bottom + 0.5);
    const t = w.querySelector("table.xlsx-sheet").getBoundingClientRect();
    return { zoom: w.style.zoom || "", seals: seals.length, sealInside: inside, sealCenterX: seals[0] ? (seals[0].left + seals[0].width / 2 - br.left) / br.width : null, sealSize: seals[0] ? seals[0].width / Math.min(br.width, br.height) : null, signs: w.querySelectorAll(".xlsx-overlay-sign").length, ratio: t.height / t.width };
  });
  return { cross, shrunk, clipped: window.__xlsxCellsClipped, sheets };
};

/** PDF（バイト列）を pdf.js で画像にし、印字の左右上下の余白（mm）と赤い画素の数を返す */
async function pdfInk(page, pdf) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: u, cMapUrl: "/js/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/js/vendor/pdfjs/standard_fonts/" }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n); const vp = pg.getViewport({ scale: 1.5 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, red = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++; if (d[i] + d[i + 1] + d[i + 2] < 600) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      const mm = (pg.view[2] * 25.4 / 72) / c.width;
      out.push({ wMm: Math.round(pg.view[2] * 25.4 / 72), hMm: Math.round(pg.view[3] * 25.4 / 72), left: x0 * mm, right: (c.width - 1 - x1) * mm, top: y0 * mm, bottom: (c.height - 1 - y1) * mm, inkH: (y1 - y0) * mm, red });
    }
    return out;
  }, pdf.toString("base64"));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-seal-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const site = await createSite({ name: "余白と所長印の試験", startDate: "2026-09-01" });
    const long = (s, n) => Array.from({ length: n }, (_, i) => `${s}${i + 1}`).join("・");
    const companies = [["甲警備保障", "警備"], ["乙興業", "足場工事"], ["丙工業", "洗浄"]].map(([n, o], i) => ({ companyId: "c" + i, companyName: n, occupation: o, plannedWorkerCount: "2", actualWorkerCount: "2", workContent: "外壁の作業", safetyNotes: "墜落注意" }));
    const normal = stampNew({ siteId: site.id, date: "2026-09-10", dayStatus: "work", weather: "晴れ", temperature: "20", companies, deliveries: [{ id: "d1", direction: "in", time: "09:00", item: "足場部材一式", vendor: "乙興業", status: "plan" }] });
    const heavy = stampNew({ siteId: site.id, date: "2026-09-11", dayStatus: "work", weather: "晴れ", temperature: "20",
      companies: Array.from({ length: 14 }, (_, i) => ({ companyId: "h" + i, companyName: `協力会社${i + 1}株式会社`, occupation: "型枠解体工事", actualWorkerCount: "3", workContent: long("作業内容", 6), safetyNotes: long("注意", 3) })),
      focusInstructions: long("重点指示", 8), workCoordination: long("連絡調整", 8), remarks: long("連絡事項", 6) });
    const empty = stampNew({ siteId: site.id, date: "2026-09-12", dayStatus: "work", weather: "", companies: [] });
    for (const r of [normal, heavy, empty]) await dbPut("reports", r);
    const sigIds = [];
    for (const c of companies) {
      const cv = document.createElement("canvas"); cv.width = 300; cv.height = 80; const g = cv.getContext("2d"); g.lineWidth = 3; g.beginPath(); g.moveTo(20, 60); g.lineTo(150, 15); g.lineTo(280, 55); g.stroke();
      const s = stampNew({ reportId: normal.id, companyId: c.companyId, role: "foreman", roleLabel: "職長", imageBlob: await new Promise((r) => cv.toBlob(r, "image/png")), signedAt: new Date().toISOString() });
      await dbPut("signatures", s); sigIds.push(s.id);
    }
    return { site: site.id, normal: normal.id, heavy: heavy.id, empty: empty.id, sigIds };
  });

  const htmlOf = (id) => page.evaluate(async (id) => (await (await import("/js/reportPrint.js")).buildReportPrintHtml(id)).html, id);
  const bulkOf = (list) => page.evaluate(async (list) => (await (await import("/js/reportPrint.js")).buildReportsPrintHtml(list, "まとめて")).html, list);
  const geometryIn = async (bt, html) => {
    const b = bt === "chromium" ? null : await webkit.launch();
    const p = b ? await b.newPage({ viewport: { width: 1600, height: 1200 } }) : await ctx.newPage();
    if (!b) await p.setViewportSize({ width: 1600, height: 1200 });
    await p.setContent(html); await p.waitForTimeout(600); await p.emulateMedia({ media: "print" }); await p.waitForTimeout(150);
    const g = await p.evaluate(GEOMETRY); await p.close(); if (b) await b.close(); return g;
  };
  const pdfOf = async (html, mode) => {
    const p = await ctx.newPage(); await p.setViewportSize({ width: 1600, height: 1200 }); await p.setContent(mode === "css" ? html : stripMargin(html)); await p.waitForTimeout(600); await p.emulateMedia({ media: "print" });
    let opt = { preferCSSPageSize: true };
    if (mode === "safari") {
      // Safari と同じ: 余白を使わず、内容（紙面の右端）を余白の内側の幅いっぱいに合わせる
      const px = await p.evaluate(() => Math.max(...[...document.querySelectorAll(".xlsx-sheet-wrap")].map((w) => { const z = parseFloat(w.style.zoom || "1"); const t = w.querySelector("table.xlsx-sheet").getBoundingClientRect().right; return Math.max(t, w.style.width ? parseFloat(w.style.width) * z + w.getBoundingClientRect().left : 0); })));
      opt = { ...SAFARI, scale: Math.min(2, (420 - 28.2) / ((px * 25.4) / 96)) };
    }
    const pdf = await p.pdf({ printBackground: true, ...opt }); await p.close();
    return { pages: countPages(pdf), ink: await pdfInk(page, pdf) };
  };

  // ===== ① 余白・1ページ・文字のはみ出し =====
  const html0 = { normal: await htmlOf(ids.normal), heavy: await htmlOf(ids.heavy), empty: await htmlOf(ids.empty) };
  check("印刷用HTMLの印刷レイアウトの版が v71", /name="print-layout-version" content="v71"/.test(html0.normal));
  check("@page の左右の余白が同じ（様式の左右の合計を半分ずつ）", /@page \{ size: 420mm 297mm; margin: [\d.]+mm 15mm [\d.]+mm 15mm; \}/.test(html0.normal), (html0.normal.match(/@page[^}]*\}/) || [""])[0]);
  check("印刷用HTMLに viewport と text-size-adjust（iPad の文字の自動拡大を止める）", /name="viewport"/.test(html0.normal) && /text-size-adjust: 100%/.test(html0.normal));
  for (const [label, html] of [["普通の日", html0.normal], ["業者14社・長い文", html0.heavy], ["空欄の日報", html0.empty]]) {
    for (const bt of ["chromium", "webkit"]) {
      const g = await geometryIn(bt, html);
      check(`${label}（${bt}）: CSS の zoom で縮めていない（最初から縮めた大きさで作る。iPad で文字だけ大きくなる原因）`, g.sheets.length === 1 && ["", "1"].includes(g.sheets[0].zoom), JSON.stringify(g.sheets.map((s) => s.zoom)));
      check(`${label}（${bt}）: 文字が罫線をまたがない`, g.cross.length === 0, g.cross.slice(0, 5).join(" / "));
      check(`${label}（${bt}）: 箱に収まらない文字が無い`, g.clipped === 0, `${g.clipped}`);
      if (label !== "業者14社・長い文") check(`${label}（${bt}）: 文字を縮めたセルが無い（一律に小さくしていない）`, g.shrunk === 0, `${g.shrunk}`);
      check(`${label}（${bt}）: 紙面の高さ÷幅が 0.63 以下（Safari が幅いっぱいに合わせても1ページ）`, g.sheets[0].ratio <= 0.632, g.sheets[0].ratio.toFixed(4));
    }
    const css = await pdfOf(html, "css"), saf = await pdfOf(html, "safari");
    const c = css.ink[0], s = saf.ink[0];
    check(`${label}: 様式の余白で A3横・1ページ`, css.pages === 1 && c.wMm === 420 && c.hMm === 297, `${css.pages}ページ ${c.wMm}×${c.hMm}`);
    check(`${label}: Safari と同じ余白・幅いっぱいでも1ページ（表の下の罫線が2ページ目に出ない）`, saf.pages === 1, `${saf.pages}ページ`);
    check(`${label}: 左右の余白がほぼ同じ（Safari 相当: 左${s.left.toFixed(1)}・右${s.right.toFixed(1)}mm／様式の余白: 左${c.left.toFixed(1)}・右${c.right.toFixed(1)}mm）`, Math.abs(s.left - s.right) <= 3 && Math.abs(c.left - c.right) <= 3 && s.right < 20 && c.right < 20);
    check(`${label}: 表の高さは以前と同じ（Safari 相当で 240mm 以上＝文字を小さくしていない）`, s.inkH >= 240, `${s.inkH.toFixed(1)}mm`);
  }
  const bulk = await bulkOf([ids.normal, ids.heavy]);
  const bsaf = await pdfOf(bulk, "safari"), bcss = await pdfOf(bulk, "css");
  check("まとめて印刷（2件）: 2ページ（Safari 相当・様式の余白）", bsaf.pages === 2 && bcss.pages === 2, `${bsaf.pages}・${bcss.pages}`);
  const bg = await geometryIn("webkit", bulk);
  check("まとめて印刷（2件・WebKit）: zoom を使わず、文字が罫線をまたがない", bg.sheets.length === 2 && bg.sheets.every((s) => ["", "1"].includes(s.zoom)) && bg.cross.length === 0, bg.cross.join(" / "));

  // ===== ② 所長印（日報画面） =====
  const sigBefore = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGetAll("signatures")).filter((s) => s.reportId === id).map((s) => [s.id, s.updatedAt, s.isDeleted || false]).sort()), ids.normal);
  const excelSheets = () => page.evaluate(async (id) => {
    const { getReport } = await import("/js/reports.js"); const { getSite } = await import("/js/sites.js");
    const rp = await import("/js/reportPrint.js"); const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const r = await getReport(id); const site = await getSite(r.siteId); const t = await rp.resolveCompanyTemplateForSite(site);
    const out = await generateReportOutput({ reportId: id, format: "excel", templateId: t?.templateId || null });
    const { loadZip, readZipEntryText } = await import("/js/zipUtil.js"); const zip = loadZip(await out.blob.arrayBuffer());
    const names = [...zip.entries.keys()].filter((n) => /^xl\/(worksheets\/sheet\d+|drawings\/drawing\d+)\.xml$/.test(n)).sort();
    let sheet = ""; for (const n of names) sheet += `[${n}]` + (await readZipEntryText(zip, n));
    return { sheetLen: sheet.length, sheet, names: names.length };
  }, ids.normal);
  const excel0 = await excelSheets();

  const openForm = async () => { await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForTimeout(300); await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.normal}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400); };
  const sealDb = () => page.evaluate(async (id) => (await (await import("/js/reports.js")).getReport(id)).directorSeal ?? null, ids.normal);
  const save = async () => { const before = await page.evaluate(async (id) => (await (await import("/js/reports.js")).getReport(id)).updatedAt, ids.normal); await page.click("#reportSaveBtn"); await waitForAsync(page, async ([id, b]) => (await (await import("/js/reports.js")).getReport(id)).updatedAt !== b, [ids.normal, before]); await page.waitForTimeout(300); };

  await openForm();
  check("日報画面に所長印の欄があり、最初は未押印（印の画像なし）", await page.evaluate(() => !!document.getElementById("directorSealSection") && document.getElementById("directorSealImg").hidden && /未押印/.test(document.getElementById("directorSealStatus").textContent)));
  check("押印前は［取り消し］・位置のボタンが押せない", await page.evaluate(() => document.getElementById("directorSealClearBtn").disabled && [...document.querySelectorAll("[data-seal-move]")].every((b) => b.disabled)));
  await page.fill("#directorSealName", ` ${SEAL_NAME} `);
  await page.click("#directorSealStampBtn"); await page.click("#directorSealStampBtn"); // 2回押しても印は1つ
  const prev1 = await page.evaluate(() => { const b = document.getElementById("directorSealBox").getBoundingClientRect(), i = document.getElementById("directorSealImg").getBoundingClientRect(); return { shown: !document.getElementById("directorSealImg").hidden, inside: i.left >= b.left - 0.5 && i.right <= b.right + 0.5 && i.top >= b.top - 0.5 && i.bottom <= b.bottom + 0.5, status: document.getElementById("directorSealStatus").textContent, imgs: document.querySelectorAll("#directorSealBox img").length }; });
  check("［押印する］で見本の所長欄に印が出て、欄からはみ出さない（2回押しても1つ）", prev1.shown && prev1.inside && prev1.imgs === 1 && prev1.status.includes(`押印済み：${SEAL_NAME}`) && prev1.status.includes("まだ保存していません"), JSON.stringify(prev1));
  check("保存する前は日報に記録されない", (await sealDb()) === null);
  await save();
  const s1 = await sealDb();
  check("保存すると日報に1つの印として記録される（名前は空白を除く・位置は中央）", s1 && s1.name === SEAL_NAME && s1.offsetX === 0 && s1.offsetY === 0 && typeof s1.stampedAt === "string" && !Array.isArray(s1), JSON.stringify(s1));
  await openForm();
  const re1 = await page.evaluate(() => ({ shown: !document.getElementById("directorSealImg").hidden, name: document.getElementById("directorSealName").value, status: document.getElementById("directorSealStatus").textContent }));
  check("開き直しても押印のまま（名前・印・保存済みの表示）", re1.shown && re1.name === SEAL_NAME && re1.status.startsWith(`押印済み：${SEAL_NAME}`) && !re1.status.includes("まだ保存"), JSON.stringify(re1));

  // 印刷用HTML・PDF・1ページのPDF
  const htmlS = await htmlOf(ids.normal);
  for (const bt of ["chromium", "webkit"]) {
    const g = await geometryIn(bt, htmlS);
    const sh = g.sheets[0];
    check(`印刷用HTML（${bt}）: 所長欄に印が1つ、欄からはみ出さず、中央・欄の短い辺の約78%`, sh.seals === 1 && sh.sealInside && Math.abs(sh.sealCenterX - 0.5) < 0.02 && Math.abs(sh.sealSize - 0.78) < 0.03, JSON.stringify(sh));
    check(`印刷用HTML（${bt}）: 職長サインは3つのまま・文字が罫線をまたがない`, sh.signs === 3 && g.cross.length === 0, `${sh.signs} ${g.cross.join("/")}`);
  }
  check("印刷用HTMLを作り直しても印は増えない", ((await htmlOf(ids.normal)).match(/xlsx-overlay-seal/g) || []).length === 1 && (htmlS.match(/xlsx-overlay-seal/g) || []).length === 1);
  const pS = await pdfOf(htmlS, "safari"), pC = await pdfOf(htmlS, "css");
  check("PDF（Safari 相当・様式の余白）に赤い印が出る・1ページ", pS.pages === 1 && pC.pages === 1 && pS.ink[0].red > 200 && pC.ink[0].red > 200, `赤 ${pS.ink[0].red}・${pC.ink[0].red}`);
  const onePage = await page.evaluate(async (html) => {
    const { renderCompanySheetsToJpegs } = await import("/js/ui/company-pdf.js");
    const pages = await renderCompanySheetsToJpegs(html);
    const bm = await createImageBitmap(new Blob([pages[0].jpeg], { type: "image/jpeg" })); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
    return { pages: pages.length, red };
  }, htmlS);
  check("1ページのPDF（A3）の画像にも赤い印が出る", onePage.pages === 1 && onePage.red > 200, JSON.stringify(onePage));
  const bulkS = await bulkOf([ids.normal, ids.heavy]);
  check("まとめて印刷: 押印した日報だけに印が1つ", (bulkS.match(/class="xlsx-overlay-img xlsx-overlay-seal"/g) || []).length === 1);

  // 位置の変更（右へ2回＝50、下へ5回＝上限100）→ 保存・開き直し → 印刷でも欄の中
  await page.click('[data-seal-move="1,0"]'); await page.click('[data-seal-move="1,0"]');
  for (let i = 0; i < 5; i++) await page.click('[data-seal-move="0,1"]');
  await save();
  const s2 = await sealDb();
  check("位置の変更が保存される（右へ50・下へ100が上限）", s2.offsetX === 50 && s2.offsetY === 100 && s2.name === SEAL_NAME, JSON.stringify(s2));
  const g2 = (await geometryIn("webkit", await htmlOf(ids.normal))).sheets[0];
  check("動かした印も所長欄からはみ出さず、中央より右", g2.seals === 1 && g2.sealInside && g2.sealCenterX > 0.5, JSON.stringify(g2));
  await openForm();
  check("開き直すと動かした位置のまま", await page.evaluate(() => { const b = document.getElementById("directorSealBox").getBoundingClientRect(), i = document.getElementById("directorSealImg").getBoundingClientRect(); return i.left + i.width / 2 > b.left + b.width / 2 + 1 && i.bottom <= b.bottom + 0.5; }));

  // 職長サイン・Excel出力・ほかの保存処理への影響
  const sigAfter = await page.evaluate(async (id) => JSON.stringify((await (await import("/js/db.js")).dbGetAll("signatures")).filter((s) => s.reportId === id).map((s) => [s.id, s.updatedAt, s.isDeleted || false]).sort()), ids.normal);
  check("職長サインの記録は変わらない（押印・保存の前後で同じ）", sigAfter === sigBefore);
  const excel1 = await excelSheets();
  check("Excel出力のシートは押印の前後で同じ（Excelには印を書かない）", excel1.sheet === excel0.sheet && excel1.sheetLen > 1000, `${excel0.sheetLen}→${excel1.sheetLen}`);
  await page.evaluate(async (id) => (await import("/js/reports.js")).updateReport(id, { remarks: "朝礼入力などの部分的な保存" }), ids.normal);
  check("ほかの画面の部分的な保存（directorSeal を含まない）でも印は残る", (await sealDb())?.offsetX === 50);
  const norm = await page.evaluate(async () => { const m = await import("/js/report-output/directorSeal.js"); return [m.normalizeDirectorSeal({ name: "  ", offsetX: 5 }), m.normalizeDirectorSeal({ name: "あいうえお", offsetX: 999, offsetY: -999, stampedAt: "x" })]; });
  check("名前が空なら押印なし・名前は4文字まで・位置は −100〜100", norm[0] === null && norm[1].name === "あいうえ" && norm[1].offsetX === 100 && norm[1].offsetY === -100, JSON.stringify(norm));

  // 取り消し
  await openForm();
  await page.click("#directorSealClearBtn");
  check("［押印を取り消す］で見本から印が消える（保存前は記録のまま）", await page.evaluate(() => document.getElementById("directorSealImg").hidden) && (await sealDb()) !== null);
  await save();
  check("保存すると押印なし（null）として記録される", (await sealDb()) === null);
  const htmlC = await htmlOf(ids.normal);
  const pC2 = await pdfOf(htmlC, "css");
  check("取り消した後の印刷用HTML・PDFに印が無い（職長サインは3つのまま）", !/xlsx-overlay-seal/.test(htmlC) && pC2.ink[0].red < 20 && (htmlC.match(/xlsx-overlay-sign/g) || []).length === 3, `赤 ${pC2.ink[0].red}`);
  check("DB の版は 10 のまま", (await page.evaluate(async () => (await import("/js/db.js")).DB_VERSION)) === 10);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
