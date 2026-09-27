// テスト用: 同梱テンプレートの復号鍵（リポジトリの外に保存されている）を読み、セットアップリンクや平文を作る。
// 鍵の場所は環境変数 TEMPLATE_KEY_FILE（既定 ~/.koji-nippou-app/template-key.json）。鍵はテストの出力に表示しない。
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const KEY_FILE = process.env.TEMPLATE_KEY_FILE || path.join(os.homedir(), ".koji-nippou-app", "template-key.json");
const ASSETS = path.join(__dirname, "..", "..", "assets", "templates");

function loadKey() {
  if (!fs.existsSync(KEY_FILE)) throw new Error(`テンプレートの鍵ファイルがありません: ${KEY_FILE}（tools/build-clean-template.js で作成）`);
  const { key } = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  return key; // base64url
}
function manifestEntry(id = "anzen-eisei-03-2") {
  return JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8")).templates.find((t) => t.id === id);
}
/** 暗号化された同梱ファイルを復号して平文のBufferを返す（テストの比較用。ファイルには書き出さない） */
function decryptBundled(id = "anzen-eisei-03-2", keyText = loadKey()) {
  const entry = manifestEntry(id);
  const enc = fs.readFileSync(path.join(ASSETS, entry.fileName));
  const key = Buffer.from(keyText, "base64url");
  const iv = Buffer.from(entry.iv, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`koji-nippou-template:${id}`));
  decipher.setAuthTag(enc.subarray(enc.length - 16));
  return Buffer.concat([decipher.update(enc.subarray(0, enc.length - 16)), decipher.final()]);
}
/** 同じ鍵・同じ形式で任意の平文を暗号化する（「同梱の新しい版」をテストで再現するため） */
function encryptLike(id, plain, keyText = loadKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyText, "base64url"), iv);
  cipher.setAAD(Buffer.from(`koji-nippou-template:${id}`));
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { enc, iv: iv.toString("base64url") };
}
const setupUrl = (base, keyText = loadKey()) => `${base}#setup=${keyText}`;
module.exports = { KEY_FILE, ASSETS, loadKey, manifestEntry, decryptBundled, encryptLike, setupUrl };
