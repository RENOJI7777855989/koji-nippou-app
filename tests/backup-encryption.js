// バックアップのパスワード暗号化（2026-11-01。js/backupCrypto.js・バックアップ管理の画面。架空データ・隔離したプロファイル）
//   ・暗号化と復号の往復（複数の塊）、誤ったパスワード・改ざん・塊の入れ替え・重複・切り捨て・余分なデータ・ヘッダーの書き換えの拒否
//   ・画面から作った .kbak に平文（現場名など）が入っていない
//   ・別の端末（空のプロファイル）へ画面から復元: 誤ったパスワードでは何も書かない、正しいパスワードで写真・署名・KY・積算/見積・
//     変更履歴・テンプレートが欠けずに戻る。復元前のバックアップも暗号化される。従来の ZIP も復元できる
//   ・PBKDF2（60万回）の時間（Chromium・WebKit。iPad 実機は未確認）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium, webkit } = require("playwright");
const { loadKey } = require("./helpers/templateKey.js");
const { waitForAsync } = require("./helpers/wait.js");
const { restoreViaUi } = require("./helpers/restore");

const BASE = "http://localhost:8934/index.html";
const PW = "Genba-2026-pass";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const SITE_NAME = "暗号化の試験現場ヒミツ";

// 端末のデータの要約（件数と、添付ファイルの SHA-256）
const SNAP = async () => {
  const { dbGetAll } = await import("/js/db.js");
  const h = async (b) => (b ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await b.arrayBuffer()))).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16) : null);
  const out = {};
  for (const s of ["sites", "reports", "photos", "signatures", "kySubmissions", "estimateItems", "vendorQuoteItems", "reportTemplates"]) out[s] = (await dbGetAll(s)).length;
  out.photoHashes = (await Promise.all((await dbGetAll("photos")).map((p) => h(p.blob)))).sort().join(",");
  out.sigHashes = (await Promise.all((await dbGetAll("signatures")).map((p) => h(p.imageBlob)))).sort().join(",");
  out.tplHashes = (await Promise.all((await dbGetAll("reportTemplates")).map((p) => h(p.sourceFileBlob)))).sort().join(",");
  out.audit = (await dbGetAll("auditLog")).filter((a) => /暗号化の試験/.test(a.summary || "")).length;
  return out;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-enc-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await page.goto(`${BASE}#setup=${loadKey()}`); await page.waitForSelector("#view-site-list:not([hidden])");
  await waitForAsync(page, async () => (await (await import("/js/db.js")).dbGetAll("reportTemplates")).some((t) => t.bundledId), null, { timeout: 30000 });

  // ===== 暗号化の仕組み（関数） =====
  const unit = await page.evaluate(async () => {
    const bc = await import("/js/backupCrypto.js");
    const data = new Uint8Array(5000); for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251;
    const plain = new Blob([data]);
    const opts = { iterations: 100000, chunkSize: 1024 }; // 5塊（試験のため小さく）
    const encd = new Uint8Array(await (await bc.encryptBackupBlob(plain, "correct-horse", opts)).arrayBuffer());
    const file = (u) => new File([u], "t.kbak");
    const tryDec = async (u, pw = "correct-horse") => { try { const r = await bc.decryptBackupFile(file(u), pw); const back = new Uint8Array(await r.blob.arrayBuffer()); return back.length === data.length && back.every((v, i) => v === data[i]) ? "OK" : "内容が違う"; } catch (e) { return e.message; } };
    // 塊の位置
    const dv = new DataView(encd.buffer); const hl = dv.getUint32(8, false); const chunks = []; let p = 12 + hl;
    while (p < encd.length) { const len = dv.getUint32(p, false); chunks.push([p, 4 + len]); p += 4 + len; }
    const head = encd.slice(0, 12 + hl);
    const join = (...parts) => { const n = parts.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of parts) { o.set(x, k); k += x.length; } return o; };
    const ch = (i) => encd.slice(chunks[i][0], chunks[i][0] + chunks[i][1]);
    const flipped = encd.slice(); flipped[chunks[2][0] + 10] ^= 1;
    const headerTampered = (() => { const t = new TextDecoder().decode(encd.slice(12, 12 + hl)).replace('"plainSize":5000', '"plainSize":4999'); const hb = new TextEncoder().encode(t); const u = new Uint8Array(4); new DataView(u.buffer).setUint32(0, hb.length, false); return join(encd.slice(0, 8), u, hb, ...chunks.map((_, i) => ch(i))); })();
    return {
      chunkCount: chunks.length,
      ok: await tryDec(encd),
      wrong: await tryDec(encd, "wrong-password"),
      flipped: await tryDec(flipped),
      swapped: await tryDec(join(head, ch(0), ch(2), ch(1), ch(3), ch(4))),
      duplicated: await tryDec(join(head, ch(0), ch(1), ch(1), ch(2), ch(3), ch(4))),
      truncated: await tryDec(join(head, ch(0), ch(1), ch(2), ch(3))),
      lastDropped: await tryDec(encd.slice(0, chunks[4][0] + 10)),
      trailing: await tryDec(join(encd, new Uint8Array([1, 2, 3]))),
      headerTampered: await tryDec(headerTampered),
      notEncrypted: await tryDec(new TextEncoder().encode("PK\u0003\u0004 これはZIP")),
      isEnc: await bc.isEncryptedBackupFile(file(encd)), isEncZip: await bc.isEncryptedBackupFile(file(new TextEncoder().encode("PK\u0003\u0004xxxxxxxxxx"))),
      pwShort: bc.backupPasswordProblem("1234567", "1234567"), pwMismatch: bc.backupPasswordProblem("abcdefgh", "abcdefgX"), pwOk: bc.backupPasswordProblem("abcdefgh", "abcdefgh")
    };
  });
  check("暗号化と復号の往復（5つの塊）で内容が同じ", unit.chunkCount === 5 && unit.ok === "OK", JSON.stringify({ n: unit.chunkCount, ok: unit.ok }));
  check("誤ったパスワードは拒否（「パスワードが違うか…」）", /パスワードが違う/.test(unit.wrong), unit.wrong);
  check("暗号文の1ビットの書き換えは拒否", /壊れているか、書き換えられて|復号できません/.test(unit.flipped), unit.flipped);
  check("塊の入れ替え・重複は拒否", unit.swapped !== "OK" && unit.duplicated !== "OK", `${unit.swapped} / ${unit.duplicated}`);
  check("最後の塊の切り捨て・途中で切れたファイルは拒否", unit.truncated !== "OK" && unit.lastDropped !== "OK", `${unit.truncated} / ${unit.lastDropped}`);
  check("後ろに余分なデータがあるファイル・ヘッダーの書き換えは拒否", /余分なデータ/.test(unit.trailing) && unit.headerTampered !== "OK", `${unit.trailing} / ${unit.headerTampered}`);
  check("ZIP は暗号化したバックアップとして扱わない（判別）", unit.isEnc && !unit.isEncZip && /ではありません/.test(unit.notEncrypted));
  check("パスワードは8文字以上・確認と一致", /8文字以上/.test(unit.pwShort) && /一致しません/.test(unit.pwMismatch) && unit.pwOk === "");

  // PBKDF2 60万回の時間（Chromium・WebKit）
  const timing = async (browserType) => { const b = await browserType.launch(); const p = await b.newPage(); await p.goto(BASE); const ms = await p.evaluate(async () => { const { encryptBackupBlob } = await import("/js/backupCrypto.js"); const t = performance.now(); await encryptBackupBlob(new Blob([new Uint8Array(10)]), "measure-password"); return Math.round(performance.now() - t); }); await b.close(); return ms; };
  const tC = await timing(chromium), tW = await timing(webkit);
  check("PBKDF2（60万回）の時間: この Mac で数秒以内（iPad 実機は未確認）", tC < 5000 && tW < 5000, `Chromium ${tC}ms・WebKit ${tW}ms`);

  // ===== 架空データ（写真・署名・KY・積算/見積・変更履歴・テンプレート） =====
  await page.evaluate(async (SITE_NAME) => {
    const { createSite } = await import("/js/sites.js"); const { createReport } = await import("/js/reports.js"); const { dbPut } = await import("/js/db.js"); const { stampNew, createId } = await import("/js/utils.js");
    const ky = await import("/js/ky/kySubmissions.js");
    const site = await createSite({ name: SITE_NAME, startDate: "2026-10-01" });
    const r = await createReport({ siteId: site.id, date: "2026-10-05", dayStatus: "work", weather: "晴れ", companies: [{ companyId: "c1", companyName: "アオバ塗装工業", occupation: "塗装", actualWorkerCount: "3", workContent: "外壁塗装" }] });
    const img = async (color) => { const cv = document.createElement("canvas"); cv.width = 120; cv.height = 80; const g = cv.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, 120, 80); return new Promise((res) => cv.toBlob(res, "image/jpeg", 0.8)); };
    await dbPut("photos", stampNew({ reportId: r.id, siteId: site.id, blob: await img("#a33"), mimeType: "image/jpeg", order: 0, caption: "写真1" }));
    await dbPut("photos", stampNew({ reportId: r.id, siteId: site.id, blob: await img("#3a3"), mimeType: "image/jpeg", order: 1, caption: "写真2" }));
    const sig = document.createElement("canvas"); sig.width = 200; sig.height = 60; sig.getContext("2d").fillRect(10, 10, 100, 20);
    await dbPut("signatures", stampNew({ reportId: r.id, companyId: "c1", role: "foreman", roleLabel: "職長", imageBlob: await new Promise((res) => sig.toBlob(res, "image/png")), signedAt: new Date().toISOString() }));
    await ky.addKyVendor({ siteId: site.id, date: "2026-10-05", vendorName: "アオバ塗装工業" });
    const eb = createId(); await dbPut("estimateBatches", stampNew({ id: eb, siteId: site.id, sourceFileName: "積算.xlsx", itemCount: 1, status: "active" }));
    await dbPut("estimateItems", stampNew({ siteId: site.id, estimateBatchId: eb, category: "塗装", itemName: "外壁塗装", quantity: 10, unit: "m2", unitPrice: 1000, amount: 10000 }));
    const vb = createId(); await dbPut("vendorQuoteBatches", stampNew({ id: vb, siteId: site.id, vendorName: "アオバ塗装工業", itemCount: 1, status: "active" }));
    await dbPut("vendorQuoteItems", stampNew({ siteId: site.id, vendorQuoteBatchId: vb, category: "塗装", itemName: "外壁塗装", quantity: 10, unit: "m2", unitPrice: 900, amount: 9000 }));
  }, SITE_NAME);
  const src = await page.evaluate(SNAP);

  // ===== 画面から暗号化したバックアップを作る =====
  await page.goto(`${BASE}#/backup`); await page.waitForSelector("#view-backup:not([hidden])");
  check("バックアップ管理: 「パスワードで暗号化する（推奨）」が既定でオン・忘れると復元できない旨を表示", await page.isChecked("#backupEncryptToggle") && (await page.textContent("#backupEncryptBox")).includes("パスワードを忘れると、誰にも復元できません"));
  await page.fill("#backupPassword", "short"); await page.fill("#backupPasswordConfirm", "short");
  let dlShort = null; page.once("download", (d) => { dlShort = d; });
  await page.click("#exportBackupBtn"); await page.waitForTimeout(800);
  check("短いパスワードでは作成しない（理由を表示）", !dlShort && /8文字以上/.test(await page.textContent("#message")));
  await page.fill("#backupPassword", PW); await page.fill("#backupPasswordConfirm", PW);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#exportBackupBtn")]);
  const kbak = path.join(dir, dl.suggestedFilename()); await dl.saveAs(kbak);
  const bytes = fs.readFileSync(kbak);
  check("作成したファイルは .kbak で、先頭が暗号化の印（ZIP ではない）", /\.kbak$/.test(kbak) && bytes.slice(0, 8).toString() === "KNBKENC1", dl.suggestedFilename());
  check("作成したファイルに平文（現場名・業者名・ZIP の中のファイル名）が入っていない", !bytes.includes(Buffer.from(SITE_NAME)) && !bytes.includes(Buffer.from("アオバ塗装工業")) && !bytes.includes(Buffer.from("data/sites.json")));
  check("作成後、パスワードの欄を空にする（画面に残さない）", (await page.inputValue("#backupPassword")) === "" && (await page.inputValue("#backupPasswordConfirm")) === "");

  // ===== 別の端末（空のプロファイル）へ画面から復元 =====
  const ctxE = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "backup-enc-empty-")), { viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
  const pe = await ctxE.newPage(); pe.on("dialog", (d) => d.accept());
  await pe.goto(`${BASE}#/backup`); await pe.waitForSelector("#view-backup:not([hidden])");
  const empty0 = await pe.evaluate(SNAP);
  await pe.setInputFiles("#restoreFileInput", kbak);
  await pe.waitForFunction(() => document.getElementById("backupDecryptDialog").open);
  await pe.fill("#backupDecryptPassword", "wrong-password-1"); await pe.click("#backupDecryptBtn");
  await pe.waitForFunction(() => /パスワードが違う/.test(document.getElementById("backupDecryptStatus").textContent));
  const afterWrong = await pe.evaluate(SNAP);
  check("復元: 誤ったパスワードは「パスワードが違うか…（何も書き込んでいません）」・端末のデータは変わらない・検査の画面に進まない", (await pe.textContent("#backupDecryptStatus")).includes("何も書き込んでいません") && JSON.stringify(afterWrong) === JSON.stringify(empty0) && !(await pe.evaluate(() => document.getElementById("backupRestoreDialog").open)));
  await pe.fill("#backupDecryptPassword", PW); await pe.click("#backupDecryptBtn");
  await pe.waitForFunction(() => document.getElementById("backupRestoreDialog").open, null, { timeout: 60000 });
  check("復元: 正しいパスワードで復号でき、従来どおり検査・計画の画面に進む", !(await pe.evaluate(() => document.getElementById("backupDecryptDialog").open)) && (await pe.textContent("#restorePlan")).includes("新規"));
  // 復元前のバックアップ（暗号化・既定でオン）
  check("復元前のバックアップも、既定でパスワード暗号化がオン", await pe.isChecked("#restorePreEncrypt"));
  await pe.fill("#restorePrePassword", "pre-backup-pw-1"); await pe.fill("#restorePrePasswordConfirm", "pre-backup-pw-1");
  const [preDl] = await Promise.all([pe.waitForEvent("download", { timeout: 60000 }), pe.click("#restorePreBackupBtn")]);
  const prePath = path.join(dir, "pre-" + preDl.suggestedFilename()); await preDl.saveAs(prePath);
  await pe.waitForFunction(() => !document.getElementById("restorePreBackupConfirmLabel").hidden, null, { timeout: 60000 });
  const preStatus = await pe.textContent("#restorePreBackupStatus");
  const preOk = await pe.evaluate(async (b64) => { const { decryptBackupFile } = await import("/js/backupCrypto.js"); const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); try { const r = await decryptBackupFile(new File([u], "p.kbak"), "pre-backup-pw-1"); const h = new Uint8Array(await r.blob.arrayBuffer()); return h[0] === 0x50 && h[1] === 0x4b; } catch (e) { return e.message; } }, fs.readFileSync(prePath).toString("base64"));
  check("復元前のバックアップは .kbak で暗号化され（状態の表示にも明記）、そのパスワードで復号すると ZIP に戻る", /\.kbak$/.test(prePath) && preStatus.includes("パスワードで暗号化済み") && preOk === true, `${preStatus.slice(0, 80)} / ${preOk}`);
  await pe.check("#restorePreBackupConfirm"); await pe.click("#restoreApplyBtn");
  await pe.waitForFunction(() => !document.getElementById("backupRestoreDialog").open || /復元できませんでした/.test(document.getElementById("restoreStatus").textContent), null, { timeout: 60000 });
  const dst = await pe.evaluate(SNAP);
  check("復元: 写真（中身の指紋）・職長サイン・KY・積算・見積・テンプレート（指紋）・現場・日報が欠けずに戻る", ["sites", "reports", "photos", "signatures", "kySubmissions", "estimateItems", "vendorQuoteItems", "reportTemplates", "photoHashes", "sigHashes", "tplHashes"].every((k) => dst[k] === src[k]) && dst.photos === 2, JSON.stringify({ src: { p: src.photos, s: src.signatures, k: src.kySubmissions, t: src.reportTemplates }, dst: { p: dst.photos, s: dst.signatures, k: dst.kySubmissions, t: dst.reportTemplates } }));
  const auditBack = await pe.evaluate(async (name) => (await (await import("/js/db.js")).dbGetAll("auditLog")).some((a) => (a.summary || "").includes(name)), SITE_NAME);
  check("復元: 変更履歴も戻る", auditBack);
  await ctxE.close();

  // ===== 従来の ZIP（暗号化しない）も、これまでどおり作成・復元できる =====
  await page.goto(`${BASE}#/sites`); await page.goto(`${BASE}#/backup`); await page.waitForSelector("#view-backup:not([hidden])");
  await page.uncheck("#backupEncryptToggle");
  check("暗号化を外すとパスワードの欄を隠す", await page.evaluate(() => document.getElementById("backupEncryptFields").hidden));
  const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#exportBackupBtn")]);
  const zipPath = path.join(dir, dl2.suggestedFilename()); await dl2.saveAs(zipPath);
  check("暗号化しない場合は従来どおり .zip（先頭が PK）・メッセージに「暗号化していません」", /\.zip$/.test(zipPath) && fs.readFileSync(zipPath).slice(0, 2).toString() === "PK" && (await page.textContent("#message")).includes("暗号化していません"));
  const ctxL = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "backup-enc-legacy-")), { acceptDownloads: true });
  const pl = await ctxL.newPage(); pl.on("dialog", (d) => d.accept());
  await pl.goto(`${BASE}#/backup`); await pl.waitForSelector("#view-backup:not([hidden])");
  await restoreViaUi(pl, zipPath);
  const legacy = await pl.evaluate(SNAP);
  check("従来の ZIP の復元: パスワードを聞かずに、写真・署名・KY などが戻る", legacy.photos === src.photos && legacy.photoHashes === src.photoHashes && legacy.signatures === src.signatures && legacy.kySubmissions === src.kySubmissions, JSON.stringify({ p: legacy.photos, s: legacy.signatures }));
  await ctxL.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
