// iPad実機確認用の「非公開の確認用サイト」を、このMacから同じWi‑Fi内だけにHTTPSで配信する。
// インターネットには公開しない（外部サービス・アカウント不要）。本番（GitHub Pages）とは別の場所・別のURL。
//
//  ・配信するのは tools/build-site.js で作った dist/ だけ（許可リスト方式・検査済み）
//  ・HTTPSの証明書は、このMacで作る確認用の認証局（CA）で発行する。iPadにCAの証明書を一時的に
//    インストールして信頼すると、Service Worker・ホーム画面アプリ（PWA）が動く。確認が終わったら
//    iPadから削除する。CAの秘密鍵はリポジトリの外（~/.koji-nippou-app/staging/）にだけ置き、
//    有効期限は30日、使える範囲を同じネットワークのIPと .local の名前に限定（名前の制約）する。
//  ・http://<MacのIP>:8080/ では、CAの証明書（公開してよい情報）と手順だけを配る
//  ・https://…/v2/ では「同梱の新しい版（確認用第2版）」が届いた状態を再現する（見出しの1か所に
//    「（確認用第2版）」と付けて同じ鍵で暗号化。リポジトリの外に作り、本番の同梱ファイルは変えない）。
//    同じサイト（同じ保存領域）なので、既存現場は旧版のまま・新規現場は新しい版になることを確かめられる
//  ・http://<MacのIP>:8080/checklist でiPad実機確認のチェック表を開ける（結果はその端末に保存）
//  ・確認用のセットアップリンク（鍵を含む）は ~/.koji-nippou-app/setup-link-staging.txt に保存し、
//    画面・ログには出さない（# 以降はサーバーに送られないので、サーバーのログにも残らない）
// 使い方: node tools/build-site.js && node tools/serve-staging.js [--ip <MacのLAN内のIPアドレス>] [--port 8443]
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const DIST = path.join(REPO, "dist");
const SECRET = path.join(os.homedir(), ".koji-nippou-app");
const DIR = path.join(SECRET, "staging");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) return a.address;
  return null;
}
const IP = opt("ip", lanIp());
const PORT = Number(opt("port", 8443));
const HTTP_PORT = Number(opt("http-port", 8080));
if (!IP) { console.error("同じWi‑Fi内のIPアドレスが見つかりません（--ip で指定してください）"); process.exit(2); }
if (!fs.existsSync(path.join(DIST, "index.html"))) { console.error("dist/ がありません。先に node tools/build-site.js を実行してください。"); process.exit(2); }
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

const run = (...a) => execFileSync("openssl", a, { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });
const caKey = path.join(DIR, "ca.key"), caCrt = path.join(DIR, "ca.crt");
const subnet = IP.split(".").slice(0, 2).join(".") + ".0.0";
if (!fs.existsSync(caCrt)) {
  fs.writeFileSync(path.join(DIR, "ca.cnf"), `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Koji Nippou Staging CA (delete after testing)\n[v3]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nnameConstraints=critical,permitted;IP:${subnet}/255.255.0.0,permitted;DNS:.local\n`);
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30", "-config", "ca.cnf");
  fs.chmodSync(caKey, 0o600);
}
const host = `${os.hostname().replace(/\.local$/, "")}.local`;
fs.writeFileSync(path.join(DIR, "server.cnf"), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${IP}\n[ext]\nbasicConstraints=CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${IP},DNS:${host}\n`);
run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-config", "server.cnf");
run("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "30", "-extfile", "server.cnf", "-extensions", "ext");
fs.chmodSync(path.join(DIR, "server.key"), 0o600);

// ---- 確認用第2版（/v2/）: dist を複製し、同梱テンプレートだけを第2版に差し替える ----
const DIST_V2 = path.join(DIR, "dist-v2");
function buildTestV2() {
  const keyFile = path.join(SECRET, "template-key.json");
  if (!fs.existsSync(keyFile)) return false;
  const key = Buffer.from(JSON.parse(fs.readFileSync(keyFile, "utf8")).key, "base64url");
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "assets/templates/manifest.json"), "utf8"));
  const entry = manifest.templates[0];
  const enc = fs.readFileSync(path.join(DIST, "assets/templates", entry.fileName));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64url"));
  decipher.setAAD(Buffer.from(`koji-nippou-template:${entry.id}`));
  decipher.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([decipher.update(enc.subarray(0, enc.length - 16)), decipher.final()]);
  const work = path.join(DIR, "v2work");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(work, "v1.xlsx"), plain, { mode: 0o600 });
  execFileSync("unzip", ["-q", "v1.xlsx", "-d", "x"], { cwd: work });
  const sst = path.join(work, "x/xl/sharedStrings.xml");
  fs.writeFileSync(sst, fs.readFileSync(sst, "utf8").replace("巡回点検記録", "巡回点検記録（確認用第2版）"));
  execFileSync("zip", ["-q", "-X", "-r", "../v2.xlsx", "."], { cwd: path.join(work, "x") });
  const v2 = fs.readFileSync(path.join(work, "v2.xlsx"));
  fs.rmSync(work, { recursive: true, force: true }); // 平文は残さない
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`koji-nippou-template:${entry.id}`));
  const v2enc = Buffer.concat([cipher.update(v2), cipher.final(), cipher.getAuthTag()]);
  fs.rmSync(DIST_V2, { recursive: true, force: true });
  fs.cpSync(DIST, DIST_V2, { recursive: true });
  fs.writeFileSync(path.join(DIST_V2, "assets/templates", entry.fileName), v2enc);
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  manifest.templates[0] = { ...entry, iv: iv.toString("base64url"), sha256: sha(v2), cipherSha256: sha(v2enc), bundleVersion: (entry.bundleVersion || 1) + 1, note: "確認用第2版（iPad実機確認専用。本番には出さない）" };
  fs.writeFileSync(path.join(DIST_V2, "assets/templates/manifest.json"), JSON.stringify(manifest, null, 2));
  return true;
}
const hasV2 = buildTestV2();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".enc": "application/octet-stream", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf" };
const siteUrl = `https://${IP}:${PORT}/index.html`;

https.createServer({ key: fs.readFileSync(path.join(DIR, "server.key")), cert: fs.readFileSync(path.join(DIR, "server.crt")) }, (req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "https://x").pathname);
  let root = DIST;
  if (hasV2 && (urlPath === "/v2" || urlPath.startsWith("/v2/"))) {
    root = DIST_V2;
    urlPath = urlPath.slice(3) || "/";
  }
  const file = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("Not Found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "0.0.0.0");

http.createServer((req, res) => {
  if (req.url === "/checklist" || req.url === "/checklist.html") {
    const html = fs.readFileSync(path.join(__dirname, "staging-checklist.html"), "utf8").split("{{SITE}}").join(siteUrl).split("{{SITE_V2}}").join(`https://${IP}:${PORT}/v2/index.html`).split("{{HTTP}}").join(`http://${IP}:${HTTP_PORT}/`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.url === "/ca.crt") { res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=koji-nippou-staging-ca.crt" }); fs.createReadStream(caCrt).pipe(res); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><meta name="viewport" content="width=device-width"><title>確認用サイトの準備</title><body style="font-family:sans-serif;padding:16px;line-height:1.7">
<h1>工事日報アプリ 確認用サイト（iPad実機確認用）</h1>
<ol><li><a href="/ca.crt">確認用の証明書をダウンロード</a>し、「設定」→「プロファイルがダウンロードされました」→インストール</li>
<li>「設定」→「一般」→「情報」→「証明書信頼設定」で「Koji Nippou Staging CA」をオンにする</li>
<li>Safariで <b>${siteUrl}</b> を開く</li>
<li>確認が終わったら「設定」→「一般」→「VPNとデバイス管理」から、このプロファイルを削除する</li></ol>
<p><a href="/checklist">iPad実機確認チェック表</a></p><p>このページと証明書には鍵・様式は含まれていません。セットアップリンクは別途（管理者から）受け取ってください。</p></body>`);
}).listen(HTTP_PORT, "0.0.0.0");

// 確認用のセットアップリンク（鍵を含む）はファイルにだけ保存し、画面には出さない
const keyFile = path.join(SECRET, "template-key.json");
if (fs.existsSync(keyFile)) {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8")).key;
  fs.writeFileSync(path.join(SECRET, "setup-link-staging.txt"), `${siteUrl}#setup=${key}\n`, { mode: 0o600 });
}
console.log(`確認用サイト（同じWi‑Fi内だけ）: ${siteUrl}`);
console.log(`証明書と手順: http://${IP}:${HTTP_PORT}/　チェック表: http://${IP}:${HTTP_PORT}/checklist`);
console.log(hasV2 ? `確認用第2版（新しい版が届いた状態）: https://${IP}:${PORT}/v2/index.html` : "確認用第2版は作れませんでした（鍵がありません）");
console.log(`確認用のセットアップリンク: ${path.join(SECRET, "setup-link-staging.txt")} に保存（画面には表示しません）`);
console.log("終了するには Ctrl+C。確認が終わったらiPadから証明書のプロファイルを削除してください。");
