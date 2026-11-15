/* ==========================================================
   バックアップのパスワード暗号化（2026-11-01。ブラウザの標準の暗号機能 Web Crypto だけを使う。外部のライブラリ・サービスは使わない）
   今のバックアップ（ZIP）を、そのまま暗号化して包む（中身の形式・復元の検査は変えない）。

   ■ ファイルの形（拡張子 .kbak）
     先頭8バイト "KNBKENC1" ／ ヘッダーの長さ（4バイト）／ ヘッダー（JSON・UTF-8）／ 暗号文の塊 × chunkCount
     （塊ごとに: 長さ（4バイト）＋ AES-GCM の暗号文（末尾16バイトは改ざん検出用の認証タグ））
   ■ 鍵: パスワードから PBKDF2-SHA256（反復回数・ソルトはヘッダーに記録。ソルトは毎回ランダム）で AES-256 の鍵を作る。
     パスワードはどこにも保存しない（バックアップの中にも、ソースコードにも、端末にも）。
   ■ 暗号: AES-256-GCM。元の ZIP を 4MB ごとの塊に分けて暗号化する（大きなバックアップでも、iPad のメモリを一度に使い切らない）。
     塊の IV は「ランダムな8バイト＋塊の番号」。塊ごとの追加認証データ（AAD）は「ヘッダーの SHA-256＋塊の番号＋最後の塊の印」なので、
     ヘッダーの書き換え・塊の入れ替え・重複・欠落・切り捨てはどれも復号に失敗する。最後に全体の大きさも確かめる。
   ■ 誤ったパスワード・壊れたファイルは、何も返さずに誤りにする（復元の検査・書き込みには進まない）。
   ========================================================== */

const MAGIC = "KNBKENC1";
export const ENCRYPTED_BACKUP_EXT = ".kbak";
export const BACKUP_KDF_ITERATIONS = 600000; // OWASP の推奨値（PBKDF2-HMAC-SHA256）。ヘッダーに記録するので、後から変えても古いファイルは読める
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
export const MIN_BACKUP_PASSWORD_LENGTH = 8;

const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };

/** パスワードの決まり（8文字以上）。問題があれば理由の文、無ければ "" */
export function backupPasswordProblem(password, confirm) {
  if (!password) return "パスワードを入力してください。";
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) return `パスワードは${MIN_BACKUP_PASSWORD_LENGTH}文字以上にしてください。`;
  if (confirm !== undefined && password !== confirm) return "確認のパスワードが一致しません。";
  return "";
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function chunkIv(prefix, index) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

function chunkAad(headerHash, index, final) {
  const aad = new Uint8Array(32 + 4 + 1);
  aad.set(headerHash, 0);
  new DataView(aad.buffer).setUint32(32, index, false);
  aad[36] = final ? 1 : 0;
  return aad;
}

/** 暗号化したバックアップか（先頭8バイトで判別。ZIP は "PK" で始まる） */
export async function isEncryptedBackupFile(file) {
  if (!file || file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return new TextDecoder().decode(head) === MAGIC;
}

/**
 * バックアップ（ZIP の Blob）を暗号化する。
 * @returns {Promise<Blob>} .kbak の中身
 */
export async function encryptBackupBlob(blob, password, { iterations = BACKUP_KDF_ITERATIONS, chunkSize = CHUNK_SIZE } = {}) {
  const problem = backupPasswordProblem(password);
  if (problem) throw new Error(problem);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ivPrefix = crypto.getRandomValues(new Uint8Array(8));
  const chunkCount = Math.max(1, Math.ceil(blob.size / chunkSize));
  const header = {
    format: "koji-nippou-backup-encrypted",
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) },
    cipher: { name: "AES-GCM", keyBits: 256, chunkSize, ivPrefix: b64(ivPrefix) },
    plainSize: blob.size,
    chunkCount,
    createdAt: new Date().toISOString()
  };
  const headerBytes = enc.encode(JSON.stringify(header));
  const headerHash = new Uint8Array(await crypto.subtle.digest("SHA-256", headerBytes));
  const key = await deriveKey(password, salt, iterations);
  const parts = [enc.encode(MAGIC), u32(headerBytes.length), headerBytes];
  for (let i = 0; i < chunkCount; i++) {
    const plain = new Uint8Array(await blob.slice(i * chunkSize, Math.min(blob.size, (i + 1) * chunkSize)).arrayBuffer());
    const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(ivPrefix, i), additionalData: chunkAad(headerHash, i, i === chunkCount - 1) }, key, plain));
    parts.push(u32(c.length), c);
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/**
 * 暗号化したバックアップを復号する。誤ったパスワード・壊れたファイル・切り捨て・改ざんは誤り（何も返さない）。
 * @returns {Promise<{blob: Blob, header: object}>} 元の ZIP
 */
export async function decryptBackupFile(file, password) {
  const fail = (why) => { throw new Error(why); };
  if (!(await isEncryptedBackupFile(file))) fail("暗号化したバックアップのファイルではありません。");
  const headLen = new DataView(await file.slice(8, 12).arrayBuffer()).getUint32(0, false);
  if (headLen < 2 || headLen > MAX_HEADER_BYTES || 12 + headLen > file.size) fail("暗号化したバックアップのファイルが壊れています（ヘッダー）。");
  const headerBytes = new Uint8Array(await file.slice(12, 12 + headLen).arrayBuffer());
  let header;
  try { header = JSON.parse(new TextDecoder().decode(headerBytes)); } catch { fail("暗号化したバックアップのファイルが壊れています（ヘッダー）。"); }
  const k = header?.kdf, c = header?.cipher;
  if (header?.format !== "koji-nippou-backup-encrypted" || header.version !== 1) fail("このアプリが知らない形式の暗号化バックアップです（新しい版のアプリで作られた可能性があります）。");
  if (k?.name !== "PBKDF2" || k.hash !== "SHA-256" || !Number.isInteger(k.iterations) || k.iterations < 100000 || k.iterations > 10000000) fail("暗号化したバックアップのファイルが壊れています（鍵の作り方）。");
  if (c?.name !== "AES-GCM" || c.keyBits !== 256 || !Number.isInteger(c.chunkSize) || c.chunkSize < 1024 || c.chunkSize > 64 * 1024 * 1024) fail("暗号化したバックアップのファイルが壊れています（暗号の設定）。");
  if (!Number.isInteger(header.plainSize) || header.plainSize < 0 || !Number.isInteger(header.chunkCount) || header.chunkCount !== Math.max(1, Math.ceil(header.plainSize / c.chunkSize))) fail("暗号化したバックアップのファイルが壊れています（大きさ）。");
  let salt, ivPrefix;
  try { salt = unb64(k.salt); ivPrefix = unb64(c.ivPrefix); } catch { fail("暗号化したバックアップのファイルが壊れています（ヘッダー）。"); }
  if (salt.length < 16 || ivPrefix.length !== 8) fail("暗号化したバックアップのファイルが壊れています（ヘッダー）。");
  const headerHash = new Uint8Array(await crypto.subtle.digest("SHA-256", headerBytes));
  const key = await deriveKey(password, salt, k.iterations);
  const parts = [];
  let pos = 12 + headLen, total = 0;
  for (let i = 0; i < header.chunkCount; i++) {
    if (pos + 4 > file.size) fail("暗号化したバックアップのファイルが途中で切れています。");
    const len = new DataView(await file.slice(pos, pos + 4).arrayBuffer()).getUint32(0, false);
    if (len < 16 || len > c.chunkSize + 16 || pos + 4 + len > file.size) fail("暗号化したバックアップのファイルが壊れているか、途中で切れています。");
    const cipher = await file.slice(pos + 4, pos + 4 + len).arrayBuffer();
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(ivPrefix, i), additionalData: chunkAad(headerHash, i, i === header.chunkCount - 1) }, key, cipher));
    } catch {
      fail(i === 0 ? "パスワードが違うか、ファイルが壊れています（復号できません）。" : "ファイルが壊れているか、書き換えられています（復号できません）。");
    }
    parts.push(plain);
    total += plain.length;
    pos += 4 + len;
  }
  if (pos !== file.size) fail("暗号化したバックアップのファイルの後ろに、余分なデータがあります（壊れているか、書き換えられています）。");
  if (total !== header.plainSize) fail("暗号化したバックアップのファイルが壊れています（大きさが一致しません）。");
  return { blob: new Blob(parts, { type: "application/zip" }), header };
}

/** ファイル名: backup_….zip → backup_….kbak（暗号化したもの） */
export function encryptedBackupName(zipName) {
  return String(zipName || "backup.zip").replace(/\.zip$/i, "") + ENCRYPTED_BACKUP_EXT;
}

/** 暗号化して、すぐに復号し直して元の ZIP と同じか確かめる（作ったファイルが本当に戻せることを確かめる） */
export async function encryptBackupVerified(blob, password, opts) {
  const encrypted = await encryptBackupBlob(blob, password, opts);
  const { blob: back } = await decryptBackupFile(new File([encrypted], "check" + ENCRYPTED_BACKUP_EXT), password);
  const h = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", await b.arrayBuffer())).join(",");
  if ((await h(back)) !== (await h(blob))) throw new Error("暗号化したバックアップを読み直すと、元の内容と一致しませんでした（保存しません）。");
  return encrypted;
}
