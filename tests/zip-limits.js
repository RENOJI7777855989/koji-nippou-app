// ZIP の読み込みの大きさの上限と、壊れた・不正な ZIP の拒否（2026-11-01。架空データ・隔離したプロファイル）
//   js/zipUtil.js の loadZip / readZipEntryBytes。正常な ZIP（無圧縮・deflate）は従来どおり読み、上限を超えるもの・申告と中身の
//   大きさが違うもの・範囲の外を指すもの・名前に「..」などがあるものは誤りにする。バックアップの復元では、書き込む前に止まり
//   端末のデータは変わらないことも確かめる
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-limits-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const r = await page.evaluate(async () => {
    const z = await import("/js/zipUtil.js");
    const enc = new TextEncoder();
    const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
    const tryLoad = async (u8, read = null) => { try { const zip = z.loadZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); if (read) await z.readZipEntryBytes(zip, read); return "OK"; } catch (e) { return e.message; } };
    // 中央ディレクトリの最初の項目の位置（EOCD から）
    const cdOf = (u8) => { const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); for (let i = u8.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) return { eocd: i, cd: v.getUint32(i + 16, true), v }; return null; };
    const out = {};
    // 正常: 無圧縮（バックアップと同じ）・deflate（xlsx と同じ）
    const files = new Map([["data/a.json", enc.encode(JSON.stringify({ x: "あ".repeat(1000) }))], ["blobs/p.jpg", new Uint8Array(5000).fill(7)]]);
    const stored = await bytesOf(z.buildZip({ buffer: new Uint8Array(0), entries: new Map() }, files));
    const deflated = await bytesOf(await z.buildZipCompressed({ buffer: new Uint8Array(0), entries: new Map() }, new Map([["xl/sheet.xml", enc.encode("<c>1</c>".repeat(200000))]])));
    out.okStored = await tryLoad(stored, "data/a.json");
    out.okDeflated = await tryLoad(deflated, "xl/sheet.xml");
    const zipD = z.loadZip(deflated.buffer.slice(0)); const txt = await z.readZipEntryText(zipD, "xl/sheet.xml");
    out.deflatedRoundTrip = txt === "<c>1</c>".repeat(200000);
    out.ratio = Math.round(zipD.entries.get("xl/sheet.xml").uncompressedSize / zipD.entries.get("xl/sheet.xml").compressedSize);
    // 1ファイルの展開後が上限を超える（中央ディレクトリの申告を書き換える）
    { const u = deflated.slice(); const { cd, v } = cdOf(u); v.setUint32(cd + 24, z.ZIP_LIMITS.maxEntryBytes + 1, true); out.entryTooBig = await tryLoad(u); }
    // 申告より大きく展開される（申告を小さくする）・申告より小さい（申告を大きくする）
    { const u = deflated.slice(); const { cd, v } = cdOf(u); v.setUint32(cd + 24, 1000, true); out.bomb = await tryLoad(u, "xl/sheet.xml"); }
    { const u = deflated.slice(); const { cd, v } = cdOf(u); v.setUint32(cd + 24, 1600001, true); out.shorter = await tryLoad(u, "xl/sheet.xml"); }
    // ファイル数が多すぎる（EOCD の件数を書き換える）
    { const u = stored.slice(); const { eocd, v } = cdOf(u); v.setUint16(eocd + 10, z.ZIP_LIMITS.maxEntries + 1, true); out.tooMany = await tryLoad(u); }
    // データがファイルの外にはみ出す（圧縮後の大きさを大きくする）
    { const u = deflated.slice(); const { cd, v } = cdOf(u); v.setUint32(cd + 20, u.length * 4, true); out.outOfRange = await tryLoad(u); }
    // 無圧縮なのに大きさが一致しない
    { const u = stored.slice(); const { cd, v } = cdOf(u); v.setUint32(cd + 24, v.getUint32(cd + 20, true) + 5, true); out.storedMismatch = await tryLoad(u); }
    // 名前に「..」・先頭の「/」
    const named = async (n) => tryLoad(await bytesOf(z.buildZip({ buffer: new Uint8Array(0), entries: new Map() }, new Map([[n, enc.encode("x")]]))));
    out.dotdot = await named("data/../../evil.json");
    out.abs = await named("/etc/evil.json");
    out.okName = await named("[Content_Types].xml");
    // 展開後の合計が上限を超える（各項目の申告は上限以内）
    { const many = new Map(); for (let i = 0; i < 10; i++) many.set(`b${i}.bin`, new Uint8Array(1000)); const u = await bytesOf(await z.buildZipCompressed({ buffer: new Uint8Array(0), entries: new Map() }, many));
      const { cd, v } = cdOf(u); let p = cd; for (let i = 0; i < 10; i++) { v.setUint32(p + 24, 250 * 1024 * 1024, true); const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true); p += 46 + nl + el + cl; }
      out.totalTooBig = await tryLoad(u); }
    out.limits = z.ZIP_LIMITS;
    return out;
  });
  check("正常な ZIP（無圧縮＝バックアップと同じ形式）は従来どおり読める", r.okStored === "OK", r.okStored);
  check("正常な ZIP（deflate＝Excel と同じ形式、圧縮率の高いファイルも）は従来どおり読め、中身も同じ", r.okDeflated === "OK" && r.deflatedRoundTrip && r.ratio > 100, `圧縮率${r.ratio}倍`);
  check("1ファイルの展開後が上限（256MB）を超える ZIP は読む前に拒否", /大きすぎます/.test(r.entryTooBig), r.entryTooBig);
  check("申告より大きく展開される ZIP（展開の爆弾）は途中で止めて拒否", /申告された大きさより大きく/.test(r.bomb), r.bomb);
  check("申告より小さく展開される ZIP は拒否", /申告と違います/.test(r.shorter), r.shorter);
  check("ファイル数が上限（2万）を超える ZIP は拒否", /多すぎます/.test(r.tooMany), r.tooMany);
  check("データがファイルの外にはみ出す ZIP は拒否", /はみ出して|外を指して|解析に失敗/.test(r.outOfRange), r.outOfRange);
  check("無圧縮なのに大きさが合わない ZIP は拒否", /大きさが不正/.test(r.storedMismatch), r.storedMismatch);
  check("名前に「..」・先頭の「/」がある ZIP は拒否、Excel の正常な名前（[Content_Types].xml）は通す", /不正です/.test(r.dotdot) && /不正です/.test(r.abs) && r.okName === "OK", `${r.dotdot} / ${r.abs} / ${r.okName}`);
  check("展開後の合計が上限（2GB）を超える ZIP は拒否", /合計が大きすぎます/.test(r.totalTooBig), r.totalTooBig);

  // バックアップの復元: 壊れた ZIP は検査で止まり、端末のデータは変わらない
  const snapBefore = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); await createSite({ name: "ZIPの上限の試験" });
    const { dbGetAll } = await import("/js/db.js"); return JSON.stringify((await dbGetAll("sites")).map((s) => s.id).sort());
  });
  const bad = await page.evaluate(async () => {
    const { exportFullBackup, analyzeBackupFile } = await import("/js/backup.js");
    const { blob, filename } = await exportFullBackup();
    const u = new Uint8Array(await blob.arrayBuffer());
    const v = new DataView(u.buffer); let eocd = -1; for (let i = u.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    const cd = v.getUint32(eocd + 16, true); v.setUint32(cd + 24, 600 * 1024 * 1024, true); // 最初の項目の展開後の申告を 600MB に
    const a = await analyzeBackupFile(new File([u], filename, { type: "application/zip" }));
    return { ok: a.ok, errors: (a.errors || []).map((e) => e.reason || e.message || String(e)).join(" / ").slice(0, 160) };
  });
  const snapAfter = await page.evaluate(async () => { const { dbGetAll } = await import("/js/db.js"); return JSON.stringify((await dbGetAll("sites")).map((s) => s.id).sort()); });
  check("バックアップの復元: 上限を超える ZIP は検査で止まり（理由を表示）、端末のデータは変わらない", bad.ok === false && /大きすぎます/.test(bad.errors) && snapBefore === snapAfter, bad.errors);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
