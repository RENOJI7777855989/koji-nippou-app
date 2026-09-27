// 会社から受け取ったExcel様式から、アプリに同梱する「クリーンな標準テンプレート」を**暗号化して**作る。
//  1. 前の工事の記入例・社内パス・個人名・プリンター名・指定した文言を除く（js/report-output/templateCleaner.js）
//  2. AES-256-GCM で暗号化し、assets/templates/<id>.xlsx.enc と manifest.json（版・指紋）だけをリポジトリに書く
//     平文の .xlsx はリポジトリ内に書き出さない（.gitignore でも *.xlsx を除外している）
//  3. 復号鍵はリポジトリの外（既定 ~/.koji-nippou-app/template-key.json）に保存する。ソースコードには入れない。
//     鍵が無ければ新しく作り、あれば同じ鍵を使う（同じ鍵なら、各iPadは新しい版をリンクなしで復号・更新できる）
//  4. 各iPadで1回開く「セットアップリンク」（鍵はURLの # 以降なので、サーバーへは送られない）をファイルに保存する
//     （パスワード相当なので画面・ログには出さない）
// 原本は読み取りのみ（SHA-256で不変を確認）。
// 原本の場所・消す文言（会社名など）は、リポジトリの外の ~/.koji-nippou-app/config.json
// （originalTemplatePath・removeTexts）に置き、コマンドで省略した場合はそこから読む。
// 公開される manifest.json には消した文言を書かない（件数だけ）。
//
// 使い方（静的サーバー http://localhost:8934 を起動した状態で）:
//   node tools/build-clean-template.js ["<原本.xlsx>"] [--remove-text "<様式から消す文言>" ...]
//     [--id anzen-eisei-03-2] [--key-dir <鍵の保存先>] [--new-key] [--app-url <公開URL>]
//     [--plain-out <平文の出力先（リポジトリの外のみ・確認用）>] [--report <除去レポート.json>]
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const BASE = process.env.APP_BASE || "http://localhost:8934/index.html";
const REPO = path.resolve(__dirname, "..");
const DEFAULT_APP_URL = "https://renoji7777855989.github.io/koji-nippou-app/index.html";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// 鍵の識別子（鍵そのものは分からない。アプリ側 bundledTemplates.js の keyIdOf と同じ計算）
const keyIdOf = (keyBytes) => sha(Buffer.concat([Buffer.from("koji-nippou-template-key:"), keyBytes])).slice(0, 16);
const insideRepo = (p) => !path.relative(REPO, path.resolve(p)).startsWith("..");

(async () => {
  const args = process.argv.slice(2);
  const valueFlags = new Set(["--id", "--key-dir", "--app-url", "--plain-out", "--report", "--remove-text"]);
  const source = args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const keyDir = path.resolve(opt("key-dir", path.join(os.homedir(), ".koji-nippou-app")));
  const configFile = path.join(keyDir, "config.json");
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const sourcePath = source || config.originalTemplatePath;
  if (!sourcePath || !fs.existsSync(sourcePath)) { console.error("使い方: node tools/build-clean-template.js [<原本.xlsx>] [--remove-text <文言>] [--id ID] [--key-dir DIR] [--new-key]（原本・文言は ~/.koji-nippou-app/config.json でも指定できます）"); process.exit(2); }
  const id = opt("id", "anzen-eisei-03-2");
  const cliRemove = args.map((a, i) => (a === "--remove-text" ? args[i + 1] : null)).filter(Boolean);
  const removeTexts = cliRemove.length ? cliRemove : config.removeTexts || [];
  if (insideRepo(keyDir)) { console.error(`鍵の保存先がリポジトリの中です（${keyDir}）。リポジトリの外を指定してください。`); process.exit(2); }
  const plainOut = opt("plain-out", null);
  if (plainOut && insideRepo(plainOut)) { console.error("平文の出力先がリポジトリの中です。リポジトリの外を指定してください。"); process.exit(2); }
  const appUrl = opt("app-url", DEFAULT_APP_URL);

  const original = fs.readFileSync(sourcePath);
  const H0 = sha(original);

  // 1. クリーン化（アプリと同じ処理をブラウザで実行）
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => document.readyState === "complete");
  const out = await page.evaluate(async ({ b64, removeTexts }) => {
    const { createCleanTemplate } = await import("/js/report-output/templateCleaner.js");
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const { blob, report } = await createCleanTemplate(bytes.buffer, { removeTexts });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), report };
  }, { b64: original.toString("base64"), removeTexts });
  await browser.close();
  const clean = Buffer.from(out.b64, "base64");

  // 2. 鍵（リポジトリの外）
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keyDir, "template-key.json");
  let keyBytes;
  if (fs.existsSync(keyFile) && !args.includes("--new-key")) {
    keyBytes = Buffer.from(JSON.parse(fs.readFileSync(keyFile, "utf8")).key, "base64url");
  } else {
    keyBytes = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, JSON.stringify({ key: b64url(keyBytes), keyId: keyIdOf(keyBytes), createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  }
  if (keyBytes.length !== 32) { console.error("鍵ファイルが壊れています"); process.exit(1); }
  const keyId = keyIdOf(keyBytes);

  // 3. 暗号化（AES-256-GCM。追加認証データにテンプレートidを入れ、別のテンプレートとの取り違えを防ぐ）
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  cipher.setAAD(Buffer.from(`koji-nippou-template:${id}`));
  const encrypted = Buffer.concat([cipher.update(clean), cipher.final(), cipher.getAuthTag()]);

  const dir = path.join(REPO, "assets", "templates");
  fs.mkdirSync(dir, { recursive: true });
  const encName = `${id}.xlsx.enc`;
  fs.writeFileSync(path.join(dir, encName), encrypted);
  // 以前の版で書き出していた平文があれば消す（リポジトリ内に平文を残さない）
  for (const f of fs.readdirSync(dir)) if (/\.xlsx$/i.test(f)) fs.unlinkSync(path.join(dir, f));

  const manifestPath = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { templates: [] };
  const prev = manifest.templates.find((t) => t.id === id);
  const plainSha = sha(clean);
  const entry = {
    id,
    layoutId: out.report.layoutId,
    name: "03-2 安全衛生作業打合日誌（標準）",
    fileName: encName,
    encrypted: true,
    algorithm: "AES-256-GCM",
    iv: b64url(iv),
    keyId,
    sha256: plainSha, // 復号後の内容の指紋（登録・版の固定に使う）
    cipherSha256: sha(encrypted), // 暗号化ファイルの指紋（取得したファイルの確認に使う）
    bundleVersion: prev ? (prev.sha256 !== plainSha ? (prev.bundleVersion || 1) + 1 : prev.bundleVersion || 1) : 1,
    cleaned: true,
    removedTextCount: removeTexts.length, // 消した文言そのものは公開しない
    note: "会社様式から、前の工事の記入例・社内パス・個人名・プリンター情報・指定した文言を除き、暗号化した複製（復号するにはセットアップリンクが必要）"
  };
  manifest.templates = [...manifest.templates.filter((t) => t.id !== id), entry];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 4. セットアップリンク（鍵はURLの # 以降）
  const setupLink = `${appUrl}#setup=${b64url(keyBytes)}`;
  fs.writeFileSync(path.join(keyDir, "setup-link.txt"), setupLink + "\n", { mode: 0o600 });
  if (plainOut) fs.writeFileSync(plainOut, clean);
  const reportPath = opt("report", null);
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(out.report, null, 2));

  console.log(JSON.stringify({ removedTextCount: removeTexts.length, removedCells: out.report.removedTexts.map((r) => r.referencingCells), clearedTotal: out.report.clearedTotal }, null, 0));
  console.log(`\n作成: assets/templates/${encName}（暗号化 ${(encrypted.length / 1024).toFixed(0)}KB、版 ${entry.bundleVersion}、鍵ID ${keyId}）`);
  console.log(`平文のクリーン版はリポジトリに書き出していません${plainOut ? `（確認用に ${plainOut} へ出力）` : ""}。`);
  console.log(`鍵: ${keyFile}（リポジトリの外。人に渡すのはセットアップリンクだけ）`);
  // セットアップリンクはパスワード相当なので、画面（ターミナルのログ）には出さず、ファイルにだけ保存する
  console.log(`セットアップリンク: ${path.join(keyDir, "setup-link.txt")} に保存しました（画面には表示しません。パスワードと同じ扱いで社内の対象者にだけ渡してください）`);
  console.log(`原本のSHA-256は不変: ${sha(fs.readFileSync(sourcePath)) === H0}`);
})().catch((e) => { console.error(e); process.exit(1); });
