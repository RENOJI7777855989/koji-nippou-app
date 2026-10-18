// 会社指定様式（03-2）の「1ページのPDFを作成（A3）」（2026-10-18）を確かめる（架空データ・隔離したプロファイル・iPadの画面の大きさ・倍率2）
//   iPad の印刷画面では表の下の部分が2ページ目に出ることがあったため、紙面を画像にして、様式の用紙（A3横）・余白の内側に
//   収めた PDF を作る。日報1件＝必ず1ページ、表の全体（下の端まで）と職長サインが入っていることを、Chromium・WebKit で確かめる。
//   iPad の共有メニュー・プリンターでの実際の印刷は自動テストでは確認できない（navigator.share に渡されたファイルを調べる）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const A3 = [Math.round((420 / 25.4) * 72), Math.round((297 / 25.4) * 72)]; // 1191 × 842 pt

/** 共有メニューの代わり: navigator.share に渡されたファイルを記録する */
const shareStub = () => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length && d.files.every((f) => f instanceof File);
  navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); window.__shared.push({ name: f.name, type: f.type, b64: btoa(s) }); };
};

/** 共有されたPDFを調べる: ページ数・大きさ、各ページの画像（JPEG）の大きさと、画像の中の位置の画素 */
async function inspectShared(page, index, probes) {
  return page.evaluate(async ([index, probes]) => {
    const f = window.__shared[index]; const bin = atob(f.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pdfjs = await import("/js/vendor/pdfjs/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdfjs/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: u.slice() }).promise;
    const sizes = []; for (let p = 1; p <= doc.numPages; p++) { const vp = (await doc.getPage(p)).getViewport({ scale: 1 }); sizes.push([Math.round(vp.width), Math.round(vp.height)]); }
    // PDF の中の JPEG（ページの順）を取り出して調べる
    const text = new TextDecoder("latin1").decode(u); const jpegs = [];
    const re = /\/Width (\d+) \/Height (\d+)[^>]*\/DCTDecode \/Length (\d+) >>\nstream\n/g; let m;
    while ((m = re.exec(text))) { const start = m.index + m[0].length; jpegs.push({ w: +m[1], h: +m[2], bytes: u.slice(start, start + +m[3]) }); }
    const pages = [];
    for (const j of jpegs) {
      const bm = await createImageBitmap(new Blob([j.bytes], { type: "image/jpeg" }));
      const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const dark = (x0, y0, x1, y1) => { let n = 0; for (let y = Math.max(0, Math.floor(y0)); y < Math.min(c.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(c.width, Math.ceil(x1)); x++) { const i = (y * c.width + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 300) n++; } return n; };
      const bottomInk = dark(0, c.height * 0.985, c.width, c.height); // 表の下の端（下の罫線）
      const sig = (probes || []).map((p) => dark(p.x * c.width, p.y * c.height, (p.x + p.w) * c.width, (p.y + p.h) * c.height));
      pages.push({ w: c.width, h: c.height, bottomInk, sig });
    }
    return { name: f.name, type: f.type, numPages: doc.numPages, sizes, pages };
  }, [index, probes]);
}

/** 印刷ダイアログの枠に表示された紙面: 表の大きさと、職長サインの画像の位置（表に対する割合） */
const sheetInfo = (page) => page.evaluate(() => {
  const doc = document.getElementById("reportPrintFrame").contentDocument;
  return [...doc.querySelectorAll(".xlsx-sheet-wrap")].map((w) => {
    w.style.zoom = "1"; const t = w.querySelector("table.xlsx-sheet").getBoundingClientRect();
    const sigs = [...w.querySelectorAll(".xlsx-overlay-sign")].map((i) => { const r = i.getBoundingClientRect(); const s = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight); const dw = i.naturalWidth * s, dh = i.naturalHeight * s; return { x: (r.left - t.left + (r.width - dw) / 2) / t.width, y: (r.top - t.top + (r.height - dh) / 2) / t.height, w: dw / t.width, h: dh / t.height }; });
    return { ratio: t.width / t.height, sigs };
  });
});

async function runBrowser(bt, bname, errors) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onepage-${bname}-`));
  const ctx = await bt.launchPersistentContext(dir, { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, acceptDownloads: true });
  await ctx.addInitScript(shareStub);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${bname}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const T = (t) => `${bname}: ${t}`;
  try {
    await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
    await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
    await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });
    // 架空データ: 情報の多い日報（業者14社・長い作業内容・職長サイン6件・重点指示・連絡調整）と、普通の日報
    const ids = await page.evaluate(async () => {
      const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
      const site = await createSite({ name: "1ページPDFの試験現場", startDate: "2026-09-01" });
      const long = (s, n) => Array.from({ length: n }, (_, i) => `${s}${i + 1}`).join("・");
      const heavy = stampNew({ siteId: site.id, date: "2026-09-10", dayStatus: "work", weather: "晴れ", temperature: "20", progressPercent: 40,
        companies: Array.from({ length: 14 }, (_, i) => ({ companyId: "c" + i, companyName: `協力会社${i + 1}`, occupation: ["塗装", "防水", "足場", "内装"][i % 4], actualWorkerCount: "3", workContent: long("作業内容", 6), safetyNotes: long("注意事項", 3) })),
        focusInstructions: long("重点指示", 8), workCoordination: long("連絡調整", 8), remarks: "連絡事項" });
      const normal = stampNew({ siteId: site.id, date: "2026-09-11", dayStatus: "work", weather: "曇り", companies: [{ companyId: "c0", companyName: "協力会社1", occupation: "塗装", actualWorkerCount: "2", workContent: "外壁塗装" }] });
      await dbPut("reports", heavy); await dbPut("reports", normal);
      for (let i = 0; i < 6; i++) {
        const cv = document.createElement("canvas"); cv.width = 200; cv.height = 60; const g = cv.getContext("2d"); g.fillStyle = "#000"; g.fillRect(10, 10, 180, 40);
        await dbPut("signatures", stampNew({ reportId: heavy.id, companyId: "c" + i, role: "foreman", roleLabel: "職長", imageBlob: await new Promise((r) => cv.toBlob(r, "image/png")), signedAt: new Date().toISOString() }));
      }
      return { site: site.id, heavy: heavy.id, normal: normal.id };
    });

    // ===== 日報1件（情報の多い日）: PDF出力 → 1ページのPDFを作成 → 共有 =====
    await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.heavy}`); await page.waitForSelector("#reportPdfBtn");
    await page.click("#reportPdfBtn");
    await page.waitForFunction(() => document.getElementById("reportPrintDialog").open);
    await page.waitForTimeout(800);
    const areaShown = await page.isVisible("#reportOnePageArea");
    check(T("会社指定様式の印刷ダイアログに「1ページのPDFを作成（A3）」が出る（従来の「印刷画面を開く」もそのまま）"), areaShown && (await page.isVisible("#reportPrintOpenBtn")));
    const note = await page.textContent("#reportPrintNote");
    const ver = await page.evaluate(async () => (await import("/js/report-output/renderers/companyPdfFromXlsx.js")).PRINT_LAYOUT_VERSION);
    check(T("印刷ダイアログに、会社様式の印刷レイアウトの版を表示する（iPad で新しい版が読み込まれているかを確かめるため）"), !!ver && note.includes(`印刷レイアウト ${ver}`), note.slice(-40));
    const info = await sheetInfo(page);
    await page.click("#reportOnePageBtn");
    await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("reportPrintStatus").textContent), null, { timeout: 60000 });
    const status = await page.textContent("#reportPrintStatus");
    check(T("1ページのPDFを作成できる（A3・1ページ）"), status.includes("作成しました") && status.includes("1ページ"), status.slice(0, 80));
    await page.click("#reportOnePageShareBtn");
    await page.waitForFunction(() => window.__shared.length === 1, null, { timeout: 10000 });
    const one = await inspectShared(page, 0, info[0].sigs);
    check(T("共有に渡すPDFは1ページで、用紙は A3 横（1191×842pt）"), one.type === "application/pdf" && one.numPages === 1 && one.sizes[0][0] === A3[0] && one.sizes[0][1] === A3[1], JSON.stringify({ n: one.numPages, s: one.sizes }));
    check(T("ファイル名は「工事日報_現場名_日付.pdf」"), one.name === "工事日報_1ページPDFの試験現場_2026-09-10.pdf", one.name);
    const p0 = one.pages[0];
    check(T("PDFの画像は表の全体（縦横の比率が表と同じ＝下の部分が切れていない）で、下の端の罫線まで入っている"), Math.abs(p0.w / p0.h - info[0].ratio) / info[0].ratio < 0.01 && p0.bottomInk > p0.w * 0.3, JSON.stringify({ img: p0.w / p0.h, table: info[0].ratio, bottomInk: p0.bottomInk }));
    check(T("職長サイン6件が、PDFの画像の中の業者の行の位置に描かれている"), info[0].sigs.length === 6 && p0.sig.every((n) => n > 20), JSON.stringify(p0.sig));
    const rec = await page.evaluate(async (id) => (await (await import("/js/db.js")).dbGet("reports", id)).lastOutputFormat, ids.heavy);
    check(T("PDF出力として記録される（従来の印刷画面からのPDF出力と同じ）"), rec === "pdf", rec);
    await page.click("#reportPrintCloseBtn");

    // ===== まとめて印刷（2件）: 1日報1ページ → 2ページ =====
    await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#bulkPdfBtn", { state: "attached" });
    await page.waitForFunction(() => document.querySelectorAll("#reportList li").length >= 2, null, { timeout: 15000 });
    await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; document.getElementById("bulkPdfBtn").scrollIntoView(); });
    await page.click("#bulkPdfBtn");
    await page.waitForFunction(() => document.getElementById("reportPrintDialog").open, null, { timeout: 15000 });
    await page.waitForTimeout(1000);
    const infoB = await sheetInfo(page);
    await page.click("#reportOnePageBtn");
    await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("reportPrintStatus").textContent), null, { timeout: 60000 });
    await page.click("#reportOnePageShareBtn");
    await page.waitForFunction(() => window.__shared.length === 2, null, { timeout: 10000 });
    const two = await inspectShared(page, 1, []);
    check(T("まとめて印刷（2件）: 日報1件＝1ページで2ページ、どのページも A3 横で表の全体"), infoB.length === 2 && two.numPages === 2 && two.sizes.every((s) => s[0] === A3[0] && s[1] === A3[1]) && two.pages.every((p, i) => Math.abs(p.w / p.h - infoB[i].ratio) / infoB[i].ratio < 0.01 && p.bottomInk > p.w * 0.3), JSON.stringify({ n: two.numPages, s: two.sizes }));
    await page.click("#reportPrintCloseBtn");

    // ===== 職長サインの大きさ・位置（日報画面で、iPad と同じ画面の大きさ・倍率2で手書きしたサイン） =====
    //   保存されるサインは欄全体（余白を含む横長の画像）。印刷用HTMLでは線のある範囲だけを切り出して欄に収める（縦横比は保つ）
    const drawnId = await page.evaluate(async (site) => { const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js"); const r = stampNew({ siteId: site, date: "2026-09-12", dayStatus: "work", weather: "晴れ", progressPercent: 10, companies: ["丙工業", "丁工業", "戊工業"].map((n, i) => ({ companyId: "d" + i, companyName: n, occupation: "塗装", actualWorkerCount: "1" })) }); await dbPut("reports", r); return r.id; }, ids.site);
    await page.goto(`${BASE}#/sites/${ids.site}/report/${drawnId}`); await page.waitForSelector(".company-row .signatureCanvas");
    // 1行目: 欄の中央に中くらい、2行目: 左上に小さく、3行目: 横いっぱいに細長く
    const strokes = [[[0.33, 0.3], [0.4, 0.75], [0.47, 0.25], [0.54, 0.8], [0.6, 0.3], [0.67, 0.65]], [[0.05, 0.1], [0.1, 0.35], [0.15, 0.12], [0.2, 0.3]], [[0.03, 0.5], [0.3, 0.4], [0.6, 0.6], [0.97, 0.45]]];
    for (let i = 0; i < 3; i++) {
      const cv = page.locator(".company-row .signatureCanvas").nth(i); await cv.scrollIntoViewIfNeeded(); const bx = await cv.boundingBox();
      await page.mouse.move(bx.x + bx.width * strokes[i][0][0], bx.y + bx.height * strokes[i][0][1]); await page.mouse.down();
      for (const [x, y] of strokes[i].slice(1)) await page.mouse.move(bx.x + bx.width * x, bx.y + bx.height * y, { steps: 6 });
      await page.mouse.up(); await page.waitForTimeout(80);
    }
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 });
    await page.goto(`${BASE}#/sites/${ids.site}/report/${drawnId}`); await page.waitForSelector("#reportPdfBtn");
    await page.click("#reportPdfBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open); await page.waitForTimeout(800);
    const sz = await page.evaluate(async (rid) => {
      const { dbGetAll } = await import("/js/db.js");
      const sigs = (await dbGetAll("signatures", "by_reportId", rid)).filter((x) => !x.isDeleted).sort((a, b) => a.companyId.localeCompare(b.companyId));
      const inkOf = async (src) => { const bm = await createImageBitmap(src); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, n = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i + 3] > 24 && d[i] + d[i + 1] + d[i + 2] < 720) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return { W: c.width, H: c.height, w: x1 - x0 + 1, h: y1 - y0 + 1, n }; };
      const doc = document.getElementById("reportPrintFrame").contentDocument;
      const imgs = [...doc.querySelectorAll(".xlsx-overlay-sign")];
      const out = [];
      for (let k = 0; k < imgs.length; k++) {
        const im = imgs[k]; const r = im.getBoundingClientRect(); const blob = await (await fetch(im.src)).blob();
        const shown = await inkOf(blob); const s = Math.min(r.width / shown.W, r.height / shown.H);
        out.push({ top: Math.round(r.top), cellW: r.width, cellH: r.height, inkW: shown.w * s, inkH: shown.h * s, aspectShown: shown.w / shown.h, n: shown.n, inside: shown.W * s <= r.width + 0.5 && shown.H * s <= r.height + 0.5 });
      }
      // 保存されているサインと、出力用に切り出して線を太くした画像（signatureCrop.js）を比べる
      const { cropSignatureToInk } = await import("/js/report-output/signatureCrop.js");
      const px = async (b) => { const bm = await createImageBitmap(b); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0); return { W: c.width, H: c.height, d: g.getImageData(0, 0, c.width, c.height).data }; };
      const orig = [];
      for (const g of sigs) {
        const o = await inkOf(g.imageBlob); const res = await cropSignatureToInk(g.imageBlob); const a = await px(g.imageBlob); const b = await px(res.blob);
        // 元の線の画素が、出力でもすべて線のまま（欠けない）
        let lost = 0; for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) { const i = (y * a.W + x) * 4; if (a.d[i + 3] > 24 && a.d[i] + a.d[i + 1] + a.d[i + 2] < 720) { const X = x - res.box.x, Y = y - res.box.y; if (X < 0 || Y < 0 || X >= b.W || Y >= b.H || b.d[(Y * b.W + X) * 4 + 3] <= 24) lost++; } }
        const shown = await inkOf(res.blob);
        orig.push({ aspect: o.w / o.h, expectedAspect: (o.w + 2 * res.radius) / (o.h + 2 * res.radius), n: o.n, nOut: shown.n, lost, radius: res.radius, outSize: [b.W, b.H] });
      }
      return { out, orig };
    }, drawnId);
    const fill = sz.out.map((o) => Math.max(o.inkW / o.cellW, o.inkH / o.cellH));
    check(T("職長サインの大きさ: 3件とも、線が欄の幅か高さの8割以上を使う（欄の大きさに合わせて大きく出る）"), sz.out.length === 3 && fill.every((f) => f >= 0.8), JSON.stringify(sz.out.map((o) => `幅${Math.round((o.inkW / o.cellW) * 100)}%・高さ${Math.round((o.inkH / o.cellH) * 100)}%`)));
    check(T("職長サインの縦横比: 欄に収めたサインの線の縦横比が、保存されているサインの線（＋太くした分）と同じ（引き伸ばさない）"), sz.out.length === 3 && sz.out.every((o, i) => Math.abs(o.aspectShown - sz.orig[i].expectedAspect) / sz.orig[i].expectedAspect < 0.03), JSON.stringify(sz.out.map((o, i) => [o.aspectShown.toFixed(2), sz.orig[i].expectedAspect.toFixed(2)])));
    check(T("職長サインが欠けない: 保存されているサインの線の画素が、出力の画像でもすべて線のまま残り、欄の中に収まっている"), sz.out.length === 3 && sz.orig.every((o) => o.lost === 0) && sz.out.every((o) => o.inside), JSON.stringify(sz.orig.map((o, i) => [o.lost, sz.out[i].inside])));
    check(T("職長サインの線を、出力のときだけ太く・濃くする（線の画素が元の1.5倍以上・保存されているサインは変えない）"), sz.orig.length === 3 && sz.orig.every((o) => o.radius >= 1 && o.nOut >= o.n * 1.5), JSON.stringify(sz.orig.map((o) => ({ r: o.radius, n: o.n, nOut: o.nOut }))));
    check(T("職長サインの位置: 3件がそれぞれ別の業者の行（上から順）に置かれる"), sz.out.length === 3 && sz.out[0].top < sz.out[1].top && sz.out[1].top < sz.out[2].top, JSON.stringify(sz.out.map((o) => o.top)));
    // サインの欄は、業者1社分の見た目の欄（03-2 は Excel の2行分。下の行は空で罫線なし）。次の業者のサインとの間隔と同じ高さで、重ならない
    const pitch = sz.out.length === 3 ? [sz.out[1].top - sz.out[0].top, sz.out[2].top - sz.out[1].top] : [];
    check(T("職長サインの欄の高さ: 業者1社分の見た目の欄（2行分）いっぱいで、次の業者の欄に重ならない"), pitch.length === 2 && sz.out.slice(0, 2).every((o, i) => Math.abs(o.cellH - pitch[i]) <= 1.5), JSON.stringify({ heights: sz.out.map((o) => Math.round(o.cellH)), pitch }));
    // 1ページのPDFでも、サインが大きく出る
    const infoD = await sheetInfo(page);
    await page.click("#reportOnePageBtn");
    await page.waitForFunction(() => /作成しました|作成できませんでした/.test(document.getElementById("reportPrintStatus").textContent), null, { timeout: 60000 });
    const nShared = await page.evaluate(() => window.__shared.length);
    await page.click("#reportOnePageShareBtn");
    await page.waitForFunction((n) => window.__shared.length === n + 1, nShared, { timeout: 10000 });
    const pd = await inspectShared(page, nShared, infoD[0].sigs);
    check(T("職長サインを大きくした後も、1ページのPDFは A3 横・1ページで、3件のサインが描かれている"), pd.numPages === 1 && pd.sizes[0][0] === A3[0] && pd.sizes[0][1] === A3[1] && infoD[0].sigs.length === 3 && pd.pages[0].sig.every((n) => n > 20), JSON.stringify({ n: pd.numPages, sig: pd.pages[0].sig }));
    await page.click("#reportPrintCloseBtn");

    // ===== 線の範囲の切り出し（signatureCrop.js）の端のケース: 例外にならず、線の画素（透明度を含む）が欠けない =====
    const edge = await page.evaluate(async () => {
      const { cropSignatureToInk } = await import("/js/report-output/signatureCrop.js");
      const mk = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")); return new Promise((r) => c.toBlob(r, "image/png")); };
      const alpha = async (b) => { const bm = await createImageBitmap(b); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0, sum = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { n++; sum += d[i]; } return { n, sum }; };
      const out = {};
      const empty = await mk(1584, 360, () => {}); const re = await cropSignatureToInk(empty); out.empty = !re.cropped && re.blob === empty;
      const faint = await mk(1584, 360, (g) => { g.strokeStyle = "rgba(34,34,34,0.5)"; g.lineWidth = 1; g.beginPath(); g.moveTo(300.5, 60.3); g.lineTo(1290.7, 300.6); g.stroke(); });
      const px = async (b) => { const bm = await createImageBitmap(b); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0); return { W: c.width, H: c.height, d: g.getImageData(0, 0, c.width, c.height).data }; };
      // 元の画像で少しでも描かれている画素（不透明度 > 0）が、出力でもすべて描かれている（1画素も欠けない）
      const covered = async (src, res) => { const a = await px(src), b = await px(res.blob); for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) { if (a.d[(y * a.W + x) * 4 + 3] === 0) continue; const X = x - res.box.x, Y = y - res.box.y; if (X < 0 || Y < 0 || X >= b.W || Y >= b.H || b.d[(Y * b.W + X) * 4 + 3] === 0) return false; } return true; };
      const rf = await cropSignatureToInk(faint); const a0 = await alpha(faint); out.faint = rf.cropped && a0.n > 0 && (await covered(faint, rf));
      const corners = await mk(1584, 360, (g) => { g.fillStyle = "#222"; g.fillRect(0, 0, 4, 4); g.fillRect(1580, 356, 4, 4); }); const rc = await cropSignatureToInk(corners); out.corners = !rc.cropped && rc.box.w === 1584 && rc.box.h === 360 && (await covered(corners, rc));
      const broken = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }); const rb = await cropSignatureToInk(broken); out.broken = !rb.cropped && rb.blob === broken;
      return out;
    });
    check(T("線の範囲の切り出し: 空（透明）・壊れた画像はそのまま、欄の端まで書いたものは切らない、かすれた細い線も1画素も欠けない（太くしても）"), edge.empty && edge.broken && edge.corners && edge.faint, JSON.stringify(edge));

    // ===== 台帳の印刷には出さない（1日1頁の台帳は別の印刷） =====
    await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#ledgerPrintBtn", { state: "attached" });
    await page.evaluate(() => { document.getElementById("reportBulkPanel").open = true; });
    const ledgerBtn = await page.$("#ledgerPrintBtn");
    if (ledgerBtn) {
      await page.evaluate(() => document.getElementById("ledgerPrintBtn").scrollIntoView());
      await page.click("#ledgerPrintBtn");
      await page.waitForFunction(() => document.getElementById("reportPrintDialog").open, null, { timeout: 30000 });
      check(T("台帳の印刷では「1ページのPDFを作成」を出さない"), !(await page.isVisible("#reportOnePageArea")));
      await page.click("#reportPrintCloseBtn");
    } else check(T("台帳の印刷のボタンが見つかる"), false);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const errors = [];
  for (const [bt, name] of [[chromium, "Chromium"], [webkit, "WebKit"]]) await runBrowser(bt, name, errors);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
