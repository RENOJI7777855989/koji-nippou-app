// 公開（GitHub Pages・確認用サイト）に配信してよいファイルだけを集めて、配信用フォルダを作る（許可リスト方式）。
// tests/・tools/・CLAUDE.md・package.json などの開発用ファイルは含めない。
// 集めたあと、配信用フォルダ全体に「公開してはいけない情報」が無いことを検査し、あれば失敗する:
//   ・復号鍵・セットアップリンク（~/.koji-nippou-app/ の鍵から照合）
//   ・平文のExcel（zip形式のファイル）
//   ・このMacのユーザー名・ホームフォルダのパス
//   ・ローカル設定（~/.koji-nippou-app/config.json）にある原本の場所・消す文言
// 使い方: node tools/build-site.js [--out <出力先>]（既定 dist/。.gitignore で除外）
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(REPO, "dist"));

// 配信するもの（これ以外は配信しない）
const ALLOW = [
  "index.html",
  "style.css",
  "manifest.json",
  "sw.js",
  { dir: "icons", ext: /\.(png|svg|ico)$/i },
  { dir: "js", ext: /\.(js|mjs|bcmap|pfb|ttf|txt|json)$|LICENSE(_[A-Z]+)?$/i },
  { dir: "assets/templates", ext: /(\.xlsx\.enc|manifest\.json)$/i }
];

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copied = [];
for (const rule of ALLOW) {
  const files = typeof rule === "string" ? [path.join(REPO, rule)] : walk(path.join(REPO, rule.dir)).filter((f) => rule.ext.test(f));
  for (const src of files) {
    const rel = path.relative(REPO, src);
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(rel);
  }
}

// Service Worker の事前キャッシュ対象がすべて配信用フォルダにあるか
const sw = fs.readFileSync(path.join(OUT, "sw.js"), "utf8");
const precache = [...sw.matchAll(/"(\.\/[^"]*)"/g)].map((m) => m[1]).filter((u) => u !== "./");
const missing = precache.filter((u) => !fs.existsSync(path.join(OUT, u)));

// 公開してはいけない情報の検査
const secretDir = path.join(os.homedir(), ".koji-nippou-app");
const needles = [];
const keyFile = path.join(secretDir, "template-key.json");
if (fs.existsSync(keyFile)) {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8")).key;
  const bytes = Buffer.from(key, "base64url");
  needles.push(["復号鍵", key], ["復号鍵（base64）", bytes.toString("base64")], ["復号鍵（hex）", bytes.toString("hex")], ["復号鍵（バイト列）", bytes]);
}
const linkFile = path.join(secretDir, "setup-link.txt");
if (fs.existsSync(linkFile)) needles.push(["セットアップリンク", fs.readFileSync(linkFile, "utf8").trim()]);
const configFile = path.join(secretDir, "config.json");
if (fs.existsSync(configFile)) {
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (config.originalTemplatePath) needles.push(["原本の場所", config.originalTemplatePath], ["原本のファイル名", path.basename(config.originalTemplatePath)]);
  for (const t of config.removeTexts || []) needles.push(["消す指定の文言", t]);
}
needles.push(["このMacのユーザー名", os.userInfo().username], ["ホームフォルダのパス", os.homedir()]);

const problems = [];
for (const rel of copied) {
  const buf = fs.readFileSync(path.join(OUT, rel));
  for (const [label, needle] of needles) if (needle && buf.includes(needle)) problems.push(`${rel}: ${label}`);
  if (buf[0] === 0x50 && buf[1] === 0x4b) problems.push(`${rel}: zip形式（平文のExcelの可能性）`);
}

console.log(`配信用フォルダ: ${path.relative(REPO, OUT) || OUT}（${copied.length}ファイル）`);
console.log(`Service Worker の事前キャッシュ: ${precache.length}件${missing.length ? `／見つからない: ${missing.join(", ")}` : "（すべてあり）"}`);
console.log(`公開してはいけない情報の検査（${needles.length}項目 × ${copied.length}ファイル）: ${problems.length ? "問題あり" : "問題なし"}`);
for (const p of problems) console.log(`  × ${p}`);
process.exit(problems.length || missing.length ? 1 : 0);
