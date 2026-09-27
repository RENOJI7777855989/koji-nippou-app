// 同梱する「クリーンな標準テンプレート」が、原本（会社の03-2）の書式・セル構造・台帳構造を保ったまま、
// 前の工事・個人・社内に由来する情報だけを除いていることの検証（実ブラウザで実ファイル）。
// 原本は読み取りのみ（SHA-256で不変を確認）。
// 実行: 静的サーバー（http://localhost:8934）を起動し、tools/build-clean-template.js で assets/templates（暗号化）と鍵を作った状態で
//   ANZEN_TEMPLATE=<原本> node tests/clean-template.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const TEMPLATE = ORIGINAL_TEMPLATE;
const { decryptBundled } = require("./helpers/templateKey.js"); // 同梱は暗号化済み。比較のためメモリ上で復号する（ファイルには書き出さない）
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const original = fs.readFileSync(TEMPLATE), clean = decryptBundled();
  const H0 = sha(original);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => document.readyState === "complete");

  const leakWords = await leakWordsFromOriginal(page, original);
  const r = await page.evaluate(async ({ a64, b64, leakWords, removeTexts }) => {
    const dec = (b) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const { analyzeLedgerTemplate } = await import("/js/report-output/ledger/ledgerTemplate.js");
    const { parseSharedStringsXml, readSheetCells } = await import("/js/report-output/ledger/sheetCells.js");
    const A = await WorkbookPackage.open(dec(a64)); const B = await WorkbookPackage.open(dec(b64));
    const out = {};
    const sheetsA = await A.listSheets(), sheetsB = await B.listSheets();
    out.sheetNames = [sheetsA.map((s) => s.name).join(","), sheetsB.map((s) => s.name).join(",")];
    const pa = await analyzeLedgerTemplate(A), pb = await analyzeLedgerTemplate(B);
    const shape = (p) => JSON.stringify({ pr: p.pageRows, pps: p.pagesPerSheet, sheets: p.ledgerSheets.map((s) => s.name), sep: p.separator, fc: p.firstCol, lc: p.lastCol, form: p.formSheet.name });
    out.ledgerShape = [shape(pa), shape(pb)];

    // ---- パート単位の差 ----
    const partsA = new Set(A.listParts()), partsB = new Set(B.listParts());
    out.removedParts = [...partsA].filter((p) => !partsB.has(p)).sort();
    out.addedParts = [...partsB].filter((p) => !partsA.has(p)).sort();
    const same = async (p) => { const x = await A.getBytes(p), y = await B.getBytes(p); return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]); };
    out.unchangedRequired = {};
    for (const p of [...partsA].filter((p) => /^xl\/(styles\.xml|theme\/|drawings\/|media\/)/.test(p))) out.unchangedRequired[p] = await same(p);
    out.changedParts = [];
    for (const p of [...partsA].filter((p) => partsB.has(p))) if (!(await same(p))) out.changedParts.push(p);

    // ---- セル単位の差（全シート）----
    const ssA = parseSharedStringsXml(await A.getText("xl/sharedStrings.xml")), ssB = parseSharedStringsXml(await B.getText("xl/sharedStrings.xml"));
    const cellDiff = { sheets: 0, cells: 0, styleDiff: 0, formulaDiff: 0, valueDiff: 0, valueDiffToBlank: 0, keyDiff: 0, formulaTotal: 0, cacheDiff: 0, valueDiffExamples: [] };
    for (let i = 0; i < sheetsA.length; i++) {
      const ca = readSheetCells(await A.getText(sheetsA[i].path), ssA), cb = readSheetCells(await B.getText(sheetsB[i].path), ssB);
      cellDiff.sheets++;
      const keys = new Set([...ca.keys(), ...cb.keys()]);
      for (const k of keys) {
        const x = ca.get(k), y = cb.get(k);
        if (!x || !y) { cellDiff.keyDiff++; continue; }
        cellDiff.cells++;
        if (x.style !== y.style) cellDiff.styleDiff++;
        const fx = x.formula ? JSON.stringify([x.formula.text, x.formula.shared, x.formula.si, x.formula.ref]) : null, fy = y.formula ? JSON.stringify([y.formula.text, y.formula.shared, y.formula.si, y.formula.ref]) : null;
        if (fx !== fy) cellDiff.formulaDiff++;
        if (x.formula) { cellDiff.formulaTotal++; if ((x.value ?? null) !== (y.value ?? null)) cellDiff.cacheDiff++; continue; }
        if ((x.value ?? null) !== (y.value ?? null)) { cellDiff.valueDiff++; if ((y.value ?? "") === "") cellDiff.valueDiffToBlank++; else if (removeTexts.reduce((v, t) => v.split(t).join("").replace(/[ \u3000]+$/, ""), String(x.value)) === y.value) cellDiff.valueDiffCompanyRemoved = (cellDiff.valueDiffCompanyRemoved || 0) + 1; if (cellDiff.valueDiffExamples.length < 3) cellDiff.valueDiffExamples.push([sheetsA[i].name, k, x.value, y.value]); }
      }
    }
    out.cellDiff = cellDiff;

    // ---- シートXMLのセル以外（列幅・行・結合・印刷設定・図形の参照）----
    const norm = (xml) => xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, "<sheetData/>").replace(/\sr:id="[^"]*"(?=[^>]*\/>)/g, (m) => m.startsWith(" r:id") ? "" : m).replace(/\stopLeftCell="[^"]*"/, "").replace(/\stabSelected="1"/, "").replace(/<selection\b[^>]*\/>/g, "<selection/>").replace(/<pageSetup\b([^>]*?)\sr:id="[^"]*"/, "<pageSetup$1");
    out.sheetFrame = [];
    for (let i = 0; i < sheetsA.length; i++) {
      const xa = await A.getText(sheetsA[i].path), xb = await B.getText(sheetsB[i].path);
      const rowAttrs = (x) => [...x.matchAll(/<row\b([^>]*)>/g)].map((m) => m[1]).join("|");
      // drawingやlegacyDrawingの参照は同一のままか
      const refs = (x) => [...x.matchAll(/<(drawing|legacyDrawing)\b[^>]*\/>/g)].map((m) => m[0]).join("");
      out.sheetFrame.push({ name: sheetsA[i].name, frame: norm(xa) === norm(xb), rows: rowAttrs(xa) === rowAttrs(xb), refs: refs(xa) === refs(xb), pageSetup: (/<pageSetup\b[^>]*>/.exec(xa)[0].replace(/\sr:id="[^"]*"/, "")) === (/<pageSetup\b[^>]*>/.exec(xb)[0].replace(/\sr:id="[^"]*"/, "")) });
    }
    const wbA = await A.getText("xl/workbook.xml"), wbB = await B.getText("xl/workbook.xml");
    const pas = (w) => [...w.matchAll(/<definedName name="_xlnm\.Print_Area" localSheetId="(\d+)">([^<]*)</g)].map((m) => m[1] + "=" + m[2]).sort().join(";");
    out.printAreasSame = pas(wbA) === pas(wbB);
    out.pageSetupSample = /<pageSetup\b[^>]*>/.exec(await B.getText(sheetsB[1].path))[0];

    // ---- 台帳の空欄性 ----
    // (a) 記入欄（業者欄A〜H・巡回点検の状況L・是正指示F・稼働人数O・見出しF2/E4/G4）が全シート・全頁で空
    const { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING: M } = await import("/js/report-output/renderers/mappings/anzenEiseiUchiawaseNisshi.js");
    const t = M.companiesTable; const startRow = Number(/\d+/.exec(t.startCell)[0]);
    const inputCols = Object.values(t.columns).map((d) => (typeof d === "string" ? d : d.column)).concat([t.signatureColumn]);
    const inputCells = new Set(["F2", "E4", "G4", M.patrolChecklist.commentCell, M.staffAttendance.headcountCell, ...Object.values(M.patrolChecklist.itemCells)]);
    for (let rr = startRow; rr < startRow + t.maxRows; rr++) for (const c of inputCols) inputCells.add(c + rr);
    const nonEmptyInputs = [];
    for (let i = 1; i < sheetsB.length; i++) {
      for (const c of readSheetCells(await B.getText(sheetsB[i].path), ssB).values()) {
        if (c.formula || c.value == null || c.value === "") continue;
        if (inputCells.has(c.col + (((c.row - 1) % 52) + 1))) nonEmptyInputs.push(sheetsB[i].name + "!" + c.col + c.row);
      }
    }
    out.nonEmptyInputs = nonEmptyInputs;
    // (b) 2頁目以降の固定文言は、元から記入例の無い最終シートと同一（1頁目のM・N列は直接入力、以降は数式という原本の作りなので除く）
    const fixedText = async (idx) => {
      const m = new Map();
      for (const c of readSheetCells(await B.getText(sheetsB[idx].path), ssB).values()) {
        if (c.formula || c.value == null || c.value === "" || c.row <= 52) continue;
        m.set(c.col + (((c.row - 1) % 52) + 1) + "#" + Math.floor((c.row - 1) / 52), c.value);
      }
      return m;
    };
    const f1 = await fixedText(1), f9 = await fixedText(sheetsB.length - 1);
    out.blankFormDiff = [...new Set([...f1.keys(), ...f9.keys()])].filter((k) => f1.get(k) !== f9.get(k));

    // ---- 漏れ検査（全パートのテキスト・バイト列）----
    // 原本から取り出した「残ってはいけない語」（前の工事の記入例・作成者・社内パス・会社名など。コードには書かない）
    const words = [...leakWords, "absPath"];
    const leaks = [];
    for (const p of B.listParts()) {
      const bytes = await B.getBytes(p);
      const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const u16 = new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(0, bytes.length - (bytes.length % 2)));
      const u16b = new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(1, bytes.length - ((bytes.length - 1) % 2)));
      for (const w of words) if (utf8.includes(w) || u16.includes(w) || u16b.includes(w)) leaks.push(`${p}:${w}`);
    }
    out.leaks = leaks;
    out.core = await B.getText("docProps/core.xml");
    out.comments = (await B.getText("xl/comments1.xml")).match(/<author>[^<]*<\/author>/g);
    out.heading = ssB.filter((s) => removeTexts.some((t) => s.includes(t)));
    out.headingNow = ssB.filter((s) => s.includes("建築工事日誌"));
    out.calc = /<calcPr[^>]*>/.exec(wbB)?.[0];
    out.externalRefs = /externalReference/.test(wbB);
    return out;
  }, { a64: original.toString("base64"), b64: clean.toString("base64"), leakWords, removeTexts: REMOVE_TEXTS });

  check("0 原本のSHA-256は不変", sha(fs.readFileSync(TEMPLATE)) === H0);
  check("1 シート構成が原本と同じ（様式シート＋台帳9枚）", r.sheetNames[0] === r.sheetNames[1], r.sheetNames[1]);
  check("1 台帳構造が原本と同じ（1頁52行・1シート20頁・シート名・範囲）", r.ledgerShape[0] === r.ledgerShape[1], r.ledgerShape[1]);
  check("2 書式(styles)・テーマ・図形(drawing)・画像はバイト単位で原本と同一", Object.keys(r.unchangedRequired).length > 10 && Object.values(r.unchangedRequired).every(Boolean), Object.entries(r.unchangedRequired).filter(([, v]) => !v).map(([k]) => k).join(",") || `${Object.keys(r.unchangedRequired).length}パート`);
  check("2 追加されたパートは無い", r.addedParts.length === 0, r.addedParts.join(","));
  const okRemoved = r.removedParts.every((p) => /printerSettings\d+\.bin$|externalLinks\/|calcChain\.xml$/.test(p));
  check("3 削除したパートは、プリンター情報・外部リンク・計算順キャッシュだけ", okRemoved, `${r.removedParts.length}件: ${[...new Set(r.removedParts.map((p) => p.replace(/\d+/g, "N")))].join(", ")}`);
  check("4 全セルの書式(s)・数式（式・共有・範囲）は原本と一致し、セルの有無も同じ", r.cellDiff.styleDiff === 0 && r.cellDiff.formulaDiff === 0 && r.cellDiff.keyDiff === 0, JSON.stringify({ sheets: r.cellDiff.sheets, cells: r.cellDiff.cells, formulas: r.cellDiff.formulaTotal }));
  check("4 値が変わったセルは、記入例を空にしたもの（283件）と、見出しから指定の文言（会社名）だけを消したもの（様式1＋台帳180頁＝181件）だけ。それ以外の値は原本と同一", r.cellDiff.valueDiffToBlank === 283 && r.cellDiff.valueDiffCompanyRemoved === 181 && r.cellDiff.valueDiff === 283 + 181, `${r.cellDiff.valueDiff}件（空に: ${r.cellDiff.valueDiffToBlank}・会社名削除: ${r.cellDiff.valueDiffCompanyRemoved}）`);
  check("4 数式の表示値(キャッシュ)は前工事名などを含む分だけ更新（数式そのものは同一）", r.cellDiff.cacheDiff > 0 && r.cellDiff.cacheDiff < r.cellDiff.formulaTotal, `${r.cellDiff.cacheDiff}/${r.cellDiff.formulaTotal}`);
  check("5 列幅・行の高さ・結合・入力規則・図形参照・印刷設定(pageSetup)・余白などシートのセル以外は全シート原本と同一", r.sheetFrame.every((s) => s.frame && s.rows && s.refs && s.pageSetup), r.sheetFrame.filter((s) => !(s.frame && s.rows && s.refs && s.pageSetup)).map((s) => s.name).join(","));
  check("5 印刷範囲（Print_Area）は全シート原本と同一・用紙A3横は保持", r.printAreasSame && /paperSize="8"/.test(r.pageSetupSample) && /orientation="landscape"/.test(r.pageSetupSample), r.pageSetupSample);
  check("6 記入欄（業者欄・巡回点検・是正指示・稼働人数・工事名・日付）は全シート・全頁で空", r.nonEmptyInputs.length === 0, r.nonEmptyInputs.slice(0, 5).join(","));
  check("6 台帳1枚目の2頁目以降は、元から記入例の無い最終シートと同じ固定文言だけ", r.blankFormDiff.length === 0, r.blankFormDiff.slice(0, 5).join(","));
  check("7 前の工事名・業者名・作業内容・個人名・社内パス・プリンター名・指定の文言（会社名）が全パートに1件も残っていない", r.leaks.length === 0, r.leaks.join(","));
  check("7 作成者・最終更新者・最終印刷が空（core.xml）、コメントの作成者は匿名", !/<dc:creator>[^<]+|<cp:lastModifiedBy>[^<]+/.test(r.core) && !/lastPrinted/.test(r.core) && r.comments.every((a) => a === "<author>テンプレート</author>"), r.core.replace(/xmlns[^ >]*/g, "").slice(150, 330));
  check("7 保存先パス・外部リンクが無い", !/absPath/.test(r.core) && !r.externalRefs);
  check("8 様式の見出しから指定の文言（会社名）を削除し、「（建築工事日誌）」は残している", r.heading.length === 0 && r.headingNow.some((s) => s === "　（建築工事日誌）"), JSON.stringify(r.headingNow));
  check("9 開いたとき全数式を再計算する設定（fullCalcOnLoad）", /fullCalcOnLoad="1"/.test(r.calc), r.calc);

  // ---- 出力の同値性: 原本から作った出力と、クリーンから作った出力が同じ（1日出力・台帳）----
  const eq = await page.evaluate(async ({ a64, b64 }) => {
    const dec = (b) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const { renderLedgerWorkbook } = await import("/js/report-output/ledger/renderLedgerWorkbook.js");
    const { ANZEN_EISEI_LEDGER_MAPPING } = await import("/js/report-output/renderers/mappings/anzenEiseiLedger.js");
    const { buildReportOutputModel } = await import("/js/report-output/reportDataAdapter.js");
    await import("/js/report-output/renderers/index.js");
    const { getExcelRenderer } = await import("/js/report-output/rendererRegistry.js");
    const site = { id: "s", name: "同値性検証現場", clientName: "", startDate: "2026-04-01", endDate: "2026-10-31" };
    const reports = [];
    for (let d = 0; d < 214; d += 3) { const dt = new Date(Date.UTC(2026, 3, 1 + d)).toISOString().slice(0, 10); reports.push({ id: "r" + d, siteId: "s", date: dt, weather: "曇り", temperature: String(10 + (d % 15)), siteSupervisorNames: ["監督A"], patrolChecklist: { morningMeeting: "good", helmetWear: "bad" }, patrolComment: d % 2 ? "是正" : "", companies: [{ companyId: "c", companyName: "山田" + d, occupation: "とび", plannedWorkerCount: 3, actualWorkerCount: 2, workContent: "作業" + d, safetyNotes: "注意" }] }); }
    const entries = reports.map((r) => ({ date: r.date, model: buildReportOutputModel({ site, report: r }) }));
    // クリーン側で意図的に外した差（印刷設定の参照・選択セル・スクロール位置・選択タブ）は正規化して比べる
    const normSheet = (x) => x.replace(/(<pageSetup\b[^>]*?)\sr:id="[^"]*"/, "$1").replace(/<selection\b[^>]*\/>/g, "<selection/>").replace(/\stopLeftCell="[^"]*"/, "").replace(/\stabSelected="1"/, "").replace(/<legacyDrawing\b[^>]*\/>/g, "");
    const parts = async (buf) => { const p = await WorkbookPackage.open(buf); const o = new Map(); for (const s of await p.listSheets()) o.set(s.name, normSheet(await p.getText(s.path))); return { pkg: p, sheets: o }; };
    const led = async (b) => { const res = await renderLedgerWorkbook({ templateBuffer: dec(b), mapping: ANZEN_EISEI_LEDGER_MAPPING, site: { name: site.name, startDate: site.startDate, endDate: site.endDate }, entries }); return { res, ...(await parts(await res.blob.arrayBuffer())) }; };
    const la = await led(a64), lb = await led(b64);
    let ledgerSame = la.sheets.size === lb.sheets.size; const ledgerDiff = [];
    for (const [n, x] of la.sheets) if (lb.sheets.get(n) !== x) { ledgerSame = false; ledgerDiff.push(n); }
    const drawA = [], drawB = [];
    for (const p of la.pkg.listParts().filter((p) => /drawings\/drawing\d+\.xml$/.test(p)).sort()) drawA.push((await la.pkg.getText(p)).length);
    for (const p of lb.pkg.listParts().filter((p) => /drawings\/drawing\d+\.xml$/.test(p)).sort()) drawB.push((await lb.pkg.getText(p)).length);
    const one = async (b) => { const blob = new Blob([dec(b)]); const res = await getExcelRenderer("xlsx-template-patch")(buildReportOutputModel({ site, report: reports[5] }), null, null, { sourceFileBlob: blob, layoutId: "anzen-eisei-03-2" }); return parts(await res.blob.arrayBuffer()); };
    const oa = await one(a64), ob = await one(b64);
    const styleA = await oa.pkg.getText("xl/styles.xml"), styleB = await ob.pkg.getText("xl/styles.xml");
    return { ledgerSame, ledgerDiff, ledgerSheets: la.sheets.size, ledgerPages: la.res.pageCount, ledgerWarn: [la.res.warnings.length, lb.res.warnings.length], drawSame: JSON.stringify(drawA) === JSON.stringify(drawB), oneSame: oa.sheets.get("手書印刷用") === ob.sheets.get("手書印刷用"), styleSame: styleA === styleB };
  }, { a64: original.toString("base64"), b64: clean.toString("base64") });
  check("10 同じ日報データから作った台帳出力（214日・全シート）は、原本から作った場合と完全に同一", eq.ledgerSame && eq.ledgerSheets === 11, `${eq.ledgerSheets}シート ${eq.ledgerPages}頁 ${eq.ledgerDiff.join(",")}`);
  check("10 台帳の図形・1日分の出力（手書印刷用）・書式も原本から作った場合と同一", eq.drawSame && eq.oneSame && eq.styleSame, JSON.stringify([eq.drawSame, eq.oneSame, eq.styleSame]));
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
