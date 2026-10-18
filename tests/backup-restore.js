// バックアップからの復元（2026-10-18 の作り直し: 検査→計画→復元前のバックアップ→1つのトランザクションでの一括適用→確認）を確かめる（架空データ・Chromium）。
//   失敗するケースの合格条件: 復元の前と、復元に失敗した後で、すべてのストアのレコードのid・内容・件数が一致すること
//   （添付ファイル（写真・署名・テンプレート）は SHA-256 で比べる）。一部でも変わっていたら不合格。
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { restoreViaUi } = require("./helpers/restore");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

/** ページに試験用の道具を置く（window.T）。ページを移動しない間だけ使う */
async function installTools(page) {
  await page.evaluate(async () => {
    const db = await import("/js/db.js"); const bk = await import("/js/backup.js"); const zu = await import("/js/zipUtil.js");
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const sha = async (blob) => hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" && !(v instanceof Blob) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    window.T = {
      db, bk, zu, sha, zips: {},
      /** すべてのストアの id・内容（添付は指紋）・件数。exclude: 比べないストア */
      async snapshot(exclude = []) {
        const out = {};
        for (const s of bk.DATA_STORES) {
          if (exclude.includes(s)) continue;
          const rows = [];
          for (const r of await db.dbGetAll(s)) {
            const c = { ...r };
            for (const k of Object.keys(c)) if (c[k] instanceof Blob) c[k] = `sha256:${await sha(c[k])}`;
            rows.push(JSON.stringify(sortKeys(c)));
          }
          out[s] = rows.sort();
        }
        return JSON.stringify(out);
      },
      async counts() { const o = {}; for (const s of bk.DATA_STORES) o[s] = (await db.dbGetAll(s)).length; return o; },
      async makeBackup(name) { const { blob } = await bk.exportFullBackup(); this.zips[name] = new Uint8Array(await blob.arrayBuffer()); return this.zips[name].length; },
      file(name) { return new File([this.zips[name]], `${name}.zip`); },
      async readJson(name, path) { return JSON.parse(await zu.readZipEntryText(zu.loadZip(this.zips[name].buffer), path)); },
      /** zip の一部を差し替えた新しい zip を作る（mods: パス → 文字列 or Uint8Array） */
      async modify(from, to, mods) {
        const m = new Map(Object.entries(mods).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]));
        const blob = zu.buildZip(zu.loadZip(this.zips[from].buffer), m, "application/zip");
        this.zips[to] = new Uint8Array(await blob.arrayBuffer());
      },
      async analyze(name) { return bk.analyzeBackupFile(this.file(name)); },
      /** 検査→適用。失敗したときはエラーの文を返す */
      async restore(name, applyKeys = []) {
        const a = await bk.analyzeBackupFile(this.file(name));
        if (!a.ok) return { ok: false, stage: "検査", errors: a.errors.map((e) => `${e.store}:${e.id}:${e.reason}`) };
        try { const r = await bk.applyBackupRestore(a, { applyKeys: new Set(applyKeys) }); return { ok: true, counts: r.counts }; } catch (e) { return { ok: false, stage: "適用", errors: [e.message] }; }
      }
    };
  });
}

/** 架空のデータ: 現場2・日報3（うち1件は署名・写真つき）・KY・テンプレート（現在の版＋退避した旧版）。現場はテンプレートに固定 */
async function seed(page) {
  return page.evaluate(async () => {
    const { db, sha } = window.T; const { stampNew } = await import("/js/utils.js");
    const png = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")).blob();
    const tpl1 = new Blob([new TextEncoder().encode("テンプレート第1版（架空）")], { type: "application/octet-stream" });
    const tpl2 = new Blob([new TextEncoder().encode("テンプレート第2版（架空）")], { type: "application/octet-stream" });
    const t = stampNew({ name: "試験用の様式", format: "excel", templateKind: "report", rendererId: "xlsx-template-patch", isAppDefault: true, sourceFileBlob: tpl2, sourceFileMimeType: "application/octet-stream", sourceFileSha256: await sha(tpl2), revision: 2 });
    const tArch = stampNew({ name: "試験用の様式", format: "excel", templateKind: "report_archive", archivedOf: t.id, rendererId: "xlsx-template-patch", isAppDefault: false, sourceFileBlob: tpl1, sourceFileMimeType: "application/octet-stream", sourceFileSha256: await sha(tpl1), revision: 1 });
    await db.dbPut("reportTemplates", t); await db.dbPut("reportTemplates", tArch);
    const s1 = stampNew({ name: "復元の試験現場A", startDate: "2026-09-01", templatePin: { templateId: t.id, sha256: tArch.sourceFileSha256, revision: 1 } });
    const s2 = stampNew({ name: "復元の試験現場B", startDate: "2026-09-01", templatePin: { templateId: t.id, sha256: t.sourceFileSha256, revision: 2 } });
    await db.dbPut("sites", s1); await db.dbPut("sites", s2);
    const reps = [];
    for (const [site, date] of [[s1, "2026-09-10"], [s1, "2026-09-11"], [s2, "2026-09-12"]]) { const r = stampNew({ siteId: site.id, date, dayStatus: "work", remarks: `連絡 ${date}`, companies: [{ companyId: "c", companyName: "甲工業", actualWorkerCount: "2" }] }); await db.dbPut("reports", r); reps.push(r); }
    const photo = stampNew({ reportId: reps[0].id, siteId: s1.id, blob: png, mimeType: "image/png", order: 0, caption: "" });
    const photo2 = stampNew({ reportId: reps[1].id, siteId: s1.id, blob: png, mimeType: "image/png", order: 0, caption: "" });
    const sig = stampNew({ reportId: reps[0].id, companyId: "c", role: "foreman", imageBlob: png, signedAt: new Date().toISOString() });
    await db.dbPut("photos", photo); await db.dbPut("photos", photo2); await db.dbPut("signatures", sig);
    const ky = stampNew({ siteId: s1.id, date: "2026-09-10", vendorName: "甲工業", target: true, submitted: false, history: [] });
    const ky2 = stampNew({ siteId: s1.id, date: "2026-09-11", vendorName: "乙工業", target: true, submitted: false, history: [] });
    await db.dbPut("kySubmissions", ky); await db.dbPut("kySubmissions", ky2);
    return { t: t.id, tArch: tArch.id, s1: s1.id, s2: s2.id, r: reps.map((x) => x.id), photo: photo.id, photo2: photo2.id, sig: sig.id, ky: ky.id, ky2: ky2.id };
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1000, height: 1100 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await installTools(page);
  const ids = await seed(page);
  await page.evaluate(() => window.T.makeBackup("B0"));
  const tryRestore = (name, keys = []) => page.evaluate(([n, k]) => window.T.restore(n, k), [name, keys]);

  // ===== 18・19 復元前のバックアップの再読込（件数・添付ファイルの指紋）と、新しい manifest =====
  const pre = await page.evaluate(async () => { const r = await window.T.bk.createVerifiedBackup(); const a = await window.T.bk.analyzeBackupFile(new File([r.blob], r.filename)); return { check: r.check, ok: a.ok, items: a.items.length, attachments: a.attachments, manifest: { formatVersion: a.manifest.formatVersion, dbVersion: a.manifest.dbVersion, blobs: Object.keys(a.manifest.blobs || {}).length } }; });
  check("18 復元前のバックアップを作って読み直すと、問題なし・全ストアの件数と添付ファイル（写真2・署名1・テンプレート2＝5件）が今の保存データと一致", pre.ok && pre.check.attachments === 5 && pre.attachments === 5, JSON.stringify(pre));
  check("新しいバックアップの manifest に形式の版（2）・DBの版（10）・添付ファイルの指紋（5件）を書く", pre.manifest.formatVersion === 2 && pre.manifest.dbVersion === 10 && pre.manifest.blobs === 5, JSON.stringify(pre.manifest));
  // 失敗するケースの比べる基準（すべてのストア。変更履歴も含む）。復元前のバックアップを作ると変更履歴に1件増えるので、その後で取る
  const S0 = await page.evaluate(() => window.T.snapshot());
  const unchanged = async () => (await page.evaluate(() => window.T.snapshot())) === S0;

  // ===== 2 壊れたZIP =====
  await page.evaluate(() => { window.T.zips.broken = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9]); });
  let r = await tryRestore("broken");
  check("2 壊れたZIP: 検査で中止（ZIPとして読めない）・保存データは1件も変わらない", !r.ok && r.stage === "検査" && r.errors.some((e) => e.includes("ZIP")) && (await unchanged()), JSON.stringify(r).slice(0, 160));
  // ===== 3 最後のストア（KY）の JSON が壊れている =====
  await page.evaluate(() => window.T.modify("B0", "lastJson", { "data/kySubmissions.json": "[{壊れた" }));
  r = await tryRestore("lastJson");
  check("3 最後のストアのJSONが壊れている: 検査で中止・前のストアも書き込まない（変わらない）", !r.ok && r.stage === "検査" && r.errors.some((e) => e.includes("kySubmissions") && e.includes("壊れています")) && (await unchanged()), r.errors?.[0]);
  // ===== 4 必須項目の欠落・5 idの欠落・重複・6 参照先の無いデータ =====
  const mutate = async (to, store, fn) => page.evaluate(async ([to, store, fnSrc]) => { const T = window.T; const arr = await T.readJson("B0", `data/${store}.json`); const out = (0, eval)(fnSrc)(arr); await T.modify("B0", to, { [`data/${store}.json`]: JSON.stringify(out) }); }, [to, store, fn.toString()]);
  await mutate("noDate", "reports", (a) => a.map((x, i) => (i === 0 ? { ...x, date: "" } : x)));
  r = await tryRestore("noDate");
  check("4 必須項目の欠落（日報の日付が空）: 検査で中止・補わない・変わらない", !r.ok && r.errors.some((e) => e.includes("必須の項目") && e.includes("date")) && (await unchanged()), r.errors?.[0]);
  await mutate("noId", "reports", (a) => a.map((x, i) => (i === 1 ? { ...x, id: "" } : x)));
  r = await tryRestore("noId");
  check("5 idの欠落: 検査で中止・変わらない", !r.ok && r.errors.some((e) => e.includes("id がありません")) && (await unchanged()), r.errors?.[0]);
  await mutate("dupId", "reports", (a) => [...a, { ...a[0], remarks: "重複" }]);
  r = await tryRestore("dupId");
  check("5 idの重複: 検査で中止（件数の食い違いも）・変わらない", !r.ok && r.errors.some((e) => e.includes("重複")) && (await unchanged()), r.errors?.join(" / ").slice(0, 160));
  await page.evaluate(async () => { const T = window.T; const set = async (store, fn) => JSON.stringify(fn(await T.readJson("B0", `data/${store}.json`))); await T.modify("B0", "orphan", { "data/reports.json": await set("reports", (a) => a.map((x, i) => (i === 0 ? { ...x, siteId: "存在しない現場" } : x))), "data/photos.json": await set("photos", (a) => a.map((x) => ({ ...x, reportId: "存在しない日報" }))), "data/signatures.json": await set("signatures", (a) => a.map((x) => ({ ...x, reportId: "存在しない日報" }))) }); });
  // 参照先が無いことを確かめるため、別の空の端末で検査する（この端末には元の現場・日報があるので参照が解決してしまう）
  const ctxE = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-empty-")), { acceptDownloads: true });
  const pe = await ctxE.newPage(); pe.on("pageerror", (e) => errors.push(e.message)); pe.on("dialog", (d) => d.accept());
  await pe.goto(BASE); await pe.waitForSelector("#view-site-list:not([hidden])"); await installTools(pe);
  const passZip = async (name) => { const b64 = await page.evaluate((n) => { const u = window.T.zips[n]; let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }, name); await pe.evaluate(([n, b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.T.zips[n] = u; }, [name, b64]); };
  const SE = await pe.evaluate(() => window.T.snapshot());
  const emptyUnchanged = async () => (await pe.evaluate(() => window.T.snapshot())) === SE;
  await passZip("orphan");
  r = await pe.evaluate(() => window.T.restore("orphan"));
  check("6 参照先の無い日報・写真・署名（存在しない現場・日報）: 検査で中止し、それぞれ理由を示す・空の端末も変わらない", !r.ok && ["reports", "photos", "signatures"].every((s) => r.errors.some((e) => e.startsWith(`${s}:`) && e.includes("参照"))) && (await emptyUnchanged()), r.errors?.slice(0, 3).join(" / "));
  // ===== 7 画像ファイルの欠落・8 画像の指紋の不一致 =====
  await page.evaluate(async () => { const T = window.T; const ph = await T.readJson("B0", "data/photos.json"); ph[0].blobFile = "blobs/存在しない.bin"; await T.modify("B0", "missingBlob", { "data/photos.json": JSON.stringify(ph) }); });
  r = await tryRestore("missingBlob");
  check("7 画像ファイルの欠落: 検査で中止・既存の写真の画像を空（null）にしない（変わらない）", !r.ok && r.errors.some((e) => e.includes("添付ファイル") && e.includes("見つかりません")) && (await unchanged()), r.errors?.[0]);
  await page.evaluate(async () => { const T = window.T; const ph = await T.readJson("B0", "data/photos.json"); await T.modify("B0", "badHash", { [ph[0].blobFile]: new Uint8Array([1, 2, 3, 4]) }); });
  r = await tryRestore("badHash");
  check("8 画像の中身が記録した指紋（SHA-256）と違う: 検査で中止・変わらない", !r.ok && r.errors.some((e) => e.includes("壊れています")) && (await unchanged()), r.errors?.[0]);
  await page.evaluate(async () => { const T = window.T; const m = await T.readJson("B0", "manifest.json"); delete m.blobs; delete m.formatVersion; delete m.dbVersion; const tp = await T.readJson("B0", "data/reportTemplates.json"); await T.modify("B0", "badTplHash", { "manifest.json": JSON.stringify(m), [tp[0].sourceFileBlobFile]: new TextEncoder().encode("中身を差し替えた様式") }); });
  r = await tryRestore("badTplHash");
  check("8 従来の形式（指紋の一覧なし）でも、テンプレートの中身が記録された SHA-256 と違えば中止・変わらない", !r.ok && r.errors.some((e) => e.includes("テンプレートのファイルの中身")) && (await unchanged()), r.errors?.[0]);

  // ===== 9・10 適用中の失敗（N件目の書き込みでエラー・トランザクションの中断）: 上書きが複数のストアにまたがるバックアップで =====
  await page.evaluate(async () => {
    const T = window.T; const future = "2099-01-01T00:00:00.000Z"; const mods = {};
    for (const s of ["sites", "reports", "kySubmissions"]) mods[`data/${s}.json`] = JSON.stringify((await T.readJson("B0", `data/${s}.json`)).map((x) => ({ ...x, updatedAt: future, ...(s === "reports" ? { remarks: "バックアップで直した連絡" } : s === "sites" ? { address: "バックアップで直した住所" } : { submitted: true }) })));
    await T.modify("B0", "newer", mods);
  });
  const plan = await page.evaluate(async () => { const a = await window.T.analyze("newer"); return { ok: a.ok, overwrite: a.items.filter((i) => i.action === "overwrite").map((i) => i.store) }; });
  check("9 準備: 現場2・日報3・KY2の上書き（7件・3つのストア）になるバックアップ", plan.ok && plan.overwrite.length === 7, JSON.stringify(plan));
  for (const [label, mode] of [["9 適用中の5件目の書き込みで容量不足のエラー", "throw"], ["10 適用中の4件目でトランザクションを中断", "abort"]]) {
    r = await page.evaluate(async (mode) => {
      const orig = IDBObjectStore.prototype.put; let n = 0;
      IDBObjectStore.prototype.put = function (...a) {
        if (this.transaction.mode === "readwrite" && this.transaction.objectStoreNames.length > 1) {
          n++;
          if (mode === "throw" && n === 5) throw new DOMException("模擬: 容量不足", "QuotaExceededError");
          if (mode === "abort" && n === 4) { const req = orig.apply(this, a); this.transaction.abort(); return req; }
        }
        return orig.apply(this, a);
      };
      try { return await window.T.restore("newer"); } finally { IDBObjectStore.prototype.put = orig; }
    }, mode);
    check(`${label}: 復元は失敗と表示し（成功にしない）、すべてのストアの id・内容・件数が復元前と一致（途中までの書き込みが残らない）`, !r.ok && r.stage === "適用" && (await unchanged()), r.errors?.[0]?.slice(0, 80));
  }
  // 失敗の後でも、同じバックアップを正常に復元できる（7件が上書きされる）
  r = await tryRestore("newer");
  const afterNewer = await page.evaluate(async (ids) => { const { db } = window.T; return { site: (await db.dbGet("sites", ids.s1)).address, rep: (await db.dbGet("reports", ids.r[0])).remarks, ky: (await db.dbGet("kySubmissions", ids.ky)).submitted, photoSha: await window.T.sha((await db.dbGet("photos", ids.photo)).blob) }; }, ids);
  check("9 失敗の後に同じバックアップを復元すると、3つのストアの7件がすべて上書きされる（写真の画像は変わらない）", r.ok && afterNewer.site === "バックアップで直した住所" && afterNewer.rep === "バックアップで直した連絡" && afterNewer.ky === true && afterNewer.photoSha.length === 64, JSON.stringify(r.counts));
  // 以後は B0 の時点のデータに戻して続ける（このテストの中だけ。B0 の内容を「すべて復元」）
  const back = await page.evaluate(async () => { const T = window.T; const a = await T.analyze("B0"); return T.bk.applyBackupRestore(a, { applyKeys: new Set(a.items.map((i) => i.key)) }).then(() => "ok", (e) => e.message); });
  const S1 = await page.evaluate(() => window.T.snapshot(["auditLog"]));
  check("（準備）B0 の内容をすべて選んで復元すると、B0 の時点の内容に戻る（変更履歴を除いて一致）", back === "ok" && S1 === (await page.evaluate(async (s0) => { const o = JSON.parse(s0); delete o.auditLog; return JSON.stringify(o); }, S0)));
  // ===== A 計画を作った後に端末のデータが変わった（別のタブ・ウィンドウでの変更）: 何も書かずに中止し、その計画では二度と適用しない =====
  //   合格条件: 変更の後・適用の失敗の後・同じ計画での再実行の後で、すべてのストアの id・内容・件数（添付は SHA-256）が同じ
  await page.evaluate(async (ids) => {
    const T = window.T; const newer = async (s) => T.readJson("newer", `data/${s}.json`); const m = await T.readJson("newer", "manifest.json");
    const reps = await newer("reports");
    const extra = { ...reps[0], id: "計画の後に端末へ追加される日報", date: "2026-09-13", remarks: "追加" };
    await T.modify("newer", "newerPlus", { "data/reports.json": JSON.stringify([...reps, extra]), "manifest.json": JSON.stringify({ ...m, recordCounts: { ...m.recordCounts, reports: reps.length + 1 } }) });
    // 日報 r0 を含まない（写真・署名の親の日報 r0 は、この端末にだけある＝参照先として見張る）
    await T.modify("newer", "newerNoR0", { "data/reports.json": JSON.stringify(reps.filter((x) => x.id !== ids.r[0])), "manifest.json": JSON.stringify({ ...m, recordCounts: { ...m.recordCounts, reports: reps.length - 1 } }) });
  }, ids);
  const staleCase = (zipName, mutateSrc) => page.evaluate(async ([zipName, mutateSrc, ids]) => {
    const T = window.T; const { db } = T;
    const a = await T.analyze(zipName);
    if (!a.ok) return { setup: a.errors.map((e) => e.reason).join() };
    const writes = a.items.filter((i) => i.defaultApply && i.action !== "same").length;
    await (0, eval)(mutateSrc)(db, ids); // 計画の後の、別の処理による変更
    const before = await T.snapshot();
    let stale = false; let msg = "";
    try { await T.bk.applyBackupRestore(a); } catch (e) { stale = !!e.stale; msg = e.message; }
    const after = await T.snapshot();
    let again = "";
    try { await T.bk.applyBackupRestore(a); again = "（再実行できてしまった）"; } catch (e) { again = e.message; }
    const after2 = await T.snapshot();
    return { writes, stale, msg, state: a.state, unchanged: before === after && after === after2, again };
  }, [zipName, mutateSrc, ids]);
  const staleOk = (x) => x.writes > 0 && x.stale && x.msg.startsWith("端末のデータが計画作成後に変更されたため、復元を中止しました。最新の状態を再検査してください") && x.state === "stale" && x.unchanged && x.again.includes("計画作成後に変更");
  const cases = [
    ["A1 計画の後に、対象レコード（日報）の updatedAt が変わる", "newer", async (db, ids) => { const r = await db.dbGet("reports", ids.r[0]); await db.dbPut("reports", { ...r, updatedAt: new Date().toISOString() }); }],
    ["A2 計画の後に、updatedAt は同じまま内容（連絡事項）だけが変わる", "newer", async (db, ids) => { const r = await db.dbGet("reports", ids.r[1]); await db.dbPut("reports", { ...r, remarks: "別のタブで直した連絡（updatedAtは同じ）" }); }],
    ["A3 計画の後に、計画では端末に無かったレコード（新規の予定の日報）が端末に追加される", "newerPlus", async (db, ids) => { const r = await db.dbGet("reports", ids.r[0]); await db.dbPut("reports", { ...r, id: "計画の後に端末へ追加される日報", date: "2026-09-13", remarks: "別のタブで追加" }); }],
    ["A4 計画の後に、上書きの予定のレコード（KY）が端末から削除される", "newer", async (db, ids) => { await db.dbDelete("kySubmissions", ids.ky); }],
    ["A5 計画の後に、論理削除の状態が変わる（updatedAt は同じまま isDeleted だけ）", "newer", async (db, ids) => { const r = await db.dbGet("reports", ids.r[2]); await db.dbPut("reports", { ...r, isDeleted: true, deletedAt: new Date().toISOString() }); }],
    ["A6 計画の後に、写真の画像の中身が変わる（大きさ・updatedAt・ほかの項目は同じ）", "newer", async (db, ids) => { const p = await db.dbGet("photos", ids.photo); const u = new Uint8Array(await p.blob.arrayBuffer()); u[u.length - 1] ^= 0xff; await db.dbPut("photos", { ...p, blob: new Blob([u], { type: p.blob.type }) }); }],
    ["A6 計画の後に、写真・署名の親の日報（バックアップに無く端末にだけある）が変わる", "newerNoR0", async (db, ids) => { const r = await db.dbGet("reports", ids.r[0]); await db.dbPut("reports", { ...r, remarks: "親の日報を別のタブで直した" }); }],
    ["A6 計画の後に、別のタブで標準テンプレートが追加される（現場・テンプレートの全体）", "newer", async (db) => { const t = (await db.dbGetAll("reportTemplates")).find((x) => x.isAppDefault); await db.dbPut("reportTemplates", { ...t, id: "別のタブで追加した標準テンプレート" }); }]
  ];
  for (const [label, zipName, fn] of cases) {
    const x = await staleCase(zipName, fn.toString());
    check(`${label}: 「端末のデータが計画作成後に変更されたため…再検査してください」で中止し、すべてのストアの id・内容・件数（添付は SHA-256）が変わらない。同じ計画では再実行できない`, staleOk(x), JSON.stringify(x).slice(0, 220));
  }
  // 後片付け（このテストの中だけ）: 追加した日報・テンプレートを消し、B0 の内容をすべて選んで復元して、B0 の時点に戻す
  const back2 = await page.evaluate(async () => { const T = window.T; await T.db.dbDelete("reports", "計画の後に端末へ追加される日報"); await T.db.dbDelete("reportTemplates", "別のタブで追加した標準テンプレート"); const a = await T.analyze("B0"); return T.bk.applyBackupRestore(a, { applyKeys: new Set(a.items.map((i) => i.key)) }).then(() => "ok", (e) => e.message); });
  check("（準備）A の後に B0 の内容へ戻せる（変更履歴を除いて B0 と一致）", back2 === "ok" && (await page.evaluate(() => window.T.snapshot(["auditLog"]))) === S1, back2);

  // ===== A9 確認と書き込みの間に、別の処理の書き込みが割り込む（同じトランザクションでなければ、割り込んだ変更を上書きしてしまう） =====
  //   復元のトランザクションを作る直前に、別の readwrite のトランザクションで日報 r0 を変更する（IndexedDB は先に作られた方を先に完了させる）。
  //   トランザクションの前の確認（SHA-256 を含む）はもう済んでいるので、ここで検出できるのはトランザクションの中の確認だけ
  const race = await page.evaluate(async (ids) => {
    const T = window.T; const { db } = T;
    const a = await T.analyze("newer");
    const r0 = await db.dbGet("reports", ids.r[0]);
    const before = await T.snapshot();
    const origTx = IDBDatabase.prototype.transaction; const origPut = IDBObjectStore.prototype.put;
    let armed = true; let injected = false; let restorePuts = 0;
    IDBDatabase.prototype.transaction = function (scope, mode, ...rest) {
      if (armed && mode === "readwrite" && Array.isArray(scope) && scope.length > 1) {
        armed = false;
        const t0 = origTx.call(this, ["reports"], "readwrite");
        t0.objectStore("reports").put({ ...r0, remarks: "確認の直後に割り込んだ変更" });
        t0.oncomplete = () => { injected = true; };
      }
      return origTx.call(this, scope, mode, ...rest);
    };
    IDBObjectStore.prototype.put = function (...args) { if (this.transaction.mode === "readwrite" && this.transaction.objectStoreNames.length > 1) restorePuts++; return origPut.apply(this, args); };
    let stale = false; let msg = "";
    try { await T.bk.applyBackupRestore(a); } catch (e) { stale = !!e.stale; msg = e.message; } finally { IDBDatabase.prototype.transaction = origTx; IDBObjectStore.prototype.put = origPut; }
    const now = await db.dbGet("reports", ids.r[0]);
    const kept = now.remarks === "確認の直後に割り込んだ変更";
    await db.dbPut("reports", r0); // 割り込んだ変更だけを元に戻して、ほかが何も変わっていないかを比べる
    const others = (await T.snapshot()) === before;
    return { injected, stale, msg: msg.slice(0, 80), kept, others, restorePuts };
  }, ids);
  check("A9・A7 確認の直後（復元のトランザクションの直前）に別の処理が書き込んでも、トランザクションの中の確認で検出して中止。割り込んだ変更は上書きされず、どのストアにも1件も書き込まない（put 0回）", race.injected && race.stale && race.kept && race.others && race.restorePuts === 0, JSON.stringify(race));

  // ===== A8・A9 変化が無ければ従来どおり成功し、確認の読み取りと書き込みが同じトランザクションで行われる =====
  const normal = await page.evaluate(async (ids) => {
    const T = window.T; const { db } = T;
    const a = await T.analyze("newer");
    const watched = a.guard.records.size; const whole = Object.keys(a.guard.wholeStores).length;
    const log = new Map(); // readwrite の各トランザクション → { gets, getAlls, puts }
    const o = { get: IDBObjectStore.prototype.get, getAll: IDBObjectStore.prototype.getAll, put: IDBObjectStore.prototype.put };
    const rec = (kind) => function (...args) { const t = this.transaction; if (t.mode === "readwrite") { const e = log.get(t) || { gets: 0, getAlls: 0, puts: 0, metaPuts: 0, stores: t.objectStoreNames.length }; if (kind === "puts" && this.name === "meta") e.metaPuts++; else e[kind]++; log.set(t, e); } return o[kind === "gets" ? "get" : kind === "getAlls" ? "getAll" : "put"].apply(this, args); };
    IDBObjectStore.prototype.get = rec("gets"); IDBObjectStore.prototype.getAll = rec("getAlls"); IDBObjectStore.prototype.put = rec("puts");
    let res;
    try { res = await T.bk.applyBackupRestore(a).then((r) => ({ ok: true, counts: r.counts }), (e) => ({ ok: false, msg: e.message })); } finally { Object.assign(IDBObjectStore.prototype, o); }
    const txs = [...log.values()].filter((e) => (e.puts > 0 || e.metaPuts > 0) && e.stores > 1);
    return { res, state: a.state, watched, whole, txs, rep: (await db.dbGet("reports", ids.r[0])).remarks, site: (await db.dbGet("sites", ids.s1)).address };
  }, ids);
  check("A8 計画の後に変化が無ければ、従来どおり復元が成功する（7件の上書き）", normal.res.ok && normal.state === "applied" && normal.rep === "バックアップで直した連絡" && normal.site === "バックアップで直した住所", JSON.stringify(normal.res));
  check("A9 確認の読み取り（見張るレコード全件の get・現場とテンプレートの getAll）と7件の書き込み・復元の記録（退避と状態の2件）が、同じ1つの readwrite トランザクションで行われる", normal.txs.length === 1 && normal.txs[0].gets === normal.watched && normal.txs[0].getAlls === normal.whole && normal.txs[0].puts === 7 && normal.txs[0].metaPuts === 2, JSON.stringify({ watched: normal.watched, whole: normal.whole, txs: normal.txs }));
  // B0 の時点に戻して続ける
  const back3 = await page.evaluate(async () => { const T = window.T; const a = await T.analyze("B0"); return T.bk.applyBackupRestore(a, { applyKeys: new Set(a.items.map((i) => i.key)) }).then(() => "ok", (e) => e.message); });
  check("（準備）B0 の時点に戻せる（変更履歴を除いて B0 と一致）", back3 === "ok" && (await page.evaluate(() => window.T.snapshot(["auditLog"]))) === S1, back3);
  const S1full = await page.evaluate(() => window.T.snapshot());
  const unchanged1 = async () => (await page.evaluate(() => window.T.snapshot())) === S1full;

  // ===== 11 同じ updatedAt で内容が違う・12 updatedAt が無い =====
  await mutate("sameTime", "reports", (a) => a.map((x, i) => (i === 0 ? { ...x, remarks: "同じ時刻で違う内容" } : x)));
  let a11 = await page.evaluate(async () => { const a = await window.T.analyze("sameTime"); return a.items.filter((i) => i.store === "reports" && i.action === "conflict").map((i) => i.reason); });
  r = await tryRestore("sameTime");
  check("11 同じ updatedAt で内容が違う日報: 競合（既定はローカルを残す）として表示し、選ばなければ変わらない", a11.length === 1 && a11[0].includes("更新日時が同じ") && r.ok && (await page.evaluate((id) => window.T.db.dbGet("reports", id), ids.r[0])).remarks === "連絡 2026-09-10", a11.join());
  await mutate("noStamp", "reports", (a) => a.map((x, i) => (i === 1 ? (() => { const y = { ...x, remarks: "updatedAtの無い古い内容" }; delete y.updatedAt; return y; })() : x)));
  const a12 = await page.evaluate(async () => (await window.T.analyze("noStamp")).items.filter((i) => i.store === "reports" && i.action === "conflict").map((i) => i.reason));
  r = await tryRestore("noStamp");
  check("12 updatedAt が無いレコード: 競合として表示し（黙って上書きしない）、選ばなければ変わらない", a12.length === 1 && a12[0].includes("updatedAt") && r.ok && (await page.evaluate((id) => window.T.db.dbGet("reports", id), ids.r[1])).remarks === "連絡 2026-09-11");

  // ===== 13 論理削除したデータ・14 物理削除したデータの復活候補 =====
  await page.evaluate(async (ids) => {
    const { deleteReportWithAttachments } = await import("/js/reports.js"); const { deletePhoto } = await import("/js/photos.js"); const { deleteKyVendor } = await import("/js/ky/kySubmissions.js");
    await deleteReportWithAttachments(ids.r[2]); // 論理削除（日報）
    await deletePhoto(ids.photo2); // 物理削除・削除の記録あり（2026-10-18 から）
    await deleteKyVendor(ids.ky2); // 物理削除・削除の記録あり
    await window.T.db.dbDelete("photos", ids.photo); // 物理削除・削除の記録なし（以前の削除の再現）
  }, ids);
  const S2 = await page.evaluate(() => window.T.snapshot(["auditLog"]));
  const a13 = await page.evaluate(async (ids) => { const a = await window.T.analyze("B0"); const f = (id) => a.items.find((i) => i.id === id); return { ok: a.ok, rep: f(ids.r[2]), p2: f(ids.photo2), p1: f(ids.photo), ky2: f(ids.ky2) }; }, ids);
  check("13 論理削除した日報: 競合「この端末では削除済み（復元すると戻る）」として表示し、既定では戻さない", a13.ok && a13.rep.action === "conflict" && a13.rep.reason.includes("削除済み") && a13.rep.defaultApply === false, a13.rep?.reason);
  check("14 物理削除した写真（削除の記録あり）・KY（記録あり）: 「復元候補・要確認」（この端末で削除した記録あり）。既定では戻さない", a13.p2.action === "candidate" && a13.p2.reason.includes("削除した記録があります") && a13.ky2.action === "candidate" && !a13.p2.defaultApply && !a13.ky2.defaultApply, `${a13.p2.reason} / ${a13.ky2.reason}`);
  check("14 削除の記録が無い写真: 削除済みと断定せず「復元候補・要確認（削除の記録は無い）」。既定では戻さない", a13.p1.action === "candidate" && a13.p1.reason.includes("断定できません") && !a13.p1.defaultApply, a13.p1.reason);
  r = await tryRestore("B0");
  check("13・14 選ばずに復元すると、削除した日報・写真・KYは戻らない（変更履歴に「復元」が1件増える以外、保存データは変わらない）", r.ok && (await page.evaluate(() => window.T.snapshot(["auditLog"]))) === S2);
  r = await page.evaluate((k) => window.T.restore("B0", k), [`reports:${ids.r[2]}`, `photos:${ids.photo2}`, `kySubmissions:${ids.ky2}`]);
  const back13 = await page.evaluate(async (ids) => { const { db } = window.T; return { rep: (await db.dbGet("reports", ids.r[2])).isDeleted, p2: !!(await db.dbGet("photos", ids.photo2)), ky2: !!(await db.dbGet("kySubmissions", ids.ky2)), p1: !!(await db.dbGet("photos", ids.photo)) }; }, ids);
  check("13・14 利用者が選んだもの（日報・写真・KY）だけが戻り、選ばなかった写真は戻らない", r.ok && back13.rep === false && back13.p2 && back13.ky2 && !back13.p1, JSON.stringify(back13));

  // ===== 15 標準テンプレートの重複・16 現場の固定の参照先が無い =====
  await page.evaluate(async () => { const T = window.T; const tp = await T.readJson("B0", "data/reportTemplates.json"); const cur = tp.find((x) => (x.templateKind || "report") === "report"); const extra = { ...cur, id: "別の標準テンプレート", isAppDefault: true }; await T.modify("B0", "twoDefaults", { "data/reportTemplates.json": JSON.stringify([...tp, extra]), "manifest.json": JSON.stringify({ ...(await T.readJson("B0", "manifest.json")), recordCounts: { ...(await T.readJson("B0", "manifest.json")).recordCounts, reportTemplates: tp.length + 1 } }) }); });
  const S3 = await page.evaluate(() => window.T.snapshot());
  r = await tryRestore("twoDefaults");
  check("15 復元すると標準テンプレートが2件になる: 検査で中止・変わらない", !r.ok && r.errors.some((e) => e.includes("標準テンプレートが2件")) && (await page.evaluate(() => window.T.snapshot())) === S3, r.errors?.[0]);
  await mutate("badPin", "sites", (a) => a.map((x, i) => (i === 0 ? { ...x, updatedAt: "2099-01-01T00:00:00.000Z", templatePin: { templateId: "存在しないテンプレート", sha256: "0".repeat(64), revision: 1 } } : x)));
  r = await tryRestore("badPin");
  check("16 現場の固定（templatePin）が存在しないテンプレートを指す: 検査で中止・変わらない", !r.ok && r.errors.some((e) => e.includes("固定しているテンプレート")) && (await page.evaluate(() => window.T.snapshot())) === S3, r.errors?.[0]);

  // ===== 形式の版: 新しい形式・新しいDBの版は中止、従来の形式（版の記載なし）は受け付ける =====
  for (const [label, patch] of [["formatVersion 3", { formatVersion: 3 }], ["dbVersion 11", { dbVersion: 11 }]]) {
    await page.evaluate(async (patch) => { const T = window.T; const m = await T.readJson("B0", "manifest.json"); await T.modify("B0", "future", { "manifest.json": JSON.stringify({ ...m, ...patch }) }); }, patch);
    r = await tryRestore("future");
    check(`このアプリより新しい形式（${label}）のバックアップは、書き込まずに中止`, !r.ok && r.errors.some((e) => e.includes("新しい")) && (await page.evaluate(() => window.T.snapshot())) === S3, r.errors?.[0]);
  }
  await page.evaluate(async () => { const T = window.T; const m = await T.readJson("B0", "manifest.json"); delete m.formatVersion; delete m.dbVersion; delete m.blobs; await T.modify("B0", "legacy", { "manifest.json": JSON.stringify(m) }); });
  const legacy = await page.evaluate(async () => { const a = await window.T.analyze("legacy"); return { ok: a.ok, legacy: a.format.legacy, errors: a.errors.length }; });
  check("従来の形式（formatVersion・dbVersion・指紋の一覧なし）のバックアップは拒否せず、版1として検査できる", legacy.ok && legacy.legacy === true, JSON.stringify(legacy));

  // ===== 1・17・19・20 正常な復元（空の端末へ、画面の手順で）: 旧版テンプレートを含む・添付ファイル・全ストアの整合性 =====
  await passZip("B0");
  const zipPath = path.join(dir, "B0.zip");
  fs.writeFileSync(zipPath, Buffer.from(await page.evaluate(() => { const u = window.T.zips.B0; let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }), "base64"));
  await pe.goto(`${BASE}#/backup`); await pe.waitForSelector("#view-backup:not([hidden])");
  const planText = await (async () => { await pe.setInputFiles("#restoreFileInput", zipPath); await pe.waitForFunction(() => document.getElementById("backupRestoreDialog").open); const t = await pe.textContent("#restorePlan"); await pe.click("#restoreCancelBtn"); return t; })();
  check("2 復元の内容の表示: ストアごとに 新規・上書き・同じ内容・ローカルを残す・復元候補・添付ファイル・検査エラー の件数を出す（空の端末なので新規）", ["新規", "上書き", "同じ内容", "ローカルを残す", "復元候補", "添付ファイル", "検査エラー"].every((w) => planText.includes(w)) && (await emptyUnchanged()));
  // 復元前のバックアップを作らないと「復元する」は押せない
  await pe.setInputFiles("#restoreFileInput", zipPath); await pe.waitForFunction(() => document.getElementById("backupRestoreDialog").open);
  check("復元前のバックアップを作り、保存の確認にチェックするまで「復元する」は押せない", await pe.isDisabled("#restoreApplyBtn"));
  await pe.click("#restoreCancelBtn");
  await restoreViaUi(pe, zipPath);
  const fresh = await pe.evaluate(() => window.T.snapshot(["auditLog"]));
  const s0NoAudit = await page.evaluate((s0) => { const o = JSON.parse(s0); delete o.auditLog; return JSON.stringify(o); }, S0);
  check("1・20 正常なバックアップを空の端末へ復元: 変更履歴以外のすべてのストアの id・内容・件数が元と一致", fresh === s0NoAudit);
  const fr = await pe.evaluate(async (ids) => { const { db, sha } = window.T; const t = await db.dbGet("reportTemplates", ids.t); const ta = await db.dbGet("reportTemplates", ids.tArch); const s1 = await db.dbGet("sites", ids.s1); return { t: [t.id, t.revision, (await sha(t.sourceFileBlob)) === t.sourceFileSha256], ta: [ta.templateKind, ta.archivedOf === ids.t, (await sha(ta.sourceFileBlob)) === ta.sourceFileSha256], pin: s1.templatePin.sha256 === ta.sourceFileSha256, photo: await sha((await db.dbGet("photos", ids.photo)).blob), sig: await sha((await db.dbGet("signatures", ids.sig)).imageBlob) }; }, ids);
  const src = await page.evaluate(async () => { const T = window.T; const m = await T.readJson("B0", "manifest.json"); return m.blobs; });
  check("17 旧版テンプレート（退避した第1版）を含めて復元: テンプレートのid・版・SHA-256が一致し、現場Aの固定（第1版）が解決できる", fr.t[1] === 2 && fr.t[2] && fr.ta[0] === "report_archive" && fr.ta[1] && fr.ta[2] && fr.pin, JSON.stringify(fr));
  check("19 添付ファイル: 復元した写真・署名の SHA-256 がバックアップに記録された指紋と一致", Object.values(src).includes(fr.photo) && Object.values(src).includes(fr.sig));
  const auditRestored = await pe.evaluate(async () => (await window.T.db.dbGetAll("auditLog")).some((a) => a.entityType === "backup" && a.summary.includes("復元")));
  check("復元が終わってから、変更履歴に「バックアップから復元」を記録する", auditRestored);

  // ===== A 画面: 計画を作った後に端末のデータが変わると中止し、再検査して計画を作り直す。復元前のバックアップも作り直しを求める =====
  await passZip("newer");
  const newerPath = path.join(dir, "newer.zip");
  fs.writeFileSync(newerPath, Buffer.from(await pe.evaluate(() => { const u = window.T.zips.newer; let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }), "base64"));
  await pe.setInputFiles("#restoreFileInput", newerPath); await pe.waitForFunction(() => document.getElementById("backupRestoreDialog").open);
  await pe.click("#restorePreBackupBtn");
  await pe.waitForFunction(() => !document.getElementById("restorePreBackupConfirmLabel").hidden, null, { timeout: 60000 });
  await pe.check("#restorePreBackupConfirm");
  // 計画の後に、別の処理が日報 r0 を変更する（updatedAt は同じ）
  await pe.evaluate(async (id) => { const { db } = window.T; const r = await db.dbGet("reports", id); await db.dbPut("reports", { ...r, remarks: "復元の画面を開いている間に別のタブで直した" }); }, ids.r[0]);
  const SU = await pe.evaluate(() => window.T.snapshot());
  await pe.click("#restoreApplyBtn");
  await pe.waitForFunction(() => /計画作成後に変更/.test(document.getElementById("restoreStatus").textContent), null, { timeout: 60000 });
  const ui = await pe.evaluate(() => ({ open: document.getElementById("backupRestoreDialog").open, status: document.getElementById("restoreStatus").textContent, msg: document.getElementById("message").textContent, applyDisabled: document.getElementById("restoreApplyBtn").disabled, confirmHidden: document.getElementById("restorePreBackupConfirmLabel").hidden, confirmChecked: document.getElementById("restorePreBackupConfirm").checked, preStatus: document.getElementById("restorePreBackupStatus").textContent, plan: document.getElementById("restorePlan").textContent }));
  check("A 画面: 「端末のデータが計画作成後に変更されたため、復元を中止しました。最新の状態を再検査してください」を表示し、何も書かない（すべてのストアが変わらない）", ui.open && ui.msg.includes("端末のデータが計画作成後に変更されたため、復元を中止しました。最新の状態を再検査してください") && ui.status.includes("検査し直し") && (await pe.evaluate(() => window.T.snapshot())) === SU, ui.status.slice(0, 120));
  check("A 画面: 再検査して計画を作り直し、古い計画では押せない（復元前のバックアップの作成と保存の確認を、もう一度求める）", ui.applyDisabled && ui.confirmHidden && !ui.confirmChecked && ui.preStatus === "" && ui.plan.includes("上書き"), JSON.stringify({ applyDisabled: ui.applyDisabled, confirmHidden: ui.confirmHidden }));
  // 作り直した計画で、復元前のバックアップを作り直して復元すると成功する（変更後の r0 も、バックアップの方が新しいので上書き）
  await pe.click("#restorePreBackupBtn");
  await pe.waitForFunction(() => !document.getElementById("restorePreBackupConfirmLabel").hidden, null, { timeout: 60000 });
  await pe.check("#restorePreBackupConfirm");
  await pe.click("#restoreApplyBtn");
  await pe.waitForFunction(() => !document.getElementById("backupRestoreDialog").open || /復元できませんでした|計画作成後/.test(document.getElementById("restoreStatus").textContent), null, { timeout: 60000 });
  const uiAfter = await pe.evaluate(async (ids) => ({ open: document.getElementById("backupRestoreDialog").open, rep: (await window.T.db.dbGet("reports", ids.r[0])).remarks, site: (await window.T.db.dbGet("sites", ids.s1)).address }), ids);
  check("A 画面: 作り直した計画で、復元前のバックアップを作り直してから復元すると成功する", !uiAfter.open && uiAfter.rep === "バックアップで直した連絡" && uiAfter.site === "バックアップで直した住所", JSON.stringify(uiAfter));

  // ===================================================================================================
  // B 確定した後の確認で食い違いが見つかったときの退避と復旧（別の空の端末で。架空データ）
  //   合格条件: すべてのストアの id・内容・件数（添付は SHA-256）が期待どおり（失敗の後は変わらない／復旧の後は復元の前と同じ）
  // ===================================================================================================
  /** B の試験用の道具（ページを開き直したら、もう一度入れる） */
  const installBTools = (pg) => pg.evaluate(() => {
    const T = window.T;
    // 確定した後の確認を失敗させる道具: 復元・復旧のトランザクション（meta を含む複数のストア）が完了した後、SHA-256 の計算を
    // 「違う値を返す」（wrong）か「終わらない」（hang）にする。disarm() で元に戻す
    window.injectAfterCommit = (mode) => {
      const origTx = IDBDatabase.prototype.transaction; const sub = crypto.subtle; const origDigest = sub.digest; let armed = false; let once = true;
      IDBDatabase.prototype.transaction = function (scope, txMode, ...rest) {
        const t = origTx.call(this, scope, txMode, ...rest);
        if (once && txMode === "readwrite" && Array.isArray(scope) && scope.length > 1 && scope.includes("meta")) { once = false; t.addEventListener("complete", () => { armed = true; }); }
        return t;
      };
      sub.digest = function (...a) { if (armed) return mode === "hang" ? new Promise(() => {}) : Promise.resolve(new ArrayBuffer(32)); return origDigest.apply(this, a); };
      window.disarm = () => { IDBDatabase.prototype.transaction = origTx; delete sub.digest; };
    };
    window.T.hasData = async (restoreId) => !!(await T.db.dbGet("meta", `restoreJournalData:${restoreId}`));
    window.T.auditCount = async () => (await T.db.dbGetAll("auditLog")).length;
  });
  /** ページを開き直す前後で、作ったバックアップ（zip）を引き継ぐ */
  const takeZips = (pg) => pg.evaluate(() => Object.fromEntries(Object.entries(window.T.zips).map(([k, u]) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return [k, btoa(s)]; })));
  const putZips = (pg, z) => pg.evaluate((z) => { for (const [k, b] of Object.entries(z)) { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.T.zips[k] = u; } }, z);
  const ctxB = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-b-")), { acceptDownloads: true });
  let pb = await ctxB.newPage(); pb.on("pageerror", (e) => errors.push(e.message)); pb.on("dialog", (d) => d.accept());
  await pb.goto(BASE); await pb.waitForSelector("#view-site-list:not([hidden])"); await installTools(pb);
  const idsB = await seed(pb);
  await pb.evaluate(() => window.T.makeBackup("B0"));
  // 上書き（現場2・日報1・写真1（画像の中身も）・署名1（画像の中身も））と追加（日報1・その写真1・署名1）が混ざるバックアップ
  await pb.evaluate(async (ids) => {
    const T = window.T; const enc = (s) => new TextEncoder().encode(s); const J = (s) => T.readJson("B0", `data/${s}.json`);
    const m = await T.readJson("B0", "manifest.json"); const future = "2099-01-01T00:00:00.000Z"; const mods = {}; const blobs = { ...m.blobs };
    const setBlob = async (file, bytes) => { mods[file] = bytes; blobs[file] = await T.sha(new Blob([bytes])); };
    const sites = (await J("sites")).map((x) => ({ ...x, updatedAt: future, address: "Bで直した住所" }));
    const reports = (await J("reports")).map((x) => (x.id === ids.r[0] ? { ...x, updatedAt: future, remarks: "Bで直した連絡" } : x));
    const newRep = { ...reports[0], id: "B-新しい日報", date: "2026-09-20", remarks: "Bで追加", updatedAt: future };
    reports.push(newRep);
    const photos = await J("photos"); const sigs = await J("signatures");
    const p0 = photos.find((p) => p.id === ids.photo); await setBlob(p0.blobFile, enc("上書きした写真の中身（架空）")); Object.assign(p0, { updatedAt: future, caption: "Bで直した" });
    photos.push({ ...p0, id: "B-新しい写真", reportId: newRep.id, blobFile: "blobs/photos-blob-B-new.bin", caption: "追加" }); await setBlob("blobs/photos-blob-B-new.bin", enc("追加した写真の中身（架空）"));
    const s0 = sigs.find((x) => x.id === ids.sig); await setBlob(s0.imageBlobFile, enc("上書きした署名の中身（架空）")); Object.assign(s0, { updatedAt: future });
    sigs.push({ ...s0, id: "B-新しい署名", reportId: newRep.id, imageBlobFile: "blobs/signatures-imageBlob-B-new.bin" }); await setBlob("blobs/signatures-imageBlob-B-new.bin", enc("追加した署名（架空）"));
    Object.assign(mods, { "data/sites.json": JSON.stringify(sites), "data/reports.json": JSON.stringify(reports), "data/photos.json": JSON.stringify(photos), "data/signatures.json": JSON.stringify(sigs), "manifest.json": JSON.stringify({ ...m, blobs, recordCounts: { ...m.recordCounts, reports: reports.length, photos: photos.length, signatures: sigs.length } }) });
    await T.modify("B0", "mix", mods);
    // 従来の形式（版・指紋の一覧なし）の同じ内容
    const lm = JSON.parse(mods["manifest.json"]); delete lm.formatVersion; delete lm.dbVersion; delete lm.blobs;
    await T.modify("mix", "mixLegacy", { "manifest.json": JSON.stringify(lm) });
  }, idsB);
  await installBTools(pb);
  const snapB = (ex = []) => pb.evaluate((ex) => window.T.snapshot(ex), ex);
  const blobShaB = (store, id, field) => pb.evaluate(async ([s, i, f]) => { const r = await window.T.db.dbGet(s, i); return r && r[f] instanceof Blob ? window.T.sha(r[f]) : null; }, [store, id, field]);
  const PRE = await snapB(); const PRE_NOAUDIT = await snapB(["auditLog"]);
  const prePhotoSha = await blobShaB("photos", idsB.photo, "blob"); const preSigSha = await blobShaB("signatures", idsB.sig, "imageBlob");
  const preAudit = await pb.evaluate(() => window.T.auditCount());

  // ----- B2 書き込みの前に不整合を見つけたら、書き込まない（退避の記録も作らない） -----
  await pb.evaluate(async (ids) => { const T = window.T; const tp = await T.readJson("B0", "data/reportTemplates.json"); await T.modify("B0", "dupDef", { "data/reportTemplates.json": JSON.stringify(tp.map((x) => (x.id === ids.tArch ? { ...x, templateKind: "report", isAppDefault: true, updatedAt: "2000-01-01T00:00:00.000Z" } : x))) }); }, idsB);
  const b2 = await pb.evaluate(async (k) => { const T = window.T; const a = await T.analyze("dupDef"); const it = a.items.find((i) => i.key === k); let msg = ""; try { await T.bk.applyBackupRestore(a, { applyKeys: new Set([k]) }); } catch (e) { msg = e.message; } return { ok: a.ok, action: it?.action, msg, journals: (await T.bk.listRestoreJournals()).length }; }, `reportTemplates:${idsB.tArch}`);
  check("B2 利用者の選び方で標準テンプレートが2件になる・現場の固定が解決できなくなる: 書き込みを始める前に中止し、すべてのストアが変わらず、退避の記録も作らない", b2.ok && b2.action === "conflict" && b2.msg.includes("書き込みませんでした") && b2.msg.includes("標準テンプレートが2件") && b2.journals === 0 && (await snapB()) === PRE, b2.msg.slice(0, 120));

  // ----- B1 正常な復元: 確定した後の確認が成功し、記録は「確認成功」・退避は消える -----
  const b1 = await pb.evaluate(async () => { const T = window.T; const a = await T.analyze("mix"); const plan = { ow: a.items.filter((i) => i.action === "overwrite").length, nw: a.items.filter((i) => i.action === "new").length }; const r = await T.bk.applyBackupRestore(a).then((x) => ({ ok: true, id: x.restoreId }), (e) => ({ ok: false, msg: e.message })); const js = await T.bk.listRestoreJournals(); return { plan, r, js: js.map((j) => ({ state: j.state, ow: j.overwritten, add: j.added })), data: r.ok ? await T.hasData(r.id) : null }; });
  check("B1 正常な復元（上書き5件・追加3件）: 確定した後の確認が成功し、記録は「確認成功」、退避（画像を含む）は消える", b1.plan.ow === 5 && b1.plan.nw === 3 && b1.r.ok && b1.js.length === 1 && b1.js[0].state === "verified" && b1.js[0].ow === 5 && b1.js[0].add === 3 && b1.data === false, JSON.stringify(b1));
  const AFTER_OK = await snapB(["auditLog"]);
  // B0 の時点（PRE）に戻してから続ける（このテストの中だけ）: 追加した3件を消し、B0 をすべて選んで復元
  const resetB = async () => pb.evaluate(async () => { const T = window.T; for (const [s, id] of [["reports", "B-新しい日報"], ["photos", "B-新しい写真"], ["signatures", "B-新しい署名"]]) await T.db.dbDelete(s, id); const a = await T.analyze("B0"); return T.bk.applyBackupRestore(a, { applyKeys: new Set(a.items.map((i) => i.key)) }).then(() => "ok", (e) => e.message); });
  check("（準備）B0 の時点に戻せる（変更履歴を除いて一致）", (await resetB()) === "ok" && (await snapB(["auditLog"])) === PRE_NOAUDIT);
  const PRE2 = await snapB(); const PRE2_NOAUDIT = await snapB(["auditLog"]); const preAudit2 = await pb.evaluate(() => window.T.auditCount());

  // ----- B3 確定した後の確認の失敗を検出する（記録は「復旧が必要」・退避は残る・自動では戻さない） -----
  const failRestore = async (zip = "mix") => pb.evaluate(async (zip) => { const T = window.T; window.injectAfterCommit("wrong"); let r; try { const a = await T.analyze(zip); r = await T.bk.applyBackupRestore(a).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message, needs: !!e.needsRecovery, key: e.journalKey })); } finally { window.disarm(); } const j = (await T.bk.listRestoreJournals())[0]; return { ...r, state: j.state, restoreId: j.restoreId, data: await T.hasData(j.restoreId) }; }, zip);
  const b3 = await failRestore();
  const RESTORED = await snapB();
  check("B3 確定した後の確認で食い違い: 成功と表示せず（error.needsRecovery）、記録は「復旧が必要」、退避は残り、データは復元した状態のまま（自動では戻さない）", !b3.ok && b3.needs && b3.msg.includes("書き込み後の確認で食い違い") && b3.state === "needs_recovery" && b3.data && RESTORED !== PRE2 && (await snapB(["auditLog"])) === AFTER_OK, b3.msg?.slice(0, 100));
  // 決着していない記録があるあいだは、新しい復元をしない
  const blocked = await pb.evaluate(async () => { const T = window.T; const a = await T.analyze("B0"); return T.bk.applyBackupRestore(a).then(() => "（復元できてしまった）", (e) => e.message); });
  check("B 決着していない復元の記録があるあいだは、新しい復元を始めない（何も書かない）", blocked.includes("決着していません") && (await snapB()) === RESTORED, blocked.slice(0, 80));

  // ----- B9 復旧の途中でエラー（書き込みの2件目で例外・削除の1件目の後で中断）: 復旧の前の状態のまま・記録は「復旧失敗」・退避は残る -----
  for (const [label, mode] of [["2件目の書き込みで容量不足のエラー", "throw"], ["削除の1件目の後でトランザクションを中断", "abort"]]) {
    const r9 = await pb.evaluate(async ([key, mode]) => {
      const T = window.T; const op = IDBObjectStore.prototype.put; const od = IDBObjectStore.prototype.delete; let n = 0;
      const isRecoveryTx = (t) => t.mode === "readwrite" && t.objectStoreNames.length > 1 && t.objectStoreNames.contains("meta");
      IDBObjectStore.prototype.put = function (...a) { if (mode === "throw" && isRecoveryTx(this.transaction) && ++n === 2) throw new DOMException("模擬: 容量不足", "QuotaExceededError"); return op.apply(this, a); };
      IDBObjectStore.prototype.delete = function (...a) { const req = od.apply(this, a); if (mode === "abort" && isRecoveryTx(this.transaction) && this.name !== "meta") { IDBObjectStore.prototype.delete = od; this.transaction.abort(); } return req; };
      let msg = "";
      try { await T.bk.recoverRestore(key); msg = "（復旧できてしまった）"; } catch (e) { msg = e.message; } finally { IDBObjectStore.prototype.put = op; IDBObjectStore.prototype.delete = od; }
      const j = (await T.bk.listRestoreJournals()).find((x) => x.key === key);
      return { msg, state: j.state, data: await T.hasData(j.restoreId) };
    }, [b3.key, mode]);
    check(`B9 復旧の途中で${label}: 復旧全体を取り消し、すべてのストアが復旧の前のまま。記録は「復旧失敗」で退避は残る（もう一度試せる）`, !r9.msg.includes("できてしまった") && r9.state === "recovery_failed" && r9.data && (await snapB()) === RESTORED, r9.msg.slice(0, 80));
  }

  // ----- B10・B11 復元の後に利用者が編集したデータは、復旧で消さない（競合を示して中止） -----
  const restoredR0 = await pb.evaluate((id) => window.T.db.dbGet("reports", id), idsB.r[0]);
  await pb.evaluate(async (id) => { const { db } = window.T; const r = await db.dbGet("reports", id); await db.dbPut("reports", { ...r, remarks: "復元の後に利用者が直した連絡", updatedAt: new Date().toISOString() }); }, idsB.r[0]);
  const EDITED = await snapB();
  const b10 = await pb.evaluate(async (key) => { const T = window.T; let msg = ""; let conflicts = []; try { await T.bk.recoverRestore(key); } catch (e) { msg = e.message; conflicts = e.conflicts || []; } const j = (await T.bk.listRestoreJournals()).find((x) => x.key === key); return { msg, conflicts, state: j.state, savedConflicts: j.conflicts }; }, b3.key);
  check("B10・B11 復元の後に利用者が日報を直していると、復旧を中止して競合（その日報）を示し、直した内容を含めてすべてのストアが変わらない。記録に競合の一覧が残る", b10.msg.includes("復元の後に変更されたデータ") && b10.conflicts.length === 1 && b10.savedConflicts.length === 1 && b10.state === "recovery_failed" && (await snapB()) === EDITED && (await pb.evaluate((id) => window.T.db.dbGet("reports", id), idsB.r[0])).remarks === "復元の後に利用者が直した連絡", b10.conflicts.join());
  // 復元で追加した日報に、復元の後で写真を足していると、その日報を消すと写真が宙に浮くので中止する
  await pb.evaluate(async (r0) => { const { db } = window.T; await db.dbPut("reports", r0); const { stampNew } = await import("/js/utils.js"); await db.dbPut("photos", stampNew({ id: "復元の後に足した写真", reportId: "B-新しい日報", blob: new Blob([new TextEncoder().encode("後から足した写真（架空）")], { type: "image/png" }), mimeType: "image/png", order: 1, caption: "" })); }, restoredR0);
  const CHILD = await snapB();
  const b11 = await pb.evaluate(async (key) => { const T = window.T; let msg = ""; let conflicts = []; try { await T.bk.recoverRestore(key); } catch (e) { msg = e.message; conflicts = e.conflicts || []; } return { msg, conflicts }; }, b3.key);
  check("B11 復元で追加した日報に、復元の後で写真が足されている: その写真が宙に浮くため復旧を中止し（競合として示す）、すべてのストアが変わらない", b11.msg.includes("参照するデータが足されている") && b11.conflicts.some((c) => c.includes("復元の後に足した写真")) && (await snapB()) === CHILD, b11.msg.slice(0, 100));
  await pb.evaluate(() => window.T.db.dbDelete("photos", "復元の後に足した写真")); // 利用者が手動で片付けたことにする
  check("（準備）利用者が手動で対応した後は、復元の直後の状態と同じ", (await snapB()) === RESTORED);

  // ----- B4〜B8 復旧: 上書きしたものは元の内容に、追加したものは消え、写真・署名の画像も元に戻る。記録は「復旧済み」・退避は消える -----
  const b4 = await pb.evaluate(async (key) => { const T = window.T; const r = await T.bk.recoverRestore(key).then((x) => ({ ok: true, ...x }), (e) => ({ ok: false, msg: e.message })); const j = (await T.bk.listRestoreJournals()).find((x) => x.key === key); return { r, state: j.state, data: await T.hasData(j.restoreId), added: await Promise.all([["reports", "B-新しい日報"], ["photos", "B-新しい写真"], ["signatures", "B-新しい署名"]].map(async ([s, id]) => !!(await T.db.dbGet(s, id)))) }; }, b3.key);
  check("B4 確定した後の確認の失敗から、利用者の操作で復旧できる（戻した5件・削除3件）。記録は「復旧済み」、退避は消える", b4.r.ok && b4.r.restored === 5 && b4.r.deleted === 3 && b4.state === "recovered" && b4.data === false, JSON.stringify(b4.r));
  check("B5・B7 復旧の後、変更履歴（復旧の記録が1件増える）以外のすべてのストアの id・内容・件数が復元の前と同じ（上書きしたものは元の内容）", (await snapB(["auditLog"])) === PRE2_NOAUDIT && (await pb.evaluate(() => window.T.auditCount())) === preAudit2 + 1);
  check("B6 復元で追加した日報・写真・署名は、復旧の後に残らない", b4.added.every((x) => x === false), JSON.stringify(b4.added));
  check("B8 上書きした写真・署名の画像が、元の中身（SHA-256）に戻る", (await blobShaB("photos", idsB.photo, "blob")) === prePhotoSha && (await blobShaB("signatures", idsB.sig, "imageBlob")) === preSigSha);
  // ----- B13 同じ復旧を二度は実行できない -----
  const AFTER_REC = await snapB();
  const b13 = await pb.evaluate((key) => window.T.bk.recoverRestore(key).then(() => "（二度目も実行できてしまった）", (e) => e.message), b3.key);
  check("B13 復旧が済んだ後に同じ復旧をもう一度押しても実行しない（すべてのストアが変わらない）", b13.includes("復旧済み") && b13.includes("復旧できません") && (await snapB()) === AFTER_REC, b13);

  // ----- B 復旧せずに閉じる（利用者が選んだとき）: データは変えず、退避を消して記録を閉じる -----
  const b3b = await failRestore();
  const BEFORE_CLOSE = await snapB();
  const closed = await pb.evaluate(async (key) => { const T = window.T; await T.bk.closeRestoreJournal(key); const j = (await T.bk.listRestoreJournals()).find((x) => x.key === key); return { state: j.state, data: await T.hasData(j.restoreId), again: await T.bk.recoverRestore(key).then(() => "（復旧できてしまった）", (e) => e.message) }; }, b3b.key);
  check("B 「復旧せずに閉じる」: データは変えずに記録を閉じ（退避は消える）、閉じた記録からは復旧しない", closed.state === "closed" && closed.data === false && closed.again.includes("復旧できません") && (await snapB()) === BEFORE_CLOSE, JSON.stringify(closed));
  check("（準備）B0 の時点に戻せる", (await resetB()) === "ok" && (await snapB(["auditLog"])) === PRE_NOAUDIT);

  // ----- B12 確定した後・確認の前にページが閉じられた: 次に開いたとき未完了の復元を知らせ、利用者の操作で確認できる -----
  await pb.evaluate(async () => { const T = window.T; window.injectAfterCommit("hang"); const a = await T.analyze("mix"); T.bk.applyBackupRestore(a).catch(() => {}); });
  await waitForAsync(pb, async () => (await window.T.bk.listRestoreJournals()).some((j) => j.state === "written"), null, { timeout: 20000 });
  const zipsB = await takeZips(pb);
  await pb.close();
  pb = await ctxB.newPage(); pb.on("pageerror", (e) => errors.push(e.message)); pb.on("dialog", (d) => d.accept());
  await pb.goto(BASE); await pb.waitForSelector("#view-site-list:not([hidden])");
  await pb.waitForFunction(() => /バックアップからの復元が完了していません/.test(document.getElementById("restorePendingBanner").textContent), null, { timeout: 20000 });
  await installTools(pb); await putZips(pb, zipsB); await installBTools(pb);
  await pb.goto(`${BASE}#/backup`); await pb.waitForSelector("#restoreJournalSection:not([hidden])");
  const b12 = await pb.evaluate(() => ({ text: document.getElementById("restoreJournalSection").textContent, verify: !!document.querySelector('[data-journal-action="verify"]'), recover: !!document.querySelector('[data-journal-action="recover"]') }));
  check("B12 確認の前にページが閉じられた復元を、次に開いたときに知らせ（自動では戻さない）、バックアップ管理に「書き込み済み・確認待ち」と確認・復旧のボタンを出す", b12.text.includes("書き込み済み・確認待ち") && b12.verify && b12.recover, b12.text.slice(0, 80));
  await pb.click('[data-journal-action="verify"]');
  await pb.waitForSelector("#restoreJournalSection", { state: "hidden", timeout: 20000 });
  const b12v = await pb.evaluate(async () => (await window.T.bk.listRestoreJournals())[0].state);
  check("B12 利用者が「書き込みを確認する」を押すと確認し、成功なら「確認成功」になって未完了の一覧から消える（データは復元した状態）", b12v === "verified" && (await snapB(["auditLog"])) === AFTER_OK, b12v);
  // 画面からの復旧（確認の失敗 → バックアップ管理の「復元前の状態に戻す」）
  await pb.evaluate(async () => { const T = window.T; for (const [s, id] of [["reports", "B-新しい日報"], ["photos", "B-新しい写真"], ["signatures", "B-新しい署名"]]) await T.db.dbDelete(s, id); const a = await T.analyze("B0"); await T.bk.applyBackupRestore(a, { applyKeys: new Set(a.items.map((i) => i.key)) }); });
  const PRE3_NOAUDIT = await snapB(["auditLog"]);
  await pb.evaluate(async () => { const T = window.T; window.injectAfterCommit("wrong"); try { await T.bk.applyBackupRestore(await T.analyze("mix")); } catch { /* 復旧が必要 */ } finally { window.disarm(); } });
  await pb.goto(`${BASE}#/sites`); await pb.goto(`${BASE}#/backup`); await pb.waitForSelector("#restoreJournalSection:not([hidden])");
  await pb.click('[data-journal-action="recover"]');
  await pb.waitForSelector("#restoreJournalSection", { state: "hidden", timeout: 20000 });
  check("B 画面から「復元前の状態に戻す」を押すと復旧し（確認のうえ）、変更履歴以外が復元の前と同じになる", PRE3_NOAUDIT === PRE_NOAUDIT && (await snapB(["auditLog"])) === PRE3_NOAUDIT);

  // ----- B14 従来の形式のバックアップでも、退避・確認・復旧が同じように働く -----
  const b14 = await failRestore("mixLegacy");
  const b14r = await pb.evaluate((key) => window.T.bk.recoverRestore(key).then((x) => ({ ok: true, ...x }), (e) => ({ ok: false, msg: e.message })), b14.key);
  check("B14 従来の形式（版・指紋の一覧なし）のバックアップ: 確認の失敗を検出し、復旧で復元の前に戻る", b14.state === "needs_recovery" && b14r.ok && (await snapB(["auditLog"])) === PRE_NOAUDIT, JSON.stringify(b14r));
  const b14ok = await pb.evaluate(async () => { const T = window.T; const r = await T.bk.applyBackupRestore(await T.analyze("mixLegacy")).then(() => "ok", (e) => e.message); return { r, state: (await T.bk.listRestoreJournals())[0].state }; });
  check("B14 従来の形式のバックアップの正常な復元は、確認成功になる", b14ok.r === "ok" && b14ok.state === "verified" && (await snapB(["auditLog"])) === AFTER_OK, JSON.stringify(b14ok));

  // ----- B15 DBの版は10のまま・テンプレートのid・版・SHA-256 と現場の固定は、復元の前と同じ（復旧の後） -----
  const b15 = await pb.evaluate(async (ids) => { const T = window.T; const dbs = await indexedDB.databases(); const s1 = await T.db.dbGet("sites", ids.s1); const s2 = await T.db.dbGet("sites", ids.s2); const t = await T.db.dbGet("reportTemplates", ids.t); const ta = await T.db.dbGet("reportTemplates", ids.tArch); return { ver: (await import("/js/db.js")).DB_VERSION, idbVer: dbs.find((d) => d.name === "constructionReportsDB")?.version, pins: [s1.templatePin, s2.templatePin], t: [t.revision, t.sourceFileSha256 === (await T.sha(t.sourceFileBlob))], ta: [ta.revision, ta.sourceFileSha256 === (await T.sha(ta.sourceFileBlob))], pinOk: s1.templatePin.sha256 === ta.sourceFileSha256 && s2.templatePin.sha256 === t.sourceFileSha256 }; }, idsB);
  check("B15 DBの版は10のまま。テンプレートの版・SHA-256（中身と一致）・現場の固定（第1版・第2版）が保たれる", b15.ver === 10 && b15.idbVer === 10 && b15.t[0] === 2 && b15.t[1] && b15.ta[0] === 1 && b15.ta[1] && b15.pinOk, JSON.stringify({ ver: b15.ver, idbVer: b15.idbVer, t: b15.t, ta: b15.ta, pinOk: b15.pinOk }));
  await ctxB.close();

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctxE.close(); await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
