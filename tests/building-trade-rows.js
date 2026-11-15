// 棟・工種の一覧と、日報の作業行（棟 → 工種 → 業者 → 人数 → 職長名 → 作業内容）・行ごとの職長サイン・集計・03-2・警告（2026-11-01）
//   架空データ・隔離したプロファイル・同梱の03-2。iPad 実機・Microsoft Excel 実機は自動テストでは確認できない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");
const { restoreViaUi } = require("./helpers/restore");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const DAY = "2026-10-10", DAY2 = "2026-10-11";
const VENDOR = "アオバ塗装工業", FOREMAN = "山田";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "building-trade-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dialogs = []; // 確認・入力の答え（先頭から使う）。無ければ OK
  const seen = [];
  page.on("dialog", async (d) => {
    seen.push({ type: d.type(), message: d.message() });
    const a = dialogs.shift();
    if (a === false) await d.dismiss();
    else await d.accept(typeof a === "string" ? a : undefined);
  });
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // ===== 棟・工種の一覧（データ層） =====
  const m = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js");
    const sm = await import("/js/siteMasters.js");
    const site = await createSite({ name: "棟と工種の試験現場", startDate: "2026-10-01", endDate: "2026-12-31" });
    const A = (await sm.addMasterItem(site.id, "buildings", "A棟")).item;
    const B = (await sm.addMasterItem(site.id, "buildings", "B棟")).item;
    const T = (await sm.addMasterItem(site.id, "trades", "塗装")).item;
    await sm.addMasterItem(site.id, "trades", "足場");
    const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
    const dupB = await err(() => sm.addMasterItem(site.id, "buildings", "Ａ 棟"));
    const dupT = await err(() => sm.addMasterItem(site.id, "trades", "塗装工事"));
    const dupRename = await err(() => sm.renameMasterItem(site.id, "buildings", B.id, "a棟"));
    const other = await createSite({ name: "別の現場" });
    const otherOk = (await sm.addMasterItem(other.id, "buildings", "A棟")).item.name;
    return { site: site.id, other: other.id, A: A.id, B: B.id, T: T.id, dupB, dupT, dupRename, otherOk };
  });
  check("棟: 同じ現場で同じ名前（全角・空白・大文字小文字の違い）は二重に登録できない", /すでに登録/.test(m.dupB), m.dupB);
  check("工種: 「塗装」があると「塗装工事」は同じ工種として登録できない", /すでに登録/.test(m.dupT), m.dupT);
  check("棟: 名前の変更でも、ほかの棟と同じ名前にはできない", /すでに登録/.test(m.dupRename), m.dupRename);
  check("棟の一覧は現場ごと（別の現場には同じ名前を登録できる）", m.otherOk === "A棟");

  // ===== 日報画面: 作業行（棟 → 工種 → 業者 …）・同じ業者・同じ職長で棟・工種ごとに別の行とサイン =====
  await page.goto(`${BASE}#/sites/${m.site}/report/new?date=${DAY}`); await page.waitForSelector(".company-row .buildingId");
  await page.waitForTimeout(300);
  const order = await page.evaluate(() => [...document.querySelector(".company-row").querySelectorAll("select.buildingId, input.occupation, input.companyName, input.plannedWorkerCount, input.actualWorkerCount, input.foremanName, textarea.workContent")].map((el) => el.className.split(" ")[0]));
  check("作業行の入力の順: 棟 → 工種 → 業者 → 人数 → 職長名 → 作業内容", order.join(",") === "buildingId,occupation,companyName,plannedWorkerCount,actualWorkerCount,foremanName,workContent", order.join(","));
  const opts = await page.$$eval(".company-row .buildingId option", (os) => os.map((o) => o.textContent));
  check("棟の選択肢: 未設定・現場の棟・「＋ 棟を追加…」", opts.join("|") === "（棟 未設定）|A棟|B棟|＋ 棟を追加…", opts.join("|"));

  const fillRow = async (i, { building, trade, planned, actual, content }) => {
    const row = page.locator(".company-row").nth(i);
    if (building) await row.locator(".buildingId").selectOption(building);
    await row.locator(".occupation").fill(trade);
    await row.locator(".companyName").fill(VENDOR);
    await row.locator(".plannedWorkerCount").fill(String(planned));
    await row.locator(".actualWorkerCount").fill(String(actual));
    await row.locator(".foremanName").fill(FOREMAN);
    await row.locator(".workContent").fill(content);
  };
  // 行ごとに違う形のサイン（i 本の横線を、欄の高さの違う位置に）
  const drawSig = async (i, ys) => {
    const cv = page.locator(".company-row .signatureCanvas").nth(i); await cv.scrollIntoViewIfNeeded(); const bx = await cv.boundingBox();
    for (const y of ys) { await page.mouse.move(bx.x + bx.width * 0.15, bx.y + bx.height * y); await page.mouse.down(); await page.mouse.move(bx.x + bx.width * 0.85, bx.y + bx.height * y, { steps: 8 }); await page.mouse.up(); }
  };
  await fillRow(0, { building: m.A, trade: "塗装", planned: 3, actual: 3, content: "外壁塗装" });
  await drawSig(0, [0.3]);
  await page.click("#addCompanyBtn");
  await fillRow(1, { building: m.B, trade: "塗装", planned: 2, actual: 2, content: "外壁塗装" });
  await drawSig(1, [0.5, 0.7]);
  await page.click("#addCompanyBtn");
  dialogs.push("C棟"); // 「＋ 棟を追加…」の入力
  await page.locator(".company-row").nth(2).locator(".buildingId").selectOption("__add__");
  await page.waitForFunction(() => document.querySelectorAll(".company-row")[2].querySelector(".buildingId").selectedOptions[0]?.textContent === "C棟");
  await fillRow(2, { trade: "外壁補修", planned: 1, actual: 1, content: "下地補修" });
  check("一覧に無い工種には［この工種を現場の一覧に追加］が出る", await page.locator(".company-row").nth(2).locator(".addTradeBtn").isVisible());
  await page.locator(".company-row").nth(2).locator(".addTradeBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".company-row")[2].querySelector(".addTradeBtn").hidden);
  await drawSig(2, [0.2, 0.5, 0.8]);
  // 行ごとのサインの形（線のある範囲の縦の位置を、欄の高さに対する割合で）
  const inkOf = () => page.evaluate(() => [...document.querySelectorAll(".company-row")].map((row) => {
    const c = row.querySelector(".signatureCanvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; const ys = [];
    for (let y = 0; y < c.height; y += 2) { let ink = false; for (let x = 0; x < c.width; x += 4) if (d[(y * c.width + x) * 4 + 3] > 100) { ink = true; break; } if (ink) ys.push(y / c.height); }
    const bands = []; for (const y of ys) { if (!bands.length || y - bands[bands.length - 1][1] > 0.06) bands.push([y, y]); else bands[bands.length - 1][1] = y; }
    return { id: row.dataset.companyId, bands: bands.length };
  }));
  const before = await inkOf();
  // 並べ替え: 3行目（C棟）を ▲ で2行目へ
  await page.locator(".company-row").nth(2).locator(".moveRowUpBtn").click();
  const afterMove = await inkOf();
  check("行を並べ替えても、サインは行と一緒に動く（別の行に移らない）", afterMove.map((r) => `${r.id}:${r.bands}`).join() === [before[0], before[2], before[1]].map((r) => `${r.id}:${r.bands}`).join(), JSON.stringify(afterMove));
  await page.click("#reportSaveBtn");
  await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 });
  const saved = await page.evaluate(async ([siteId, day]) => {
    const { listReportsBySite } = await import("/js/reports.js"); const { listSignaturesByReport } = await import("/js/signatures.js");
    const r = (await listReportsBySite(siteId)).find((x) => x.date === day);
    const sigs = await listSignaturesByReport(r.id);
    const bandsOf = async (blob) => { const bm = await createImageBitmap(blob); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const ys = [];
      for (let y = 0; y < c.height; y += 2) { let ink = false; for (let x = 0; x < c.width; x += 4) if (d[(y * c.width + x) * 4 + 3] > 100) { ink = true; break; } if (ink) ys.push(y / c.height); }
      const bands = []; for (const y of ys) { if (!bands.length || y - bands[bands.length - 1][1] > 0.06) bands.push([y, y]); else bands[bands.length - 1][1] = y; } return bands.length; };
    return { id: r.id, companies: r.companies.map((c) => ({ id: c.companyId, b: c.buildingId, bn: c.buildingName, t: c.occupation, tid: c.tradeId, v: c.companyName, a: c.actualWorkerCount, f: c.foremanName, w: c.workContent })),
      sigs: await Promise.all(sigs.filter((s) => s.role === "foreman").map(async (s) => ({ cid: s.companyId, bands: await bandsOf(s.imageBlob) }))) };
  }, [m.site, DAY]);
  const rows = saved.companies;
  check("保存: 同じ業者・同じ職長でも、棟・工種ごとに別の行（並べ替えた順: A棟塗装・C棟外壁補修・B棟塗装）", rows.map((r) => `${r.bn}/${r.t}/${r.v}/${r.f}`).join("|") === `A棟/塗装/${VENDOR}/${FOREMAN}|C棟/外壁補修/${VENDOR}/${FOREMAN}|B棟/塗装/${VENDOR}/${FOREMAN}`, rows.map((r) => `${r.bn}/${r.t}`).join("|"));
  check("保存: 棟の id と保存した時点の名前、工種の一覧の id（工種の名前も従来どおり保存）", rows[0].b === m.A && rows[2].b === m.B && !!rows[1].b && rows[0].tid === m.T && rows[2].tid === m.T && !!rows[1].tid && rows.every((r) => r.t));
  const bandsByCid = Object.fromEntries(saved.sigs.map((s) => [s.cid, s.bands]));
  check("職長サインは作業行ごとに3件、それぞれの行の id に保存され、形も行ごとに違う（1本・3本・2本）", saved.sigs.length === 3 && rows.map((r) => bandsByCid[r.id]).join() === "1,3,2", JSON.stringify(rows.map((r) => bandsByCid[r.id])));

  // 再読み込み: 行・サインが同じ行に戻る
  await page.goto(`${BASE}#/sites/${m.site}/report/${saved.id}`); await page.waitForSelector(".company-row .buildingId"); await page.waitForTimeout(800);
  const reload = await inkOf();
  const reloadVals = await page.$$eval(".company-row", (rs) => rs.map((r) => `${r.querySelector(".buildingId").selectedOptions[0]?.textContent}/${r.querySelector(".occupation").value}/${r.querySelector(".actualWorkerCount").value}/${r.querySelector(".foremanName").value}/${r.querySelector(".workContent").value}`));
  check("再読み込み: 棟・工種・人数・職長・作業内容が同じ行に戻る", reloadVals.join("|") === "A棟/塗装/3/山田/外壁塗装|C棟/外壁補修/1/山田/下地補修|B棟/塗装/2/山田/外壁塗装", reloadVals.join("|"));
  check("再読み込み: サインも同じ行に戻る（1本・3本・2本）", reload.map((r) => r.bands).join() === "1,3,2" && reload.map((r) => r.id).join() === rows.map((r) => r.id).join(), JSON.stringify(reload));
  // 1行のサインを消しても、ほかの行のサインは残る
  await page.locator(".company-row").nth(1).locator(".clearSignatureBtn").click(); await page.waitForTimeout(400);
  const sigLeft = await page.evaluate(async (id) => (await (await import("/js/signatures.js")).listSignaturesByReport(id)).filter((s) => s.role === "foreman").map((s) => s.companyId), saved.id);
  check("1行のサインを消しても、ほかの行のサインは残る", sigLeft.length === 2 && sigLeft.includes(rows[0].id) && sigLeft.includes(rows[2].id) && !sigLeft.includes(rows[1].id), JSON.stringify(sigLeft));

  // ===== 棟の名前の変更・使用停止で、保存済みの日報の表示・帳票は変わらない =====
  await page.evaluate(async ([s, a, b]) => { const sm = await import("/js/siteMasters.js"); await sm.renameMasterItem(s, "buildings", a, "A棟（北）"); await sm.setMasterItemActive(s, "buildings", b, false); }, [m.site, m.A, m.B]);
  await page.goto(`${BASE}#/sites/${m.site}`); await page.goto(`${BASE}#/sites/${m.site}/report/${saved.id}`); await page.waitForSelector(".company-row .buildingId"); await page.waitForTimeout(600);
  const shown = await page.$$eval(".company-row .buildingId", (ss) => ss.map((s) => s.selectedOptions[0]?.textContent));
  check("棟の名前を変えても、保存済みの日報は保存した名前で表示（現在の名前を添える）・使用停止の棟もそのまま表示", shown[0] === "A棟（現在の名前: A棟（北））" && shown[2] === "B棟（使用停止）", JSON.stringify(shown));
  await page.click("#addCompanyBtn");
  const optsNew = await page.$$eval(".company-row:last-child .buildingId option", (os) => os.map((o) => o.textContent));
  check("新しい行の選択肢には使用停止の棟は出ない（名前を変えた棟は新しい名前）", optsNew.includes("A棟（北）") && !optsNew.some((o) => o.startsWith("B棟")), optsNew.join("|"));
  await page.goto(`${BASE}#/sites/${m.site}`); // 保存しないで離れる（追加した行は保存しない）

  // ===== 03-2（Excel・PDF・台帳）: 棟は作業内容の先頭に【棟】、職種は工種だけ =====
  const out = await page.evaluate(async ([siteId, reportId]) => {
    const { getSite } = await import("/js/sites.js"); const { resolveReportTemplateForSite } = await import("/js/report-output/templateResolver.js");
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js"); const { generateLedgerWorkbook } = await import("/js/report-output/ledger/generateLedgerOutput.js");
    const z = await import("/js/zipUtil.js"); const eng = await import("/js/report-output/xlsxTemplateEngine.js"); const rp = await import("/js/reportPrint.js");
    const t = await resolveReportTemplateForSite(await getSite(siteId));
    const cellsOf = async (blob, sheetName) => {
      const zip = z.loadZip(await blob.arrayBuffer());
      const wb = await z.readZipEntryText(zip, "xl/workbook.xml"), rels = await z.readZipEntryText(zip, "xl/_rels/workbook.xml.rels");
      const p = sheetName ? eng.resolveSheetPartPath(wb, rels, sheetName) : "xl/" + new RegExp(`Id="${/<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1]}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?xl\//, "");
      const xml = await z.readZipEntryText(zip, p); const ss = (await z.readZipEntryText(zip, "xl/sharedStrings.xml")) || "";
      const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((mm) => [...mm[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
      const get = (ref) => { const mm = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(xml); if (!mm) return ""; const inner = mm[2] || ""; if (/t="s"/.test(mm[1])) return strs[+(/<v>([^<]*)<\/v>/.exec(inner) || [])[1]] || ""; return [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("") || (/<v>([^<]*)<\/v>/.exec(inner) || [])[1] || ""; };
      return get;
    };
    const ex = await generateReportOutput({ reportId, format: "excel", templateId: t.templateId });
    const g = await cellsOf(ex.blob);
    const html = (await rp.buildReportPrintHtml(reportId)).html;
    const led = await generateLedgerWorkbook({ siteId, templateId: t.templateId });
    const lg = await cellsOf(led.blob, led.sheetNames[0]);
    const off = 9 * 52; // 10/10 は工期開始日（10/1）から10日目の頁
    return { E7: g("E7"), E9: g("E9"), E11: g("E11"), B7: g("B7"), B9: g("B9"), A7: g("A7"), htmlHas: ["【A棟】外壁塗装", "【C棟】下地補修", "【B棟】外壁塗装"].map((x) => html.includes(x)), htmlNorth: html.includes("A棟（北）"), led: [lg(`E${7 + off}`), lg(`E${9 + off}`), lg(`E${11 + off}`)] };
  }, [m.site, saved.id]);
  check("03-2 Excel: 作業内容の先頭に【棟】（保存した時点の名前。名前を変えても変わらない）", out.E7 === "【A棟】外壁塗装" && out.E9 === "【C棟】下地補修" && out.E11 === "【B棟】外壁塗装", JSON.stringify([out.E7, out.E9, out.E11]));
  check("03-2 Excel: 職種の欄は工種だけ（棟を混ぜない）・業者名はそのまま", out.B7 === "塗装" && out.B9 === "外壁補修" && out.A7 === VENDOR, JSON.stringify([out.B7, out.B9, out.A7]));
  check("03-2 PDF（印刷用HTML）: 作業内容に【棟】、新しい棟の名前は出ない", out.htmlHas.every(Boolean) && !out.htmlNorth, JSON.stringify(out.htmlHas));
  check("03-2 台帳: 同じ頁の作業内容に【棟】（1日分と同じ）", out.led.join("|") === "【A棟】外壁塗装|【C棟】下地補修|【B棟】外壁塗装", out.led.join("|"));

  // ===== 集計: 棟×工種×業者（延べ人数）。棟別の合計＝全体の合計・業者数は重複しない =====
  const agg = await page.evaluate(async (reportId) => {
    const { attendanceBreakdown } = await import("/js/dashboard/attendanceBreakdown.js"); const { getReport } = await import("/js/reports.js"); const { countVendors, countTrades } = await import("/js/dashboard/siteDashboardModel.js");
    const r = await getReport(reportId);
    const a = attendanceBreakdown({ todayCompanies: r.companies, historyReports: [r] });
    return { b: a.buildings.map((x) => `${x.label}:${x.today}`), total: a.totals.today, sumB: a.buildings.reduce((s, x) => s + x.today, 0), lines: a.buildings.flatMap((x) => x.lines.map((l) => `${x.label}/${l.trade}/${l.vendor}:${l.today}`)), vendors: countVendors(r.companies), trades: countTrades(r.companies) };
  }, saved.id);
  check("集計: 棟別（A棟3・C棟1・B棟2）の合計＝全体の延べ人数6", agg.b.join() === "A棟:3,C棟:1,B棟:2" && agg.total === 6 && agg.sumB === 6, JSON.stringify(agg));
  check("集計: 棟×工種×業者の内訳", agg.lines.join() === `A棟/塗装/${VENDOR}:3,C棟/外壁補修/${VENDOR}:1,B棟/塗装/${VENDOR}:2`, agg.lines.join());
  check("集計: 同じ業者が3行にあっても業者数は1社・工種は2種", agg.vendors === 1 && agg.trades === 2, `${agg.vendors}社・${agg.trades}種`);

  // ダッシュボード（監督管理）: 棟別の延べ人数・業者別稼働の棟の列。KY は業者ごとに1件
  await page.evaluate((d) => { window.__dashboardDate = d; }, { siteId: m.site, date: DAY });
  await page.goto(`${BASE}#/sites/${m.site}/edit`); await page.goto(`${BASE}#/sites/${m.site}`);
  await page.waitForSelector('#siteDashboard .dash-tab[data-tab="manage"]', { timeout: 15000 });
  await page.click('#siteDashboard .dash-tab[data-tab="manage"]'); await page.waitForTimeout(300);
  const dash = await page.evaluate(() => ({ date: document.querySelector("#siteDashboard input[type=date]")?.value || "", card: document.querySelector(".dash-buildings")?.innerText || "", vend: [...document.querySelectorAll(".dash-vendors thead th")].map((t) => t.textContent) }));
  check("ダッシュボード（監督管理）: 棟別の延べ人数の表（棟ごとの計と工種・業者）", /A棟[\s\S]*3人/.test(dash.card) && /B棟[\s\S]*2人/.test(dash.card) && dash.card.includes(`外壁補修・${VENDOR}`), JSON.stringify({ card: dash.card.slice(0, 200), date: dash.date }));
  check("ダッシュボード: 業者別稼働に棟の列・人数は「延べ人数」", dash.vend.join(",") === "棟,業者,工種,延べ人数,作業時間,人工,累計人工", dash.vend.join(","));
  // 工種別の延べ人数（棟・業者ごと。2026-11-15）: 同じ工種でも棟・業者が違えば別の行
  const tb = await page.evaluate(() => [...document.querySelectorAll(".dash-trade-breakdown tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent.trim()).join("|")));
  check("ダッシュボード（監督管理）: 工種別の延べ人数を棟・業者ごとに分ける（塗装＝A棟3人・B棟2人、外壁補修＝C棟1人）",
    tb.some((r) => r.startsWith("塗装|計（2組）|5人")) && tb.includes(`|A棟|${VENDOR}|3人|3人`) && tb.includes(`|B棟|${VENDOR}|2人|2人`) && tb.some((r) => r.startsWith("外壁補修|計（1組）|1人")) && tb.includes(`|C棟|${VENDOR}|1人|1人`), JSON.stringify(tb));
  await waitForAsync(page, async ([s, d]) => { const l = await (await import("/js/ky/kySubmissions.js")).listKySubmissions(s, d); return l.length ? l.map((x) => x.vendorName) : null; }, [m.site, DAY], { timeout: 10000 }).catch(() => null);
  const kyList = await page.evaluate(async ([s, d]) => (await (await import("/js/ky/kySubmissions.js")).listKySubmissions(s, d)).filter((x) => !x.removed).map((x) => x.vendorName), [m.site, DAY]);
  check("KY: 同じ業者が3つの作業行にあっても、提出対象は業者ごとに1件", kyList.length === 1 && kyList[0] === VENDOR, JSON.stringify(kyList));

  // ===== 業者管理: 業者×職種の明細に棟ごとの内訳（2026-11-15） =====
  await page.goto(`${BASE}#/sites/${m.site}/vendors`); await page.waitForSelector("#vendorMgmtMonth"); await page.waitForTimeout(300);
  if ((await page.$eval("#vendorMgmtMonth", (el) => el.value)) !== "2026-10") { await page.selectOption("#vendorMgmtMonth", "2026-10"); await page.waitForTimeout(400); }
  const vmLines = await page.evaluate(() => [...document.querySelectorAll(".vm-line .vm-line-name")].map((td) => td.innerText.replace(/\s+/g, " ").trim()));
  check("業者管理（業者別稼働）: 塗装の明細の下に棟ごとの内訳（この月・累計）", vmLines.some((t) => t.includes("塗装") && t.includes("棟別（この月）: A棟 3・B棟 2") && t.includes("棟別（累計）: A棟 3・B棟 2")) && vmLines.some((t) => t.includes("外壁補修") && t.includes("C棟 1")), JSON.stringify(vmLines.filter((t) => /塗装|外壁補修/.test(t)).slice(0, 3)));
  const vt = await page.evaluate(async () => {
    const { vendorTradeLines, buildMonthlyBilling } = await import("/js/billing/billingMonthly.js");
    const rep = (date, companies) => ({ id: date, date, dayStatus: "work", companies });
    const reports = [rep("2026-10-20", [
      { companyId: "x1", buildingId: "bA", buildingName: "A棟", companyName: "X塗装", occupation: "塗装", actualWorkerCount: "3", billingManDays: "3" },
      { companyId: "y1", buildingId: "bB", buildingName: "B棟", companyName: "Y塗装", occupation: "塗装", actualWorkerCount: "2", billingManDays: "2.5" },
      { companyId: "x2", buildingId: "bB", buildingName: "B棟", companyName: "X塗装", occupation: "塗装", actualWorkerCount: "1", billingManDays: "1" },
      { companyId: "z1", companyName: "Z足場", occupation: "足場", actualWorkerCount: "4", billingManDays: "4" }])];
    const lines = vendorTradeLines({ reports, include: () => true, valueOf: (c) => Number(c.actualWorkerCount) });
    const b = buildMonthlyBilling({ reports, site: null, month: "2026-10", today: "2026-10-31" });
    const fmt = (l) => `${l.trade}:${l.value}[${l.buildings.map((x) => `${x.label}${x.value}`).join(",")}]`;
    return { X: (lines.get("X塗装") || []).map(fmt), Y: (lines.get("Y塗装") || []).map(fmt), Z: (lines.get("Z足場") || []).map(fmt), billX: b.rows.find((r) => r.vendor === "X塗装")?.lines.map((l) => `${l.manDays}[${l.buildings.map((x) => `${x.label}${x.value}`).join(",")}]`) };
  });
  check("業者管理の集計: 棟ごとに業者が違っても、業者×職種の明細の中で棟ごとに分かれる（合計は変わらない）・棟の無い明細は内訳なし・請求人工も同じ",
    JSON.stringify(vt.X) === JSON.stringify(["塗装:4[A棟3,B棟1]"]) && JSON.stringify(vt.Y) === JSON.stringify(["塗装:2[B棟2]"]) && JSON.stringify(vt.Z) === JSON.stringify(["足場:4[]"]) && JSON.stringify(vt.billX) === JSON.stringify(["4[A棟3,B棟1]"]), JSON.stringify(vt));

  // ===== 帳票に書けない行（協力会社欄14行・稼動人数表の空き行6行）を、画面に警告する =====
  const id2 = await page.evaluate(async ([siteId, day, A]) => {
    const { createReport } = await import("/js/reports.js");
    const companies = Array.from({ length: 16 }, (_, i) => ({ companyId: `o${i}`, buildingId: i % 2 ? A : "", buildingName: i % 2 ? "A棟" : "", companyName: `協力${i + 1}`, occupation: i < 8 ? `特殊作業${i + 1}` : "塗装", actualWorkerCount: "1", workContent: "作業" }));
    return (await createReport({ siteId, date: day, dayStatus: "work", weather: "晴れ", companies })).id;
  }, [m.site, DAY2, m.A]);
  await page.goto(`${BASE}#/sites/${m.site}/report/${id2}`); await page.waitForSelector("#reportExcelBtn");
  let downloaded = false; const onDl = () => { downloaded = true; }; page.on("download", onDl);
  seen.length = 0; dialogs.push(false); // 確認で「キャンセル」
  await page.click("#reportExcelBtn"); await page.waitForTimeout(1500);
  const conf = seen.find((d) => d.type === "confirm")?.message || "";
  check("日報画面の Excel: 出力の前に、書けない行（15行目・16行目の棟／工種／業者・人数）と、稼動人数表に出せない業種を確認する", /15行目（A棟／塗装／協力16|15行目/.test(conf) && conf.includes("16行目") && conf.includes("協力15") && conf.includes("業種「") && conf.includes("日報のデータは消えていません"), conf.slice(0, 200));
  check("確認で出力をやめると、ダウンロードしない", !downloaded);
  page.off("download", onDl);
  await page.click("#reportPdfBtn"); await page.waitForFunction(() => document.getElementById("reportPrintDialog").open);
  const warnBox = await page.evaluate(() => { const el = document.getElementById("reportPrintWarnings"); return el.hidden ? "" : el.textContent; });
  check("日報画面の工事日報PDF: 印刷ダイアログの上に、書けない行の警告", warnBox.includes("15行目") && warnBox.includes("16行目") && warnBox.includes("日報のデータは消えていません"), warnBox.slice(0, 120));
  await page.click("#reportPrintCloseBtn");
  const bulk = await page.evaluate(async (ids) => (await (await import("/js/reportPrint.js")).buildReportsPrintHtml(ids, "まとめて")).warnings, [saved.id, id2]);
  check("まとめて印刷・PDF: 日報ごとの警告に日付が付く（警告の無い日報は出ない）", bulk.some((w) => w.startsWith(`${DAY2}: 協力会社欄`)) && !bulk.some((w) => w.startsWith(DAY)), bulk.slice(0, 2).join(" / "));
  const ledW = await page.evaluate(async (s) => { const { getSite } = await import("/js/sites.js"); const t = await (await import("/js/report-output/templateResolver.js")).resolveReportTemplateForSite(await getSite(s)); return (await (await import("/js/report-output/ledger/generateLedgerOutput.js")).generateLedgerWorkbook({ siteId: s, templateId: t.templateId })).warnings; }, m.site);
  check("台帳: 同じ警告（日付つき）", ledW.some((w) => w.startsWith(`${DAY2}: 協力会社欄`) && w.includes("16行目")), ledW.find((w) => w.includes("協力会社欄"))?.slice(0, 80) || "");

  // ===== 現場の編集画面: 棟・工種の一覧（登録・使用停止の表示・過去の日報の工種から確認して登録） =====
  await page.goto(`${BASE}#/sites/${m.site}/edit`); await page.waitForSelector("#siteMastersSection:not([hidden])");
  await page.waitForTimeout(300);
  const ui = await page.evaluate(() => ({ b: [...document.querySelectorAll('.site-master[data-kind="buildings"] li')].map((li) => li.textContent.replace(/\s+/g, " ").trim().split(" ")[0] + (li.classList.contains("is-inactive") ? "（停止）" : "")), cands: [...document.querySelectorAll(".cand-item")].map((l) => l.textContent.trim().split(" ")[0]) }));
  check("現場の編集画面: 棟の一覧（使用停止も表示）", ui.b.join() === "A棟（北）,B棟（停止）,C棟", ui.b.join());
  check("過去の日報の工種のうち一覧に無いものを候補に出す（自動では登録しない）", ui.cands.includes("特殊作業1") && !ui.cands.includes("塗装") && !ui.cands.includes("外壁補修"), ui.cands.slice(0, 4).join());
  await page.evaluate(() => { document.querySelector(".trade-candidates").open = true; });
  await page.locator(".cand-item input").first().check(); await page.click(".cand-add"); await page.waitForTimeout(400);
  const trades = await page.evaluate(async (s) => (await (await import("/js/sites.js")).getSite(s)).trades.map((t) => t.name), m.site);
  check("選んだ工種だけを一覧に登録する", trades.includes("特殊作業1") && !trades.includes("特殊作業2"), trades.join());
  await page.fill('.site-master[data-kind="buildings"] .master-new', "ａ棟（北）"); await page.click('.site-master[data-kind="buildings"] .master-add'); await page.waitForTimeout(300);
  const nb = await page.evaluate(async (s) => (await (await import("/js/sites.js")).getSite(s)).buildings.length, m.site);
  check("画面からも、表記ゆれの同じ棟は登録しない", nb === 3, String(nb));

  // ===== バックアップ・復元: 棟・工種・作業行・署名・KY が残る =====
  const zipB64 = await page.evaluate(async () => { const { blob } = await (await import("/js/backup.js")).exportFullBackup(); const u = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
  const zipPath = path.join(dir, "bt.zip"); fs.writeFileSync(zipPath, Buffer.from(zipB64, "base64"));
  const ctxE = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "building-trade-empty-")), { acceptDownloads: true });
  const pe = await ctxE.newPage(); pe.on("dialog", (d) => d.accept());
  await pe.goto(`${BASE}#/backup`); await pe.waitForSelector("#view-backup:not([hidden])");
  await restoreViaUi(pe, zipPath);
  const rest = await pe.evaluate(async ([s, rid]) => {
    const { getSite } = await import("/js/sites.js"); const { getReport } = await import("/js/reports.js"); const { listSignaturesByReport } = await import("/js/signatures.js"); const ky = await import("/js/ky/kySubmissions.js");
    const site = await getSite(s); const r = await getReport(rid);
    return { b: (site.buildings || []).map((x) => `${x.name}${x.active === false ? "（停止）" : ""}`), t: (site.trades || []).length, rows: r.companies.map((c) => `${c.buildingName}/${c.occupation}`), sigs: (await listSignaturesByReport(rid)).filter((x) => x.role === "foreman").length, ky: (await ky.listKySubmissionsBySite(s)).length };
  }, [m.site, saved.id]);
  check("バックアップ・復元: 棟の一覧（使用停止を含む）・工種の一覧・作業行の棟と工種・行ごとのサイン・KY が残る", rest.b.join() === "A棟（北）,B棟（停止）,C棟" && rest.t >= 4 && rest.rows.join("|") === "A棟/塗装|C棟/外壁補修|B棟/塗装" && rest.sigs === 2 && rest.ky >= 1, JSON.stringify(rest));
  await ctxE.close();

  // ===== 以前の日報（棟の項目が無い）: そのまま表示・集計・出力できる（推測で棟を入れない） =====
  const legacy = await page.evaluate(async (siteId) => {
    const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const r = stampNew({ siteId, date: "2026-10-12", dayStatus: "work", weather: "晴れ", companies: [{ companyId: "L1", companyName: "イズミ足場工業", occupation: "足場", actualWorkerCount: "4", workContent: "TA号棟 足場組立" }] });
    await dbPut("reports", r);
    const { attendanceBreakdown } = await import("/js/dashboard/attendanceBreakdown.js");
    const a = attendanceBreakdown({ todayCompanies: r.companies, historyReports: [r] });
    const html = (await (await import("/js/reportPrint.js")).buildReportPrintHtml(r.id)).html;
    return { id: r.id, b: a.buildings.map((x) => `${x.label}:${x.today}`), html: html.includes("TA号棟 足場組立") && !html.includes("【") };
  }, m.site);
  check("以前の日報（棟なし）: 棟は「（棟未設定）」で集計し、作業内容の「TA号棟」から推測しない・03-2に【】を付けない", legacy.b.join() === "（棟未設定）:4" && legacy.html, JSON.stringify(legacy));
  await page.goto(`${BASE}#/sites/${m.site}/report/${legacy.id}`); await page.waitForSelector(".company-row .buildingId"); await page.waitForTimeout(400);
  check("以前の日報（棟なし）: 日報画面で「（棟 未設定）」のまま開ける", (await page.$eval(".company-row .buildingId", (s) => s.selectedOptions[0]?.textContent)) === "（棟 未設定）");

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
