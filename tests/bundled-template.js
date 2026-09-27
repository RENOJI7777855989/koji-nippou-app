// 暗号化して同梱した標準テンプレート（クリーンな03-2）とセットアップリンクの検証
//  1 Gitに平文xlsxが無い 2 Git履歴にも無い 3 公開URLから平文xlsxを取得できない 4 公開ソースから03-2を復元できない
//  5 セットアップリンクを1回開くだけで登録 6 以後は鍵入力なしで出力 7 オフラインで出力 8 サイトデータ削除後の復旧
//  9 既存現場は旧版のまま 10 新規現場だけ新しい版  ＋ 誤ったリンク・改ざん・既存端末への非影響・削除後の非復活
// 実行: 静的サーバー（http://localhost:8934）を起動し、tools/build-clean-template.js で暗号化ファイルと鍵を作った状態で
//   node tests/bundled-template.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");
const { loadKey, manifestEntry, decryptBundled, encryptLike, setupUrl, ASSETS } = require("./helpers/templateKey.js");

const BASE = "http://localhost:8934/index.html";
const REPO = path.join(__dirname, "..");
const PAGES = process.env.PAGES_URL || "https://renoji7777855989.github.io/koji-nippou-app/";
const { ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal } = require("./helpers/localConfig.js"); // 原本の場所・消す文言はリポジトリの外の設定から
const ORIGINAL = ORIGINAL_TEMPLATE;
const GIT = ["/Applications/Xcode.app/Contents/Developer/usr/bin/git", "git"].find((g) => { try { execFileSync(g, ["--version"], { stdio: "pipe" }); return true; } catch { return false; } });
const OUT = process.env.TEST_OUT_DIR || path.join(require("os").tmpdir(), "bundled-template-test");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const git = (...args) => execFileSync(GIT, args, { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();

(async () => {
  const KEY = loadKey();
  const entry = manifestEntry();
  const plain = decryptBundled(); // メモリ上だけ。ファイルには書き出さない
  const encBytes = fs.readFileSync(path.join(ASSETS, entry.fileName));

  // ===== 1〜4. 公開される物の確認 =====
  if (GIT) {
    const tracked = git("ls-files").split("\n").filter(Boolean);
    const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean); // .gitignoreで除外されない未追跡
    const candidates = [...tracked, ...untracked];
    check("1 Gitの追跡対象・コミット候補（.gitignoreで除外されない未追跡）に平文の .xlsx が1つも無い", !candidates.some((f) => /\.xls[xm]?$/i.test(f)), candidates.filter((f) => /\.xls/i.test(f)).join(",") || `${candidates.length}ファイル中0件`);
    check("1 コミット候補に暗号化ファイルと一覧だけがある（assets/templates）", candidates.filter((f) => f.startsWith("assets/templates/")).sort().join(",") === ["assets/templates/anzen-eisei-03-2.xlsx.enc", "assets/templates/manifest.json"].join(","), candidates.filter((f) => f.startsWith("assets/")).join(","));
    let ignoredOk = true;
    for (const f of ["assets/templates/anzen-eisei-03-2.xlsx", "03-2安全衛生作業打合日誌.xlsx", "template-key.json", "setup-link.txt"]) { try { git("check-ignore", "-q", f); } catch { ignoredOk = false; } }
    check("1 平文の .xlsx・鍵ファイル・セットアップリンクは .gitignore で除外される（誤ってコミットできない）", ignoredOk);
    const objects = git("rev-list", "--all", "--objects");
    const blobOf = (buf) => execFileSync(GIT, ["hash-object", "--stdin"], { input: buf, cwd: REPO }).toString().trim();
    const hasObject = (id) => { try { git("cat-file", "-e", id); return true; } catch { return false; } };
    const origBlob = fs.existsSync(ORIGINAL) ? blobOf(fs.readFileSync(ORIGINAL)) : null;
    check("2 Git履歴（全コミット）に .xlsx のファイル名が無い", !/\.xls[xm]?\b/i.test(objects), `${git("rev-list", "--all").split("\n").filter(Boolean).length}コミット`);
    check("2 Gitのオブジェクトに、平文のクリーン版・原本の中身が1つも無い（中身のハッシュで照合）", !hasObject(blobOf(plain)) && (!origBlob || !hasObject(origBlob)));
  } else {
    check("1・2 Gitの確認（gitコマンドが使えないため未確認）", false, "gitが見つかりません");
  }
  const localPlain = await fetch(new URL("assets/templates/anzen-eisei-03-2.xlsx", BASE)).then((r) => r.status);
  const localEnc = await fetch(new URL(`assets/templates/${entry.fileName}`, BASE)).then(async (r) => ({ status: r.status, head: Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString("latin1") }));
  check("3 アプリの配信フォルダに平文のxlsxは無い（404）。配信されるのは暗号化ファイルだけで、Excel（zip）として開けない", localPlain === 404 && localEnc.status === 200 && localEnc.head !== "PK", JSON.stringify({ localPlain, localEnc }));
  const pagesPlain = await fetch(PAGES + "assets/templates/anzen-eisei-03-2.xlsx").then((r) => r.status).catch((e) => `取得不可 ${e.message}`);
  check("3 公開中のGitHub PagesのURLから平文xlsxを取得できない（現在の公開版）", pagesPlain === 404, String(pagesPlain));
  // 公開される全ファイル（Gitのコミット候補）に鍵が含まれない
  let keyFound = [];
  const files = GIT ? [...git("ls-files").split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean) : [];
  for (const f of files) { const p = path.join(REPO, f); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue; const b = fs.readFileSync(p); if (b.includes(KEY) || b.includes(Buffer.from(KEY, "base64url"))) keyFound.push(f); }
  check("4 公開されるファイル（ソースコード・一覧・暗号化ファイル）に復号鍵が含まれない", files.length > 0 && keyFound.length === 0, keyFound.join(",") || `${files.length}ファイルを検査`);
  let wrongKeyFails = false;
  try { decryptBundled("anzen-eisei-03-2", crypto.randomBytes(32).toString("base64url")); } catch { wrongKeyFails = true; }
  check("4 鍵が無ければ（別の鍵では）暗号化ファイルを復号できない", wrongKeyFails);
  check("4 同梱の平文（復号結果）はmanifestの指紋と一致し、暗号化ファイルの指紋も一致", sha(plain) === entry.sha256 && sha(encBytes) === entry.cipherSha256);

  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (ctx) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    // テストで意図的に起こすもの（SWを無効化した端末での登録エラー、通信の遮断・改ざんの再現）は除く
    p.on("console", (m) => m.type() === "error" && !/Service Workerの登録に失敗|ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(m.text()));
    p.on("dialog", (d) => { p.__dialogs = (p.__dialogs || []).concat(d.message()); d.accept(); });
    return p;
  };
  const templates = (p) => p.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")));
  const live = async (p) => (await templates(p)).filter((t) => !t.isDeleted && (t.templateKind || "report") === "report");
  const waitRegistered = (p) => waitForAsync(p, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 20000 });
  const message = (p) => p.evaluate(() => document.getElementById("message")?.textContent || "");
  const exportExcel = async (p, reportId, name) => {
    const [dl] = await Promise.all([p.waitForEvent("download"), p.evaluate(async (id) => (await import("/js/reportPrint.js")).exportReportExcel(id), reportId)]);
    const f = path.join(OUT, name); await dl.saveAs(f);
    return p.evaluate(async ({ b64, words }) => {
      const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const pkg = await WorkbookPackage.open(u.buffer);
      const sst = await pkg.getText("xl/sharedStrings.xml");
      return { sheets: (await pkg.listSheets()).map((s) => s.name), v: sst.includes("巡回点検記録（第2版）") ? 2 : 1, work: (await pkg.getText("xl/worksheets/sheet1.xml")).includes("鍵なし出力確認"), leak: words.some((w) => sst.includes(w)) };
    }, { b64: fs.readFileSync(f).toString("base64"), words: LEAK });
  };
  const makeSiteAndReport = (p, name) => p.evaluate(async (name) => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const s = await createSite({ name, startDate: "2026-04-01", endDate: "2026-04-30" });
    const r = await createReport({ siteId: s.id, date: "2026-04-02", weather: "晴れ", temperature: "18", siteSupervisorNames: ["監督A"], companies: [{ companyId: "c", companyName: "鍵なし出力確認工業", occupation: "とび", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: "鍵なし出力確認", safetyNotes: "" }] });
    return { siteId: s.id, reportId: r.id, pin: s.templatePin || null };
  }, name);

  // ===== 5. 新しい端末: リンクなしでは登録されない → セットアップリンクを1回開くだけで登録 =====
  const ctx = await browser.newContext({ acceptDownloads: true });
  const p = await newPage(ctx);
  await p.goto(BASE); await p.waitForSelector("#view-site-list:not([hidden])"); await p.waitForTimeout(1500);
  const LEAK = await leakWordsFromOriginal(p); // 出力に残ってはいけない語（実行時に原本から取り出す）
  check("5 リンクを開く前の新しい端末には、同梱テンプレートは登録されない（鍵が無い）", (await live(p)).length === 0);
  await p.goto(`${BASE}#/report-templates`); await p.waitForSelector("#view-report-templates:not([hidden])");
  await p.waitForSelector("#bundledTemplateSection:not([hidden])");
  check("5 管理画面に「セットアップリンクを開くか、貼り付けて登録」の案内と入力欄が出る", (await p.textContent("#bundledTemplateSection")).includes("セットアップリンク") && (await p.locator(".bundledSetupInput").count()) === 1);
  await p.goto(setupUrl(BASE, KEY));
  await p.waitForSelector("#view-site-list:not([hidden])");
  await waitRegistered(p);
  const reg = (await live(p)).find((t) => t.bundledId);
  const hrefAfter = await p.evaluate(() => location.href);
  check("5 セットアップリンクを1回開くだけで、03-2が標準テンプレートとして登録される", !!reg && reg.isAppDefault && reg.layoutId === "anzen-eisei-03-2" && reg.sourceFileSha256 === entry.sha256, reg && `${reg.name} 第${reg.revision}版`);
  check("5 登録後、画面のアドレスから鍵が消える（#/sites に置き換え）", !hrefAfter.includes(KEY) && hrefAfter.endsWith("#/sites"), hrefAfter.replace(KEY, "<鍵>"));
  const stored = await p.evaluate(async () => { const m = await (await import("/js/db.js")).dbGet("meta", "bundledTemplateKey"); return { keyId: m?.keyId, hasKey: !!m?.value, ls: JSON.stringify(localStorage), ss: JSON.stringify(sessionStorage) }; });
  check("5 鍵はこの端末のIndexedDBにだけ保存（localStorage・sessionStorageには無い）", stored.hasKey && stored.keyId === entry.keyId && !stored.ls.includes(KEY) && !stored.ss.includes(KEY));
  await p.waitForFunction(() => /登録しました/.test(document.getElementById("message")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("5 登録できたことが画面に表示される", (await message(p)).includes("登録しました"), (await message(p)).slice(0, 60));

  // ===== 6. 以後は鍵の入力なしで出力 =====
  await p.goto(BASE); await p.waitForSelector("#view-site-list:not([hidden])");
  const A = await makeSiteAndReport(p, "現場A（第1版）");
  const outA = await exportExcel(p, A.reportId, "A.xlsx");
  check("6 リンクを開き直さず（鍵の入力なし）、新規現場の日報を03-2でExcel出力できる", A.pin?.sha256 === entry.sha256 && outA.sheets[0] === "手書印刷用" && outA.work && !outA.leak, JSON.stringify(outA));

  // ===== 7. オフラインで出力（登録後）=====
  await waitForAsync(p, async () => !!(await navigator.serviceWorker.ready) && !!(await caches.match("./assets/templates/anzen-eisei-03-2.xlsx.enc")), null, { timeout: 20000 });
  await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector("#view-site-list:not([hidden])");
  const offline = await p.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js");
    const { generateReportOutput } = await import("/js/report-output/generateReportOutput.js");
    const { resolveCompanyTemplateForSite } = await import("/js/reportPrint.js");
    const s = await createSite({ name: "オフライン現場", startDate: "2026-05-01" });
    const r = await createReport({ siteId: s.id, date: "2026-05-01", companies: [{ companyId: "c", companyName: "オフライン工業", workContent: "オフライン作業" }] });
    const c = await resolveCompanyTemplateForSite(s);
    const res = await generateReportOutput({ reportId: r.id, format: "excel", templateId: c.templateId });
    return { online: navigator.onLine, name: c.templateName, size: res.blob.size };
  });
  check("7 オフラインでも（鍵の入力なしで）新規現場の日報を03-2でExcel出力できる", offline.online === false && offline.name.includes("03-2") && offline.size > 30000, JSON.stringify(offline));
  await ctx.setOffline(false);

  // ===== 9・10. 同梱の新しい版（同じ鍵）: 既存現場は旧版のまま、新規現場だけ新しい版 =====
  const v2 = await p.evaluate(async (b64) => {
    const { WorkbookPackage } = await import("/js/report-output/ledger/workbookPackage.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const pkg = await WorkbookPackage.open(u.buffer);
    pkg.setText("xl/sharedStrings.xml", (await pkg.getText("xl/sharedStrings.xml")).replace("巡回点検記録", "巡回点検記録（第2版）"));
    const buf = new Uint8Array(await (await pkg.toCompressedBlob()).arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, plain.toString("base64"));
  const v2Plain = Buffer.from(v2, "base64");
  const v2Enc = encryptLike(entry.id, v2Plain, KEY);
  const v2Manifest = { templates: [{ ...entry, iv: v2Enc.iv, sha256: sha(v2Plain), cipherSha256: sha(v2Enc.enc), bundleVersion: (entry.bundleVersion || 1) + 1 }] };
  await ctx.route("**/assets/templates/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(v2Manifest) }));
  await ctx.route(`**/assets/templates/${entry.fileName}`, (r) => r.fulfill({ contentType: "application/octet-stream", body: v2Enc.enc }));
  await p.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); });
  await p.goto(`${BASE}#/report-templates`); await p.reload(); await p.waitForSelector("#view-report-templates:not([hidden])");
  await p.waitForFunction(() => /新しい版/.test(document.getElementById("bundledTemplateSection").textContent), null, { timeout: 10000 }).catch(() => {});
  const ui9 = await p.textContent("#bundledTemplateSection");
  check("9 同梱の新しい版は、自動では置き換えず「更新あり」と表示する（同じ鍵なのでリンクの開き直しは不要）", ui9.includes("新しい版") && (await p.locator(".bundledTemplateActionBtn").count()) === 1 && !ui9.includes("別の鍵"), ui9.replace(/\s+/g, " ").slice(0, 80));
  p.__dialogs = [];
  await p.locator(".bundledTemplateActionBtn").click();
  await waitForAsync(p, async () => (await (await import("/js/db.js")).dbGet("reportTemplates", "bundled-anzen-eisei-03-2"))?.revision === 2, null, { timeout: 20000 });
  check("9 更新前の確認に、既存の現場は固定した版のまま変わらない旨と文言の違いが出る", (p.__dialogs || []).some((m) => m.includes("既に作成した現場") && m.includes("固定文言")), JSON.stringify(p.__dialogs || []).slice(0, 600));
  const outA2 = await exportExcel(p, A.reportId, "A_after_update.xlsx");
  check("9 標準を新しい版に更新しても、既存の現場Aは旧版（第1版）のまま出力される", outA2.v === 1);
  const B = await makeSiteAndReport(p, "現場B（第2版）");
  const outB = await exportExcel(p, B.reportId, "B.xlsx");
  check("10 更新後に作成した現場Bだけが新しい版（第2版）になる", B.pin?.sha256 === sha(v2Plain) && outB.v === 2, JSON.stringify(B.pin && B.pin.revision));
  const arch = (await templates(p)).filter((t) => t.templateKind === "report_archive" && t.archivedOf === "bundled-anzen-eisei-03-2" && !t.isDeleted);
  check("9 旧版（第1版）は前の版として保持され、使用中なので自動削除されない", arch.some((t) => t.sourceFileSha256 === entry.sha256));
  await ctx.unroute("**/assets/templates/manifest.json"); await ctx.unroute(`**/assets/templates/${entry.fileName}`);

  // ===== 8. サイトデータ削除（IndexedDB・キャッシュ・Service Worker）→ リンクを開き直して復旧 =====
  await p.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); localStorage.clear(); });
  await p.goto("about:blank");
  const p2 = await newPage(ctx);
  await p2.goto(BASE); await p2.evaluate(async () => { const dbs = await indexedDB.databases(); for (const d of dbs) await new Promise((res) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => res(); }); });
  await p.close();
  await p2.reload(); await p2.waitForSelector("#view-site-list:not([hidden])"); await p2.waitForTimeout(1200);
  const wiped = await p2.evaluate(async () => ({ sites: (await (await import("/js/db.js")).dbGetAll("sites")).length, templates: (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length, key: !!(await (await import("/js/db.js")).dbGet("meta", "bundledTemplateKey")) }));
  check("8 サイトデータを削除すると、テンプレートも鍵も消える（勝手には戻らない）", wiped.templates === 0 && !wiped.key, JSON.stringify(wiped));
  await p2.goto(setupUrl(BASE, KEY)); await p2.waitForSelector("#view-site-list:not([hidden])"); await waitRegistered(p2);
  const C = await makeSiteAndReport(p2, "復旧後の現場");
  const outC = await exportExcel(p2, C.reportId, "C.xlsx");
  check("8 同じセットアップリンクをもう一度開くだけで復旧し、Excel出力できる", !!C.pin && outC.work && outC.sheets[0] === "手書印刷用");

  // 管理画面に貼り付けて復旧（リンクをタップできない場合）
  const ctxPaste = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
  const pp = await newPage(ctxPaste);
  await pp.goto(`${BASE}#/report-templates`); await pp.waitForSelector("#view-report-templates:not([hidden])"); await pp.waitForSelector(".bundledSetupInput");
  await pp.fill(".bundledSetupInput", setupUrl(PAGES + "index.html", KEY)); await pp.click(".bundledSetupBtn");
  await waitRegistered(pp);
  const pasted = await live(pp);
  check("8 管理画面にリンク（または鍵）を貼り付けても登録できる（リンクを開けない場合の復旧手段）", pasted.some((t) => t.bundledId && t.isAppDefault), JSON.stringify(pasted.map((t) => [t.id, t.isAppDefault])) + " " + (await message(pp)).slice(0, 80));
  await ctxPaste.close();

  // iPad買い替え（まったく新しい端末）
  const ctxNew = await browser.newContext({ acceptDownloads: true });
  const pn = await newPage(ctxNew);
  await pn.goto(setupUrl(BASE, KEY)); await pn.waitForSelector("#view-site-list:not([hidden])"); await waitRegistered(pn);
  const D = await makeSiteAndReport(pn, "新しいiPadの現場");
  const outD = await exportExcel(pn, D.reportId, "D.xlsx");
  check("8 別の新しい端末（iPad買い替え）でも、リンクを1回開くだけで登録・出力できる", outD.work && !!D.pin);
  await ctxNew.close();

  // ===== 誤ったリンク・改ざん =====
  const ctxBad = await browser.newContext({ serviceWorkers: "block" });
  const pb = await newPage(ctxBad);
  await pb.goto(setupUrl(BASE, crypto.randomBytes(32).toString("base64url"))); await pb.waitForSelector("#view-site-list:not([hidden])");
  await pb.waitForFunction(() => /セットアップできませんでした/.test(document.getElementById("message")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  const badMsg = await message(pb);
  const badState = await pb.evaluate(async () => ({ t: (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length, key: !!(await (await import("/js/db.js")).dbGet("meta", "bundledTemplateKey")) }));
  check("誤ったセットアップリンクは理由を表示して何も登録せず、鍵も保存しない", badMsg.includes("セットアップできませんでした") && badState.t === 0 && !badState.key, badMsg.slice(0, 60));
  await pb.route(`**/assets/templates/${entry.fileName}`, (r) => r.fulfill({ contentType: "application/octet-stream", body: Buffer.concat([encBytes.subarray(0, 1000), Buffer.from([encBytes[1000] ^ 1]), encBytes.subarray(1001)]) }));
  await pb.goto(setupUrl(BASE, KEY)); await pb.waitForSelector("#view-site-list:not([hidden])");
  await pb.waitForFunction(() => /セットアップできませんでした/.test(document.getElementById("message")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  const tamperMsg = await message(pb);
  check("改ざんされた暗号化ファイルは使わない（登録しない・理由を表示）", tamperMsg.includes("一致しません") && (await pb.evaluate(async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length)) === 0, tamperMsg.slice(0, 60));
  await ctxBad.close();

  // ===== 既存の端末（データあり・リンクを開いていない）は何も変わらない =====
  const ctxOld = await browser.newContext({ serviceWorkers: "block" });
  const po = await newPage(ctxOld);
  await po.goto(BASE); await po.waitForSelector("#view-site-list:not([hidden])");
  await po.evaluate(async () => { const { createSite } = await import("/js/sites.js"); await createSite({ name: "既存現場" }); });
  const snap = async () => JSON.stringify(await po.evaluate(async () => ({ s: (await (await import("/js/db.js")).dbGetAll("sites")).map((x) => [x.id, x.updatedAt]), t: (await (await import("/js/db.js")).dbGetAll("reportTemplates")).length })));
  const before = await snap(); await po.reload(); await po.waitForSelector("#view-site-list:not([hidden])"); await po.waitForTimeout(1200);
  check("リンクを開いていない既存の端末は、起動しても何も登録・変更されない", before === (await snap()));
  await ctxOld.close();

  // ===== 削除した同梱テンプレートは再起動で復活しない（現場の無い端末）=====
  const ctxDel = await browser.newContext({ serviceWorkers: "block" });
  const pd = await newPage(ctxDel);
  await pd.goto(setupUrl(BASE, KEY)); await pd.waitForSelector("#view-site-list:not([hidden])"); await waitRegistered(pd);
  await pd.goto(`${BASE}#/report-templates`); await pd.waitForSelector(`li[data-template-id="bundled-anzen-eisei-03-2"]`);
  await pd.locator(`li[data-template-id="bundled-anzen-eisei-03-2"] .deleteReportTemplateBtn`).click(); await pd.waitForTimeout(400);
  await pd.reload(); await pd.waitForSelector("#view-report-templates:not([hidden])"); await pd.waitForTimeout(1200);
  check("利用者が削除した同梱テンプレートは、再起動しても自動では復活しない（管理画面から登録し直せる）", (await live(pd)).length === 0 && (await pd.locator(".bundledTemplateActionBtn").count()) === 1);
  await ctxDel.close();

  check("原本の03-2はSHA-256不変", !fs.existsSync(ORIGINAL) || (!ORIGINAL_SHA256 || sha(fs.readFileSync(ORIGINAL)) === ORIGINAL_SHA256));
  check("コンソールエラー・ページエラーが無い", errors.length === 0, errors.slice(0, 3).join(" / "));
  await ctx.close();
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(String(e).replace(/setup=[A-Za-z0-9_-]+/g, "setup=<鍵>")); process.exit(1); });
