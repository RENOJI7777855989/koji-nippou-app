// 復元の安全性の追加の修正（2026-10-18）を確かめる（架空データ・Chromium・隔離したプロファイル）:
//   ・未完了の復元の知らせ（決着するまで上部に固定。通常の一時的なメッセージとは別）
//   ・署名の保存（書き直し・削除）を1つのトランザクションに
//   ・署名の重複（同じ日報・同じ業者の行・同じ役割）を、復元・確定した後の確認・復旧で検出
//   ・「復旧せずに記録を閉じる」の確認（退避データの削除を明記・確認欄が必要）
// 失敗するケースの合格条件: すべてのストアの id・内容・件数（添付は SHA-256）と、復元の記録（meta）が変わらないこと
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");
const { waitForAsync } = require("./helpers/wait.js");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

async function installTools(page) {
  await page.evaluate(async () => {
    const db = await import("/js/db.js"); const bk = await import("/js/backup.js"); const zu = await import("/js/zipUtil.js"); const sg = await import("/js/signatures.js");
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const sha = async (blob) => hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" && !(v instanceof Blob) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const rowsOf = async (list) => { const rows = []; for (const r of list) { const c = { ...r }; for (const k of Object.keys(c)) if (c[k] instanceof Blob) c[k] = `sha256:${await sha(c[k])}`; if (Array.isArray(c.entries)) c.entries = await Promise.all(c.entries.map(async (e) => { const x = { ...e }; if (x.before) { const b = { ...x.before }; for (const k of Object.keys(b)) if (b[k] instanceof Blob) b[k] = `sha256:${await sha(b[k])}`; x.before = b; } return x; })); rows.push(JSON.stringify(sortKeys(c))); } return rows.sort(); };
    window.T = {
      db, bk, zu, sg, sha, zips: {},
      async snapshot(exclude = []) { const out = {}; for (const s of bk.DATA_STORES) if (!exclude.includes(s)) out[s] = await rowsOf(await db.dbGetAll(s)); return JSON.stringify(out); },
      /** 復元の記録（meta の restoreJournal: と restoreJournalData:）。画像は指紋 */
      async journals() { const all = await db.dbGetAll("meta", null, IDBKeyRange.bound("restoreJournal", "restoreJournal￿")); return JSON.stringify(await rowsOf(all)); },
      async makeBackup(name) { const { blob } = await bk.exportFullBackup(); this.zips[name] = new Uint8Array(await blob.arrayBuffer()); },
      file(name) { return new File([this.zips[name]], `${name}.zip`); },
      async readJson(name, p) { return JSON.parse(await zu.readZipEntryText(zu.loadZip(this.zips[name].buffer), p)); },
      async modify(from, to, mods) { const m = new Map(Object.entries(mods).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v])); this.zips[to] = new Uint8Array(await zu.buildZip(zu.loadZip(this.zips[from].buffer), m, "application/zip").arrayBuffer()); },
      async analyze(name) { return bk.analyzeBackupFile(this.file(name)); },
      async png(color) { return new Promise((res) => { const c = document.createElement("canvas"); c.width = 24; c.height = 12; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(2, 2, 10, 6); c.toBlob(res, "image/png"); }); },
      live: async (rid, cid) => (await db.dbGetAll("signatures", "by_reportId", rid)).filter((s) => !s.isDeleted && s.companyId === cid).map((s) => s.id).sort()
    };
    // 確定した後の確認を失敗させる道具（復元・復旧のトランザクション（meta を含む複数のストア）の完了の後、SHA-256 を違う値にする）
    window.injectAfterCommit = () => {
      const origTx = IDBDatabase.prototype.transaction; const sub = crypto.subtle; const origDigest = sub.digest; let armed = false; let once = true;
      IDBDatabase.prototype.transaction = function (scope, m, ...r) { const t = origTx.call(this, scope, m, ...r); if (once && m === "readwrite" && Array.isArray(scope) && scope.length > 1 && scope.includes("meta")) { once = false; t.addEventListener("complete", () => { armed = true; }); } return t; };
      sub.digest = function (...a) { return armed ? Promise.resolve(new ArrayBuffer(32)) : origDigest.apply(this, a); };
      window.disarm = () => { IDBDatabase.prototype.transaction = origTx; delete sub.digest; };
    };
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-safety-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1024, height: 768 }, acceptDownloads: true });
  let page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
  await installTools(page);
  const snap = () => page.evaluate(() => window.T.snapshot());
  const journals = () => page.evaluate(() => window.T.journals());

  // 架空データ: 現場1・日報2（R: 業者の行 c1・c2、R2: c1・c2）。R の c1 と R2 の c1 に職長サイン
  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const T = window.T;
    const site = await createSite({ name: "復元安全の試験現場", startDate: "2026-09-01", endDate: "2026-09-30" });
    const mk = async (date) => { const r = stampNew({ siteId: site.id, date, dayStatus: "work", weather: "晴れ", companies: [{ companyId: "c1", companyName: "甲工業", occupation: "塗装", actualWorkerCount: "2" }, { companyId: "c2", companyName: "乙工業", occupation: "防水", actualWorkerCount: "3" }], remarks: `連絡 ${date}` }); await dbPut("reports", r); return r.id; };
    const R = await mk("2026-09-10"); const R2 = await mk("2026-09-11");
    const X = await T.sg.saveSignature({ reportId: R, companyId: "c1", blob: await T.png("#000") });
    const M = await T.sg.saveSignature({ reportId: R2, companyId: "c1", blob: await T.png("#00f") });
    return { site: site.id, R, R2, X: X.id, M: M.id };
  });

  // ===== 1 署名の重複の判定（純粋な関数） =====
  const u = await page.evaluate(() => {
    const { signatureDuplicateGroups, compareSignatureDuplicates } = window.T.sg;
    const s = (id, reportId, companyId, role = "foreman", isDeleted = false) => ({ id, reportId, companyId, role, isDeleted });
    return {
      same: [...signatureDuplicateGroups([s("a", "R", "c1"), s("b", "R", "c1")]).values()].map((x) => x.join()),
      otherReport: signatureDuplicateGroups([s("a", "R", "c1"), s("b", "R2", "c1")]).size,
      otherCompany: signatureDuplicateGroups([s("a", "R", "c1"), s("b", "R", "c2")]).size,
      otherRole: signatureDuplicateGroups([s("a", "R", "c1"), s("b", "R", "c1", "manager")]).size,
      deleted: signatureDuplicateGroups([s("a", "R", "c1"), s("b", "R", "c1", "foreman", true)]).size,
      added: compareSignatureDuplicates([s("a", "R", "c1")], [s("a", "R", "c1"), s("b", "R", "c1")]).added.length,
      existing: (() => { const r = compareSignatureDuplicates([s("a", "R", "c1"), s("b", "R", "c1")], [s("a", "R", "c1"), s("b", "R", "c1")]); return [r.added.length, r.existing.length]; })()
    };
  });
  check("署名の重複: 同じ日報・同じ業者の行・同じ役割の2件を重複と判定する", u.same.length === 1 && u.same[0] === "a,b", JSON.stringify(u.same));
  check("署名の重複: 別の日報・別の業者の行・別の役割・削除済みの署名は重複と判定しない", u.otherReport === 0 && u.otherCompany === 0 && u.otherRole === 0 && u.deleted === 0, JSON.stringify(u));
  check("署名の重複: 書き込みで新しく重複になる組と、前からある重複（増えていない）を分ける", u.added === 1 && u.existing[0] === 0 && u.existing[1] === 1, JSON.stringify(u));

  // ===== 2 署名の保存（書き直し・削除）を1つのトランザクションで =====
  const s1 = await page.evaluate(async (ids) => { const T = window.T; const n = await T.sg.saveSignature({ reportId: ids.R, companyId: "c2", blob: await T.png("#0a0") }); return { id: n.id, live: await T.live(ids.R, "c2") }; }, ids);
  check("署名の保存: 新しい署名が保存される", s1.live.length === 1 && s1.live[0] === s1.id);
  const s2 = await page.evaluate(async (ids) => {
    const T = window.T; const before = (await T.db.dbGetAll("auditLog")).length;
    const n = await T.sg.saveSignature({ reportId: ids.R, companyId: "c1", blob: await T.png("#f00"), replaceId: ids.X });
    const audit = (await T.db.dbGetAll("auditLog")).filter((a) => a.entityType === "signature" && a.entityId === ids.X && a.action === "delete");
    return { id: n.id, live: await T.live(ids.R, "c1"), oldExists: !!(await T.db.dbGet("signatures", ids.X)), audit: audit.map((a) => a.summary), added: (await T.db.dbGetAll("auditLog")).length - before };
  }, ids);
  check("署名の書き直し: 古い署名が削除され、新しい署名だけが残り、削除の変更履歴が1件（書き直し）残る", !s2.oldExists && s2.live.length === 1 && s2.live[0] === s2.id && s2.audit.length === 1 && s2.audit[0].includes("書き直し") && s2.added === 1, JSON.stringify(s2));
  ids.X = s2.id;
  for (const [label, mode] of [["新しい署名の保存で容量不足のエラー", "throw"], ["古い署名の削除の後でトランザクションを中断", "abort"], ["変更履歴の保存で容量不足のエラー", "auditThrow"]]) {
    const before = await snap();
    const r = await page.evaluate(async ([ids, mode]) => {
      const T = window.T; const op = IDBObjectStore.prototype.put; const od = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.put = function (...a) { if ((mode === "throw" && this.name === "signatures") || (mode === "auditThrow" && this.name === "auditLog")) throw new DOMException("模擬: 容量不足", "QuotaExceededError"); return op.apply(this, a); };
      IDBObjectStore.prototype.delete = function (...a) { const q = od.apply(this, a); if (mode === "abort" && this.name === "signatures") this.transaction.abort(); return q; };
      let msg = ""; try { await T.sg.saveSignature({ reportId: ids.R, companyId: "c1", blob: await T.png("#ff0"), replaceId: ids.X }); msg = "（保存できてしまった）"; } catch (e) { msg = e.message; } finally { IDBObjectStore.prototype.put = op; IDBObjectStore.prototype.delete = od; }
      return { msg, live: await T.live(ids.R, "c1") };
    }, [ids, mode]);
    check(`署名の書き直しの途中で${label}: 失敗として扱い、古い署名が残り、新しい署名も変更履歴も残らない（すべてのストアが変わらない）`, !r.msg.includes("できてしまった") && r.live.length === 1 && r.live[0] === ids.X && (await snap()) === before, r.msg.slice(0, 60));
  }
  // 削除: 変更履歴の保存に失敗したら、署名も消さない
  {
    const before = await snap();
    const r = await page.evaluate(async (ids) => { const T = window.T; const op = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (this.name === "auditLog") throw new DOMException("模擬", "QuotaExceededError"); return op.apply(this, a); }; let msg = ""; try { await T.sg.deleteSignature(ids.X); msg = "（削除できてしまった）"; } catch (e) { msg = e.message; } finally { IDBObjectStore.prototype.put = op; } return msg; }, ids);
    check("署名の削除で変更履歴を保存できない: 署名も削除しない（すべてのストアが変わらない）", !r.includes("できてしまった") && (await snap()) === before, r.slice(0, 60));
  }

  // 画面: 日報を開いて職長サインを書き直して保存 → 古い署名は消え、新しい署名1件・削除の変更履歴
  await page.goto(`${BASE}#/sites/${ids.site}/report/${ids.R}`); await page.waitForSelector("#reportForm .company-row");
  const canvas = page.locator(".company-row").first().locator(".signatureCanvas");
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down(); await page.mouse.move(box.x + 90, box.y + 50, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(100);
  await page.click("#reportSaveBtn");
  await page.waitForSelector("#view-site-detail:not([hidden])", { timeout: 15000 });
  await installTools(page);
  const ui = await page.evaluate(async (ids) => { const T = window.T; return { live: await T.live(ids.R, "c1"), old: !!(await T.db.dbGet("signatures", ids.X)), audit: (await T.db.dbGetAll("auditLog")).some((a) => a.entityId === ids.X && a.action === "delete" && a.summary.includes("書き直し")) }; }, ids);
  check("画面で職長サインを書き直して保存: その業者の行の署名は新しい1件だけ、古い署名は消え、削除の変更履歴が残る", ui.live.length === 1 && ui.live[0] !== ids.X && !ui.old && ui.audit, JSON.stringify(ui));
  ids.X = ui.live[0];

  // ===== 3 署名の重複の検出（復元・確定した後の確認・復旧）と、問題A・Bとの整合 =====
  await page.evaluate(() => window.T.makeBackup("B1")); // R の c1 は X（今の署名）
  // 書き直し（古い X は削除・変更履歴あり）→ バックアップの X は「復元候補」。選んで復元すると同じ行に2件になるので、確定する前に中止
  ids.X2 = await page.evaluate(async (ids) => { const T = window.T; return (await T.sg.saveSignature({ reportId: ids.R, companyId: "c1", blob: await T.png("#808"), replaceId: ids.X })).id; }, ids);
  const a1 = await page.evaluate(async (ids) => { const a = await window.T.analyze("B1"); const it = a.items.find((i) => i.key === `signatures:${ids.X}`); return { ok: a.ok, action: it?.action, reason: it?.reason }; }, ids);
  check("書き直した前の署名は、バックアップから見ると「復元候補・要確認（この端末で削除した記録があります）」（書き直しの削除の変更履歴が同じトランザクションで残っている）", a1.ok && a1.action === "candidate" && a1.reason.includes("削除した記録があります"), JSON.stringify(a1));
  {
    const before = await snap(); const jBefore = await journals();
    const r = await page.evaluate(async (ids) => { const T = window.T; const a = await T.analyze("B1"); try { await T.bk.applyBackupRestore(a, { applyKeys: new Set([`signatures:${ids.X}`]) }); return "（復元できてしまった）"; } catch (e) { return e.message; } }, ids);
    check("署名の重複（復元の確定前）: 書き直した前の署名を選んで復元すると同じ行に2件になるため、書き込まずに中止し、日報・業者の行・署名idを示す。すべてのストアと復元の記録が変わらない", r.includes("重複") && r.includes("2026-09-10") && r.includes("c1") && r.includes(ids.X) && r.includes(ids.X2) && (await snap()) === before && (await journals()) === jBefore, r.slice(0, 160));
    const r2 = await page.evaluate(async (ids) => { const T = window.T; const a = await T.analyze("B1"); await T.bk.applyBackupRestore(a); return { live: await T.live(ids.R, "c1"), state: (await T.bk.listRestoreJournals())[0].state }; }, ids);
    check("その署名を選ばなければ、従来どおり復元は成功し（確認成功）、署名は書き直した1件のまま", r2.live.length === 1 && r2.live[0] === ids.X2 && r2.state === "verified", JSON.stringify(r2));
  }
  // 前からある重複（R2 の c2 に2件）: 復元で増えなければ止めず、どちらも削除せず、知らせる
  const dupIds = await page.evaluate(async (ids) => { const T = window.T; const { stampNew } = await import("/js/utils.js"); const a = stampNew({ reportId: ids.R2, companyId: "c2", role: "foreman", roleLabel: "職長", imageBlob: await T.png("#123"), signedAt: "2026-09-11T01:00:00.000Z" }); const b = stampNew({ reportId: ids.R2, companyId: "c2", role: "foreman", roleLabel: "職長", imageBlob: await T.png("#456"), signedAt: "2026-09-11T02:00:00.000Z" }); await T.db.dbPut("signatures", a); await T.db.dbPut("signatures", b); return [a.id, b.id]; }, ids);
  await page.evaluate(async (dupIds) => { const T = window.T; await T.makeBackup("B2"); const sigs = await T.readJson("B2", "data/signatures.json"); await T.modify("B2", "B2newer", { "data/signatures.json": JSON.stringify(sigs.map((x) => (x.id === dupIds[0] ? { ...x, updatedAt: "2099-01-01T00:00:00.000Z", signedAt: "2026-09-11T03:00:00.000Z" } : x))) }); }, dupIds);
  const ex = await page.evaluate(async ([ids, dupIds]) => { const T = window.T; const a = await T.analyze("B2newer"); const r = await T.bk.applyBackupRestore(a).then(() => "ok", (e) => e.message); return { ok: a.ok, warnings: a.warnings, r, live: await T.live(ids.R2, "c2") }; }, [ids, dupIds]);
  check("前からある署名の重複（復元で増えない）: 復元は止めず（確認成功）、検査で「前から重複している署名」を知らせ、どちらの署名も削除しない", ex.ok && ex.r === "ok" && ex.warnings.some((w) => w.includes("前から重複") && w.includes(dupIds[0]) && w.includes(dupIds[1])) && ex.live.length === 2, JSON.stringify(ex).slice(0, 200));
  // 後片付け: 前からある重複を除く（このテストの中だけ。架空データ）
  await page.evaluate((dupIds) => Promise.all(dupIds.map((id) => window.T.db.dbDelete("signatures", id))), dupIds);

  // 確認とトランザクションの間に、別の処理が同じ行に署名を足す（トランザクションの前の検査は通る）→ トランザクションの中で重複を検出して中止
  await page.evaluate(async (ids) => { const T = window.T; await T.makeBackup("B3"); const sigs = await T.readJson("B3", "data/signatures.json"); await T.modify("B3", "B3newer", { "data/signatures.json": JSON.stringify(sigs.map((x) => (x.id === ids.M ? { ...x, updatedAt: "2099-01-01T00:00:00.000Z", signedAt: "2026-09-11T05:00:00.000Z" } : x))) }); }, ids);
  {
    const r = await page.evaluate(async (ids) => {
      const T = window.T; const { stampNew } = await import("/js/utils.js");
      const a = await T.analyze("B3newer");
      const intruder = stampNew({ reportId: ids.R2, companyId: "c1", role: "foreman", roleLabel: "職長", imageBlob: await T.png("#999"), signedAt: "2026-09-11T06:00:00.000Z" });
      const before = await T.snapshot();
      const origTx = IDBDatabase.prototype.transaction; let armed = true;
      IDBDatabase.prototype.transaction = function (scope, m, ...rest) { if (armed && m === "readwrite" && Array.isArray(scope) && scope.length > 1 && scope.includes("meta")) { armed = false; const t0 = origTx.call(this, ["signatures"], "readwrite"); t0.objectStore("signatures").put(intruder); } return origTx.call(this, scope, m, ...rest); };
      let msg = ""; try { await T.bk.applyBackupRestore(a); msg = "（復元できてしまった）"; } catch (e) { msg = e.message; } finally { IDBDatabase.prototype.transaction = origTx; }
      const kept = !!(await T.db.dbGet("signatures", intruder.id));
      await T.db.dbDelete("signatures", intruder.id);
      return { msg, kept, same: (await T.snapshot()) === before, state: a.state };
    }, ids);
    check("署名の重複（トランザクションの中）: 前の検査の後で同じ行に署名が足されると、トランザクションの中で重複を検出して中止し、何も書かない（足された署名は残る）", r.msg.includes("重複") && r.kept && r.same, r.msg.slice(0, 120));
  }
  // 確定した後の確認: 確定の直後（確認の前）に同じ行へ署名が足されると、確認で重複を検出して「復旧が必要」にする
  {
    const r = await page.evaluate(async (ids) => {
      const T = window.T; const { stampNew } = await import("/js/utils.js");
      const a = await T.analyze("B3newer");
      const intruder = stampNew({ reportId: ids.R2, companyId: "c1", role: "foreman", roleLabel: "職長", imageBlob: await T.png("#aaa"), signedAt: "2026-09-11T07:00:00.000Z" });
      const origTx = IDBDatabase.prototype.transaction; let armed = true;
      IDBDatabase.prototype.transaction = function (scope, m, ...rest) { const t = origTx.call(this, scope, m, ...rest); if (armed && m === "readwrite" && Array.isArray(scope) && scope.length > 1 && scope.includes("meta")) { armed = false; const db = this; t.addEventListener("complete", () => { origTx.call(db, ["signatures"], "readwrite").objectStore("signatures").put(intruder); }); } return t; };
      let res; try { res = await T.bk.applyBackupRestore(a).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message, needs: !!e.needsRecovery, key: e.journalKey })); } finally { IDBDatabase.prototype.transaction = origTx; }
      const j = (await T.bk.listRestoreJournals()).find((x) => x.key === res.key);
      // 後片付け: 足された署名を消してから復旧（確定した後の確認の検出だけを確かめる）
      await T.db.dbDelete("signatures", intruder.id);
      const rec = res.key ? await T.bk.recoverRestore(res.key).then(() => "ok", (e) => e.message) : "（記録なし）";
      return { ...res, state: j?.state, rec, M: (await T.db.dbGet("signatures", ids.M)).signedAt };
    }, ids);
    check("署名の重複（確定した後の確認）: 確認の前に同じ行へ署名が足されると、確認で重複を検出し、成功と表示せず「復旧が必要」にする（自動では戻さない）", !r.ok && r.needs && r.msg.includes("署名が重複") && r.state === "needs_recovery", (r.msg || "").slice(0, 120));
    check("（その後）足された署名を利用者が片付けると、復旧で復元の前に戻る", r.rec === "ok" && r.M !== "2026-09-11T05:00:00.000Z", r.rec);
  }
  // 復旧で重複になる: 復元で R2 の署名 M を c1 → c2 へ移した後、利用者が c1 に新しく署名 → 復旧で M を c1 に戻すと2件になるので中止
  {
    await page.evaluate(async (ids) => { const T = window.T; await T.makeBackup("B5"); const sigs = await T.readJson("B5", "data/signatures.json"); await T.modify("B5", "B5move", { "data/signatures.json": JSON.stringify(sigs.map((x) => (x.id === ids.M ? { ...x, companyId: "c2", updatedAt: "2099-01-01T00:00:00.000Z" } : x))) }); }, ids);
    const step = await page.evaluate(async (ids) => { const T = window.T; window.injectAfterCommit(); let key = null; try { await T.bk.applyBackupRestore(await T.analyze("B5move")); } catch (e) { key = e.journalKey; } finally { window.disarm(); } const y = await T.sg.saveSignature({ reportId: ids.R2, companyId: "c1", blob: await T.png("#0ff") }); return { key, y: y.id, state: (await T.bk.listRestoreJournals()).find((x) => x.key === key)?.state }; }, ids);
    const before = await snap();
    const r = await page.evaluate(async (key) => { try { await window.T.bk.recoverRestore(key); return { msg: "（復旧できてしまった）" }; } catch (e) { return { msg: e.message, conflicts: e.conflicts || [] }; } }, step.key);
    const jr = await page.evaluate(async (key) => (await window.T.bk.listRestoreJournals()).find((x) => x.key === key), step.key);
    check("署名の重複（復旧）: 復旧で同じ行の署名が2件になる場合は、復旧を中止し（復旧失敗。データは変わらない）、どちらの署名も削除しない", step.state === "needs_recovery" && r.msg.includes("重複") && jr.state === "recovery_failed" && (await snap()) === before && (await page.evaluate(async (ids) => (await window.T.live(ids.R2, "c1")).length, ids)) === 1, r.msg.slice(0, 140));
    // 後片付け: 利用者が新しい署名を消すと、復旧できる
    const r2 = await page.evaluate(async ([key, y, ids]) => { const T = window.T; await T.sg.deleteSignature(y); const x = await T.bk.recoverRestore(key).then(() => "ok", (e) => e.message); return { x, M: (await T.db.dbGet("signatures", ids.M)).companyId }; }, [step.key, step.y, ids]);
    check("（その後）利用者が新しい署名を片付けると、復旧で署名 M が元の業者の行（c1）に戻る", r2.x === "ok" && r2.M === "c1", JSON.stringify(r2));
  }

  // ===== 4 未完了の復元の知らせ =====
  // 「復旧が必要」の記録を1件作る（確定した後の確認を失敗させる）
  const keyA = await page.evaluate(async () => { const T = window.T; window.injectAfterCommit(); try { await T.bk.applyBackupRestore(await T.analyze("B3newer")); } catch (e) { return e.journalKey; } finally { window.disarm(); } return null; });
  await page.goto(`${BASE}#/sites`); await page.reload(); await page.waitForSelector("#view-site-list:not([hidden])");
  await installTools(page);
  await page.waitForSelector("#restorePendingBanner:not([hidden])", { timeout: 15000 });
  await page.waitForTimeout(3600);
  const n1 = await page.evaluate(() => ({ visible: !document.getElementById("restorePendingBanner").hidden, text: document.getElementById("restorePendingBanner").textContent, message: document.getElementById("message").textContent }));
  check("知らせ: 未完了の復元があると、起動の3秒より後も上部に表示されたまま（通常のメッセージ欄とは別）", n1.visible && n1.text.includes("復元が完了していません（1件）") && n1.text.includes("復旧が必要"), n1.text.slice(0, 80));
  // 下までスクロールしても見える
  const n2 = await page.evaluate(async () => { const pad = document.createElement("div"); pad.id = "testPad"; pad.style.height = "4000px"; document.querySelector("main").appendChild(pad); window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 200)); const rect = document.getElementById("restorePendingBanner").getBoundingClientRect(); const y = window.scrollY; pad.remove(); return { top: rect.top, bottom: rect.bottom, y }; });
  check("知らせ: 画面の下までスクロールしても、画面の上部に見えている", n2.y > 1000 && n2.top >= 0 && n2.top < 5 && n2.bottom > 20, JSON.stringify(n2));
  // 2件目（表示の確認のため、復元の記録（状態）だけを直接作る。この隔離したプロファイルだけ）
  await page.evaluate(async () => { const at = new Date(Date.now() + 1000).toISOString(); await window.T.db.dbPut("meta", { key: "restoreJournal:test-second", kind: "restoreJournal", restoreId: "test-second", fileName: "2件目の試験.zip", createdAt: at, state: "recovery_failed", stateAt: at, history: [], overwritten: 0, added: 0 }); });
  await page.goto(`${BASE}#/sites/${ids.site}`); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.waitForFunction(() => /（2件）/.test(document.getElementById("restorePendingBanner").textContent), null, { timeout: 10000 });
  const n3 = await page.evaluate(() => ({ items: [...document.querySelectorAll("#restorePendingBanner .restore-pending-list li")].map((li) => li.textContent) }));
  check("知らせ: 未完了の復元が2件あると、件数と各記録（状態・ファイル名）を表示する", n3.items.length === 2 && n3.items.some((t) => t.includes("2件目の試験.zip") && t.includes("復旧失敗")) && n3.items.some((t) => t.includes("復旧が必要")), JSON.stringify(n3.items));
  // 小さくしても、記録は変わらない・表示は残る
  {
    const before = await snap(); const jBefore = await journals();
    await page.click('#restorePendingBanner [data-banner-action="toggle"]');
    await page.waitForFunction(() => document.getElementById("restorePendingBanner").classList.contains("is-compact"));
    const n4 = await page.evaluate(() => ({ visible: !document.getElementById("restorePendingBanner").hidden, list: !!document.querySelector("#restorePendingBanner .restore-pending-list") }));
    check("知らせ: 「小さくする」は表示を1行にするだけで、表示は残り、復元の記録・退避・すべてのストアは変わらない", n4.visible && !n4.list && (await snap()) === before && (await journals()) === jBefore, JSON.stringify(n4));
    await page.click('#restorePendingBanner [data-banner-action="toggle"]');
  }
  // 画面の幅（スマートフォン・iPad縦・Windows）で横にはみ出さない
  for (const [w, h, label] of [[390, 844, "スマートフォン"], [768, 1024, "iPad縦"], [1366, 768, "Windows"]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(150);
    const o = await page.evaluate(() => { const b = document.getElementById("restorePendingBanner"); const r = b.getBoundingClientRect(); return { right: r.right, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, bsw: b.scrollWidth, bcw: b.clientWidth }; });
    check(`知らせ: ${label}の幅（${w}px）で横にはみ出さない`, o.right <= o.vw + 1 && o.sw <= o.vw + 1 && o.bsw <= o.bcw + 1, JSON.stringify(o));
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  // 通常の一時的なメッセージは従来どおり3秒で消える
  const msg = await page.evaluate(async () => { const { showMessage } = await import("/js/ui/common.js"); showMessage("通常のメッセージ（試験）"); const at0 = document.getElementById("message").textContent; await new Promise((r) => setTimeout(r, 3400)); return { at0, after: document.getElementById("message").textContent, banner: !document.getElementById("restorePendingBanner").hidden }; });
  check("通常の一時的なメッセージは、従来どおり表示されて約3秒で消える（未完了の復元の知らせは残る）", msg.at0 === "通常のメッセージ（試験）" && msg.after === "" && msg.banner, JSON.stringify(msg));
  // 知らせから、未完了の復元の画面を開ける
  await page.click('#restorePendingBanner [data-banner-action="open"]');
  await page.waitForSelector("#view-backup:not([hidden]) #restoreJournalSection:not([hidden])");
  check("知らせ: 「未完了の復元を確認する」でバックアップ管理の「未完了の復元」が開く", (await page.locator("#restoreJournalSection .restore-journal-item").count()) === 2);

  // ===== 5 「復旧せずに記録を閉じる」の確認 =====
  const item = (key) => `#restoreJournalSection .restore-journal-item[data-key="${key}"]`;
  await page.click(`${item("restoreJournal:test-second")} [data-journal-action="close"]`);
  await page.waitForFunction(() => document.getElementById("restoreCloseDialog").open);
  const c1 = await page.evaluate(() => { const d = document.getElementById("restoreCloseDialog"); return { text: d.textContent, okDisabled: document.getElementById("restoreCloseOkBtn").disabled, focused: document.activeElement?.id, okLabel: document.getElementById("restoreCloseOkBtn").textContent, cancelLabel: document.getElementById("restoreCloseCancelBtn").textContent }; });
  check("「復旧せずに記録を閉じる」の確認: 復旧ではないこと・復元前の状態に戻らないこと・削除される退避データの中身・同じ退避データで復旧できなくなることを明記する", ["この操作は復旧ではありません", "復元前の状態には戻りません", "削除されるもの", "退避データ", "同じ退避データを使って復旧（復元前の状態に戻す）することはできません", "削除されないもの"].every((w) => c1.text.includes(w)), c1.text.slice(0, 80));
  check("「復旧せずに記録を閉じる」の確認: 理解した旨の確認欄にチェックするまで実行できず、最初は［キャンセル（何もしない）］が選ばれている", c1.okDisabled && c1.focused === "restoreCloseCancelBtn" && c1.cancelLabel.includes("キャンセル") && c1.okLabel.includes("退避データを削除"), JSON.stringify({ okDisabled: c1.okDisabled, focused: c1.focused }));
  {
    const before = await snap(); const jBefore = await journals();
    await page.click("#restoreCloseCancelBtn");
    await page.waitForFunction(() => !document.getElementById("restoreCloseDialog").open);
    await page.waitForTimeout(200);
    check("「復旧せずに記録を閉じる」でキャンセル: 復元の記録・退避・すべてのストアは変わらない", (await snap()) === before && (await journals()) === jBefore);
  }
  // 「復旧が必要」の記録を、確認欄にチェックして閉じる → 退避が消え、同じ退避データでは復旧できない・データは変わらない
  {
    const before = await snap();
    await page.click(`${item(keyA)} [data-journal-action="close"]`);
    await page.waitForFunction(() => document.getElementById("restoreCloseDialog").open);
    await page.check("#restoreCloseConfirm");
    await page.click("#restoreCloseOkBtn");
    await page.waitForFunction((k) => !document.querySelector(`#restoreJournalSection .restore-journal-item[data-key="${k}"]`), keyA, { timeout: 10000 });
    const r = await page.evaluate(async (key) => { const T = window.T; const j = (await T.bk.listRestoreJournals()).find((x) => x.key === key); return { state: j.state, data: !!(await T.db.dbGet("meta", `restoreJournalData:${j.restoreId}`)), again: await T.bk.recoverRestore(key).then(() => "（復旧できてしまった）", (e) => e.message) }; }, keyA);
    check("「復旧せずに記録を閉じる」を実行: 記録は「復旧せずに閉じた」、退避データは削除され、同じ記録からは復旧できない。データ（すべてのストア）は変わらない", r.state === "closed" && !r.data && r.again.includes("復旧できません") && (await snap()) === before, JSON.stringify(r));
  }
  // 残りの1件を閉じると、知らせが消える（実際の記録を読み直してから）
  await page.click(`${item("restoreJournal:test-second")} [data-journal-action="close"]`);
  await page.waitForFunction(() => document.getElementById("restoreCloseDialog").open);
  await page.check("#restoreCloseConfirm"); await page.click("#restoreCloseOkBtn");
  await page.waitForSelector("#restorePendingBanner", { state: "hidden", timeout: 10000 });
  const gone = await page.evaluate(async () => ({ pending: (await window.T.bk.listRestoreJournals({ onlyUnresolved: true })).length, hasClass: document.body.classList.contains("has-restore-banner") }));
  check("知らせ: すべて決着すると（記録を読み直して未完了が0件になってから）表示が消える", gone.pending === 0 && !gone.hasClass, JSON.stringify(gone));
  // 起動し直しても、決着していれば知らせは出ない
  await page.reload(); await page.waitForSelector("#view-site-list:not([hidden]), #view-backup:not([hidden])"); await page.waitForTimeout(800);
  check("知らせ: 決着した後に開き直しても表示されない", await page.evaluate(() => document.getElementById("restorePendingBanner").hidden));

  // ===== 6 DBの版 =====
  const ver = await page.evaluate(async () => ({ v: (await import("/js/db.js")).DB_VERSION, idb: (await indexedDB.databases()).find((d) => d.name === "constructionReportsDB")?.version }));
  check("DBの版は10のまま", ver.v === 10 && ver.idb === 10, JSON.stringify(ver));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
