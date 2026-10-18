// 職長サインの表示・保存と画面の倍率（devicePixelRatio）（2026-10-18 修正の確認。架空データ・隔離したプロファイル）
//   以前は保存済みの署名を欄に描き戻すとき倍率が二重にかかり、倍率2（iPad）では拡大されて左上しか見えず、
//   その上に書き足して保存すると元の署名の一部が失われていた。
//   倍率 1・2・3 × Chromium・WebKit で、表示（画素ごとの比較）・書き足し・変更なしの保存・［書き直し］・新規・出力・保存の失敗を確かめる。
//   画像の比較は、境界（四隅・各辺の中央）と中央に置いた印の画素で行い、保存した画像からも欠けていないことを確かめる
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

/** ページに道具を置く: 画像の画素・印の判定・欄の画素 */
async function installTools(page) {
  await page.evaluate(() => {
    window.S = {
      async pixels(blob) { const bm = await createImageBitmap(blob); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext("2d"); g.drawImage(bm, 0, 0); return { w: bm.width, h: bm.height, data: g.getImageData(0, 0, bm.width, bm.height).data }; },
      canvasPixels(i) { const c = document.querySelectorAll(".company-row .signatureCanvas")[i]; return { w: c.width, h: c.height, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data }; },
      /** 印（境界の8か所と中央）の位置（画素） */
      marks(w, h, s) { const xs = [1, Math.floor((w - s) / 2), w - s - 1]; const ys = [1, Math.floor((h - s) / 2), h - s - 1]; const out = []; for (const x of xs) for (const y of ys) out.push({ x, y, s }); return out; },
      /** 印の内側の画素が、すべて不透明か（欠けていないか） */
      marksPresent(px, marks) { let missing = 0; for (const m of marks) for (let y = m.y + 1; y < m.y + m.s - 1; y++) for (let x = m.x + 1; x < m.x + m.s - 1; x++) if (px.data[(y * px.w + x) * 4 + 3] < 200) missing++; return missing; },
      /** a の不透明な画素のうち、b で不透明でないものの数（欠けた画素） */
      lost(a, b) { if (a.w !== b.w || a.h !== b.h) return -1; let n = 0; for (let i = 3; i < a.data.length; i += 4) if (a.data[i] >= 200 && b.data[i] < 200) n++; return n; },
      /** 不透明の度合いの差が大きい画素の数 */
      diff(a, b) { if (a.w !== b.w || a.h !== b.h) return -1; let n = 0; for (let i = 3; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 32) n++; return n; },
      opaque(px) { let n = 0; for (let i = 3; i < px.data.length; i += 4) if (px.data[i] >= 200) n++; return n; },
      async sha(blob) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join(""); },
      async sigs(rid, cid) { const { dbGetAll } = await import("/js/db.js"); return (await dbGetAll("signatures", "by_reportId", rid)).filter((s) => !s.isDeleted && s.companyId === cid); }
    };
  });
}

async function drawStroke(page, rowIndex, from, to) {
  const cv = page.locator(".company-row .signatureCanvas").nth(rowIndex);
  await cv.scrollIntoViewIfNeeded();
  const b = await cv.boundingBox();
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

async function runCombo(browserType, bname, dpr, errors) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sigdpr-${bname}-${dpr}-`));
  const ctx = await browserType.launchPersistentContext(dir, { viewport: { width: 1024, height: 768 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${bname}${dpr}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const tag = `${bname}・倍率${dpr}`;
  try {
    await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
    await installTools(page);
    const ids = await page.evaluate(async () => {
      const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
      const site = await createSite({ name: "署名の倍率の試験", startDate: "2026-09-01", endDate: "2026-09-30" });
      const r = stampNew({ siteId: site.id, date: "2026-09-10", dayStatus: "work", weather: "晴れ", progressPercent: 10, companies: [{ companyId: "c1", companyName: "甲工業", occupation: "塗装", actualWorkerCount: "2" }, { companyId: "c2", companyName: "乙工業", occupation: "防水", actualWorkerCount: "1" }] });
      await dbPut("reports", r);
      return { site: site.id, r: r.id };
    });
    const openReport = async () => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.r}`); await page.waitForSelector(".company-row .signatureCanvas"); await page.waitForTimeout(250); await installTools(page); };
    await openReport();
    // 元の署名: 欄の内部の画素と同じ大きさで、境界と中央に印を置いた画像（実際の手書きの保存と同じ大きさ）
    const orig = await page.evaluate(async (ids) => {
      const c0 = document.querySelector(".company-row .signatureCanvas"); const w = c0.width; const h = c0.height; const s = Math.max(6, Math.round(6 * devicePixelRatio));
      const c = new OffscreenCanvas(w, h); const g = c.getContext("2d"); g.fillStyle = "#111"; for (const m of window.S.marks(w, h, s)) g.fillRect(m.x, m.y, m.s, m.s);
      const blob = await c.convertToBlob({ type: "image/png" });
      const { saveSignature } = await import("/js/signatures.js"); const sig = await saveSignature({ reportId: ids.r, companyId: "c1", blob });
      return { id: sig.id, w, h, s, sha: await window.S.sha(blob), dpr: devicePixelRatio };
    }, ids);
    // A・B 開き直すと、署名の全体（境界の印を含む）が正しい位置・大きさで表示される
    await openReport();
    const shown = await page.evaluate(async (ids) => { const [sig] = await window.S.sigs(ids.r, "c1"); const a = await window.S.pixels(sig.imageBlob); const b = window.S.canvasPixels(0); const s = Math.max(6, Math.round(6 * devicePixelRatio)); return { size: [b.w, b.h], diff: window.S.diff(a, b), missingMarks: window.S.marksPresent(b, window.S.marks(b.w, b.h, s)), opaque: [window.S.opaque(a), window.S.opaque(b)] }; }, ids);
    check(`${tag}: A 開き直した署名が、保存した画像と同じ位置・大きさで表示される（画素の差 0）`, orig.dpr === dpr && shown.size[0] === orig.w && shown.size[1] === orig.h && shown.diff === 0, JSON.stringify(shown));
    check(`${tag}: B 右下・各辺・四隅の印を含む署名の全体が、欠けずに表示される`, shown.missingMarks === 0 && shown.opaque[0] === shown.opaque[1] && shown.opaque[0] > 0, JSON.stringify(shown.opaque));
    // D 開き直して何も変えずに保存 → 署名は保存し直さない（id・画像の SHA-256 が同じ）
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 }); await installTools(page);
    const d = await page.evaluate(async (ids) => { const s = await window.S.sigs(ids.r, "c1"); return { n: s.length, id: s[0]?.id, sha: s[0] ? await window.S.sha(s[0].imageBlob) : "" }; }, ids);
    check(`${tag}: D 開き直して変更せずに保存しても、署名は保存し直さず、画像は元のまま（id・SHA-256 が同じ）`, d.n === 1 && d.id === orig.id && d.sha === orig.sha, JSON.stringify(d));
    // C 開き直した署名に書き足して保存 → 元の印の画素が1つも欠けず、書き足した線がある
    await openReport();
    await drawStroke(page, 0, [0.25, 0.3], [0.4, 0.45]);
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 }); await installTools(page);
    const c = await page.evaluate(async ([ids, orig]) => {
      const s = await window.S.sigs(ids.r, "c1"); const saved = await window.S.pixels(s[0].imageBlob);
      const oc = new OffscreenCanvas(orig.w, orig.h); const g = oc.getContext("2d"); g.fillStyle = "#111"; for (const m of window.S.marks(orig.w, orig.h, orig.s)) g.fillRect(m.x, m.y, m.s, m.s); const o = { w: orig.w, h: orig.h, data: g.getImageData(0, 0, orig.w, orig.h).data };
      return { n: s.length, replaced: s[0].id !== orig.id, size: [saved.w, saved.h], lost: window.S.lost(o, saved), missingMarks: window.S.marksPresent(saved, window.S.marks(saved.w, saved.h, orig.s)), added: window.S.opaque(saved) - window.S.opaque(o) };
    }, [ids, orig]);
    check(`${tag}: C 開き直した署名に書き足して保存すると、保存した画像は欄と同じ大きさで、元の署名の画素（境界の印を含む）が1つも欠けず、書き足した線が加わる`, c.n === 1 && c.replaced && c.size[0] === orig.w && c.size[1] === orig.h && c.lost === 0 && c.missingMarks === 0 && c.added > 20, JSON.stringify(c));
    // G 出力（帳票）に使う署名の画像も、保存した画像そのもの（欠けていない）
    const g = await page.evaluate(async (ids) => {
      const { buildReportOutputModel } = await import("/js/report-output/reportDataAdapter.js"); const { dbGet, dbGetAll } = await import("/js/db.js");
      const report = await dbGet("reports", ids.r); const site = await dbGet("sites", report.siteId); const signatures = (await dbGetAll("signatures", "by_reportId", ids.r)).filter((s) => !s.isDeleted);
      const model = buildReportOutputModel({ site, report, signatures });
      const out = model.companies.find((x) => x.signature)?.signature?.blob; const [sig] = await window.S.sigs(ids.r, "c1");
      const px = out ? await window.S.pixels(out) : null; const s = Math.max(6, Math.round(6 * devicePixelRatio));
      return { same: !!out && (await window.S.sha(out)) === (await window.S.sha(sig.imageBlob)), missingMarks: px ? window.S.marksPresent(px, window.S.marks(px.w, px.h, s)) : -1 };
    }, ids);
    check(`${tag}: G 出力に使う署名の画像は保存した画像と同じで、境界の印が欠けていない`, g.same && g.missingMarks === 0, JSON.stringify(g));
    // E ［書き直し］で欄を空にしてから、新しく書いて保存できる（古い印は残らない）
    await openReport();
    await page.locator(".company-row").first().locator(".clearSignatureBtn").click(); await page.waitForTimeout(200);
    const cleared = await page.evaluate(() => window.S.opaque(window.S.canvasPixels(0)));
    await drawStroke(page, 0, [0.5, 0.2], [0.7, 0.6]);
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 }); await installTools(page);
    const e = await page.evaluate(async ([ids, orig]) => { const s = await window.S.sigs(ids.r, "c1"); const px = await window.S.pixels(s[0].imageBlob); return { n: s.length, size: [px.w, px.h], opaque: window.S.opaque(px), oldMarks: window.S.marks(px.w, px.h, orig.s).filter((m) => px.data[((m.y + 2) * px.w + m.x + 2) * 4 + 3] >= 200).length }; }, [ids, orig]);
    check(`${tag}: E ［書き直し］で欄が空になり、新しく書いた署名だけが保存される（欄と同じ大きさ・古い印は無い）`, cleared === 0 && e.n === 1 && e.size[0] === orig.w && e.size[1] === orig.h && e.opaque > 20 && e.oldMarks === 0, JSON.stringify({ cleared, ...e }));
    // F 新規の署名（2行目）: 書いて保存 → 開き直すと、保存した画像と同じに表示される
    await openReport();
    await drawStroke(page, 1, [0.1, 0.8], [0.9, 0.15]);
    await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 });
    await openReport();
    const f = await page.evaluate(async (ids) => { const s = await window.S.sigs(ids.r, "c2"); const a = await window.S.pixels(s[0].imageBlob); const b = window.S.canvasPixels(1); return { n: s.length, diff: window.S.diff(a, b), opaque: window.S.opaque(a) }; }, ids);
    check(`${tag}: F 新規の署名を書いて保存し、開き直すと保存した画像と同じに表示される（画素の差 0）`, f.n === 1 && f.diff === 0 && f.opaque > 20, JSON.stringify(f));
    // H 保存（書き直し）の途中でエラー → 「前のサインはそのまま残っています」と表示し、前の署名（画像）が残る
    const beforeH = await page.evaluate(async (ids) => { const [s] = await window.S.sigs(ids.r, "c2"); return { id: s.id, sha: await window.S.sha(s.imageBlob) }; }, ids);
    await drawStroke(page, 1, [0.3, 0.5], [0.6, 0.5]);
    await page.evaluate(() => { const op = IDBObjectStore.prototype.put; window.__restorePut = () => { IDBObjectStore.prototype.put = op; }; IDBObjectStore.prototype.put = function (...a) { if (this.name === "signatures") throw new DOMException("模擬: 容量不足", "QuotaExceededError"); return op.apply(this, a); }; });
    await page.click("#reportSaveBtn");
    await page.waitForFunction(() => /職長サインを保存できませんでした/.test(document.getElementById("message").textContent), null, { timeout: 15000 });
    await page.evaluate(() => window.__restorePut());
    const h = await page.evaluate(async (ids) => { const s = await window.S.sigs(ids.r, "c2"); return { n: s.length, id: s[0]?.id, sha: s[0] ? await window.S.sha(s[0].imageBlob) : "", msg: document.getElementById("message").textContent }; }, ids);
    check(`${tag}: H 署名の保存でエラーになると「前のサインはそのまま残っています」と表示し、前の署名（id・SHA-256）が残る`, h.n === 1 && h.id === beforeH.id && h.sha === beforeH.sha && h.msg.includes("前のサインはそのまま残っています"), JSON.stringify({ n: h.n, same: h.id === beforeH.id && h.sha === beforeH.sha }));
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const errors = [];
  for (const [bt, name] of [[chromium, "Chromium"], [webkit, "WebKit"]]) for (const dpr of [1, 2, 3]) await runCombo(bt, name, dpr, errors);
  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
