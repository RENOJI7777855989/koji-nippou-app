// 業者見積（PDF）の取込と、積算との照合・見積落とし確認を確かめる（2026-10-17。架空のデータだけ。Chromium）。
//   ・文字情報のあるPDF（このテストで作る架空の見積書）から、列を指定して明細を取り出す。数量・単価・金額の数値化、一式の目印
//   ・画像だけのPDFは取り込まず案内する（文字認識は未対応）
//   ・同じファイル（SHA-256）・同じ頁の取込は重複として見つける
//   ・照合: 完全一致・数量差／金額差・単位違い・一式・積算だけにある項目・業者見積だけにある項目・重複候補・名称違い（人の確認が必要）
//   ・人が「同一項目」と確定すると保存され、読み直しても対応が確定のまま。似ているだけでは自動で確定しない
//   ・見積落とし確認: 積算だけにある項目はリスク付きの候補になる（断定しない）
//   ※実際の業者のPDFでの読み取り精度は、このテストでは確かめていない（架空のPDFだけ）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

// 架空の業者見積書（列: 工種・名称・規格・数量・単位・単価・金額）
const QUOTE_ROWS = [
  ["塗装", "外壁塗装", "シリコン 3回塗り", "100", "m2", "2,000", "200,000"],
  ["塗装", "下塗り", "", "120", "m2", "500", "60,000"],
  ["仮設", "足場", "くさび緊結式", "30", "m", "8,000", "240,000"],
  ["防水", "シール打ち替え", "", "50", "m", "1,100", "55,000"],
  ["仮設", "仮設工事", "", "一式", "式", "", "50,000"],
  ["塗装", "高圧洗浄", "", "100", "m2", "200", "20,000"],
  ["内装", "クロス張替え 寝室", "", "40", "m2", "1,000", "40,000"],
  ["内装", "クロス張替え 居間", "", "40", "m2", "1,000", "40,000"],
  ["共通", "諸経費", "", "1", "式", "", "30,000"]
];
const quoteHtml = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:12px}td,th{border:1px solid #333;padding:4px 8px;text-align:left}</style></head><body>
  <h1>御見積書（架空）</h1><table><thead><tr><th>工種</th><th>名称</th><th>規格</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th></tr></thead>
  <tbody>${QUOTE_ROWS.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estimate-quote-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 } });
  // PDFを作る（文字情報のあるPDF／画像だけのPDF）
  const maker = await ctx.newPage();
  await maker.setContent(quoteHtml); const textPdf = await maker.pdf({ format: "A4" });
  await maker.setContent(`<!doctype html><html><body><div style="width:400px;height:300px;background:linear-gradient(45deg,#ccc,#333)"></div></body></html>`); const imagePdf = await maker.pdf({ format: "A4" });
  await maker.close();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  // ===== PDFの取込 =====
  const imp = await page.evaluate(async ({ text, image }) => {
    const toBuf = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
    const { readPdf } = await import("/js/estimate/pdfWorkbookReader.js");
    const { extractEstimateRows } = await import("/js/estimate/excelEstimateParser.js");
    const { detectLumpSum, sha256Hex } = await import("/js/vendorQuote/vendorQuoteTrace.js");
    const wb = await readPdf(toBuf(text));
    const layout = await wb.readSheet(wb.sheetNames[0]);
    // 見出しの行を探して、列を指定する（画面で人が列を選ぶのと同じ指定）
    let headerRow = null; const col = {};
    for (const [ref, cell] of layout.cells) { const m = ref.match(/^([A-Z]+)(\d+)$/); const t = String(cell.text || "").trim(); if (t === "名称") { headerRow = Number(m[2]); } }
    for (const [ref, cell] of layout.cells) { const m = ref.match(/^([A-Z]+)(\d+)$/); if (Number(m[2]) !== headerRow) continue; const t = String(cell.text || "").trim(); const key = { 工種: "category", 名称: "itemName", 規格: "spec", 数量: "quantity", 単位: "unit", 単価: "unitPrice", 金額: "amount" }[t]; if (key) col[key] = m[1]; }
    const { items } = extractEstimateRows(layout, col, headerRow + 1);
    const dbg = [headerRow, headerRow + 1].map((r) => [...layout.cells].filter(([ref]) => Number(ref.match(/\d+$/)[0]) === r).map(([ref, c]) => `${ref}=${c.text}`).join(" "));
    let imageError = "";
    try { const w2 = await readPdf(toBuf(image)); await w2.readSheet(w2.sheetNames[0]); } catch (e) { imageError = e.message; }
    return { sheetNames: wb.sheetNames, headerRow, col, items: items.map((i) => ({ ...i, rawRowCells: undefined, lump: detectLumpSum({ itemName: i.itemName, spec: i.spec, unit: i.unit, quantityText: i.quantity == null ? "一式" : "" }).isLumpSum })), imageError, dbg, sha: await sha256Hex(toBuf(text)) };
  }, { text: textPdf.toString("base64"), image: imagePdf.toString("base64") });
  check("PDF: 文字情報のあるPDFを頁ごとに読み、見出しの行（工種〜金額の7列）を指定できる", imp.sheetNames[0] === "1ページ" && imp.headerRow != null && Object.keys(imp.col).length === 7, JSON.stringify(imp.col));
  const byName = Object.fromEntries(imp.items.map((i) => [i.itemName, i]));
  check("PDF: 明細9件を取り出し、名称・規格・単位は文字のまま（PDFの文字の間の空白は読み取りで詰まる: シリコン 3回塗り→シリコン3回塗り。照合は空白を無視する）、数量・単価・金額はカンマを外して数値にする", imp.items.length === 9 && byName["外壁塗装"]?.spec === "シリコン3回塗り" && byName["外壁塗装"].quantity === 100 && byName["外壁塗装"].unitPrice === 2000 && byName["外壁塗装"].amount === 200000 && byName["足場"]?.unit === "m", imp.items.map((i) => `${i.itemName}:${i.quantity}/${i.unit}/${i.unitPrice}/${i.amount}`).join(" "));
  check("PDF: 数量「一式」は数値にせず要確認にし、一式の目印を付ける（金額は原文の 50,000 のまま）", byName["仮設工事"]?.quantity === null && byName["仮設工事"].needsReview === true && byName["仮設工事"].lump === true && byName["仮設工事"].amount === 50000, JSON.stringify(byName["仮設工事"]));
  check("PDF: 画像だけのPDFは取り込まず「テキスト情報がありません（OCR未対応）」と案内する", imp.imageError.includes("テキスト情報がありません"), imp.imageError);

  // ===== 取込の保存と重複取込の検出 =====
  const dup = await page.evaluate(async ({ sha }) => {
    const { createSite } = await import("/js/sites.js");
    const { createVendorQuoteBatch, findDuplicateVendorQuoteBatch } = await import("/js/vendorQuote/vendorQuoteBatches.js");
    const site = await createSite({ name: "見積照合の確認現場", startDate: "2026-09-01" });
    const before = await findDuplicateVendorQuoteBatch({ siteId: site.id, sourceFileSha256: sha, sheetName: "1ページ" });
    await createVendorQuoteBatch({ siteId: site.id, vendorName: "架空塗装", sourceFileName: "見積.pdf", sourceFileType: "pdf", sheetName: "1ページ", sourceFileSha256: sha, itemCount: 8 });
    const same = await findDuplicateVendorQuoteBatch({ siteId: site.id, sourceFileSha256: sha, sheetName: "1ページ" });
    const otherSheet = await findDuplicateVendorQuoteBatch({ siteId: site.id, sourceFileSha256: sha, sheetName: "2ページ" });
    return { siteId: site.id, before: !!before, same: !!same, otherSheet: !!otherSheet };
  }, { sha: imp.sha });
  check("同じファイル（SHA-256）・同じ頁の取込は重複として見つける（別の頁なら別の取込）", !dup.before && dup.same && !dup.otherSheet, JSON.stringify(dup));

  // ===== 照合 =====
  const cmp = await page.evaluate(async ({ vendor, siteId }) => {
    const { compareEstimateToQuote } = await import("/js/vendorQuote/compareEstimateToQuote.js");
    const { checkOmissions } = await import("/js/vendorQuote/omissionCheck.js");
    const { setItemMatchOverride, listItemMatchOverridesBySite } = await import("/js/vendorQuote/itemMatchOverrides.js");
    const { buildItemKey } = await import("/js/vendorQuote/itemNormalize.js");
    const e = (id, category, itemName, spec, quantity, unit, unitPrice, amount) => ({ id, category, itemName, spec, quantity, unit, unitPrice, amount });
    const est = [
      e("e1", "塗装", "外壁塗装", "シリコン 3回塗り", 100, "m2", 2000, 200000),
      e("e2", "塗装", "下塗り", "", 100, "m2", 500, 50000),
      e("e3", "仮設", "足場", "くさび緊結式", 300, "m2", 800, 240000),
      e("e4", "防水", "シーリング打替え", "", 50, "m", 1200, 60000),
      e("e5", "仮設", "仮設工事", "一式", 1, "式", 45000, 45000),
      e("e6", "仮設", "養生", "", 1, "式", 30000, 30000),
      e("e7", "内装", "クロス張替え", "", 80, "m2", 1000, 80000),
      e("e8", "共通", "諸経費", "", 1, "式", 28000, 28000)
    ];
    const vq = vendor.map((v, i) => ({ ...v, id: `v${i + 1}` }));
    const label = (r) => `${r.type}:${r.estimateItem?.itemName || "-"}↔${r.vendorItem?.itemName || "-"}${r.flags ? `[${(r.flags || []).join(",")}]` : ""}`;
    const res1 = compareEstimateToQuote({ estimateItems: est, vendorItems: vq });
    const om = checkOmissions({ compareResults: res1, vendorItems: vq, dispositions: [] });
    // 人の確認: 「シーリング打替え」と「シール打ち替え」を同一項目と確定（保存）→ 読み直して照合
    const sealEst = est.find((x) => x.id === "e4"); const sealVq = vq.find((x) => x.itemName === "シール打ち替え");
    await setItemMatchOverride({ siteId, estimateItemKey: buildItemKey(sealEst), vendorItemKey: buildItemKey(sealVq), decision: "same" });
    return { res1: res1.map(label), om: { candidates: (om.candidates || []).map((c) => `${(c.item || c.estimateItem)?.itemName}:${c.risk}`), reverse: (om.reverseCandidates || []).map((c) => (c.item || c.vendorItem)?.itemName), summary: om.summary }, est, vq };
  }, { vendor: imp.items.map(({ needsReview, reviewReasons, sourceRow, lump, ...rest }) => rest), siteId: dup.siteId });
  const has = (prefix) => cmp.res1.some((x) => x.startsWith(prefix));
  check("照合: 名称・規格が同じで差が許容差（±5%）以内 → 一致（外壁塗装）", has("match:外壁塗装↔外壁塗装"), cmp.res1.join(" / "));
  check("照合: 数量・金額の差が許容差を超える → 差あり（下塗り 100→120 m2）", cmp.res1.some((x) => x.startsWith("diff:下塗り↔下塗り")));
  check("照合: 単位が違う → 単位違い・要確認（足場 m2／m）。数量・単価は換算しない", has("unit_diff:足場↔足場"));
  check("照合: 両方が一式（単位「式」・名称と規格が同じ）→ 一式計上・要確認（諸経費。金額差は参考だけ）", has("lump_sum:諸経費↔諸経費"));
  check("照合: 名称は同じでも規格が違う（仮設工事: 積算「一式」／業者見積 空欄）→ 同一候補（人が確定するまで対応は未確定）", has("candidate:仮設工事↔仮設工事"));
  check("照合: 似ているだけの名称（シーリング打替え／シール打ち替え）は自動で一致にしない（一致・差ありにならない）", !cmp.res1.some((x) => /^(match|diff):シーリング打替え/.test(x)));
  check("照合: 積算だけにある項目（養生）→ 見積漏れの可能性", has("estimate_only:養生"));
  check("照合: 業者見積だけにある項目（高圧洗浄）→ 積算漏れの可能性", has("vendor_only:-↔高圧洗浄"));
  check("照合: 同じくらい似た候補が2件（クロス張替え ↔ 寝室・居間）→ 重複の可能性（1件へ自動で確定しない）", cmp.res1.some((x) => x.startsWith("duplicate_possible:クロス張替え")), cmp.res1.filter((x) => x.includes("クロス")).join(" / "));
  check("見積落とし確認: 積算だけにある養生はリスク付きの候補（断定せず「可能性」）・業者見積だけの高圧洗浄は逆方向の確認に出る", cmp.om.candidates.some((c) => c.startsWith("養生:")) && cmp.om.reverse.includes("高圧洗浄") && cmp.om.summary?.overallStatus !== "ok", JSON.stringify(cmp.om));

  // 人が確定した対応は保存され、ページを読み直しても確定のまま
  await page.reload(); await page.waitForSelector("#view-site-list:not([hidden])");
  const re = await page.evaluate(async ({ siteId, est, vq }) => {
    const { compareEstimateToQuote } = await import("/js/vendorQuote/compareEstimateToQuote.js");
    const { listItemMatchOverridesBySite } = await import("/js/vendorQuote/itemMatchOverrides.js");
    const overrides = await listItemMatchOverridesBySite(siteId);
    const res = compareEstimateToQuote({ estimateItems: est, vendorItems: vq, overrides });
    return { overrides: overrides.length, seal: res.filter((r) => r.estimateItem?.itemName === "シーリング打替え").map((r) => `${r.type}↔${r.vendorItem?.itemName || "-"}`) };
  }, { siteId: dup.siteId, est: cmp.est, vq: cmp.vq });
  check("人の確認: 「同一項目」と確定した対応は保存され、読み直しても シーリング打替え↔シール打ち替え が対応付く（単価差は差ありとして残る）", re.overrides === 1 && re.seal.length === 1 && /^(match|diff)↔シール打ち替え$/.test(re.seal[0]), JSON.stringify(re));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
