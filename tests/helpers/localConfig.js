// 開発用のローカル設定（リポジトリの外 ~/.koji-nippou-app/config.json）を読む。
// 原本の場所・原本の指紋・様式から消す文言（会社名など）は環境固有・機密なので、テストのコードには書かない。
// 環境変数 ANZEN_TEMPLATE で原本の場所を上書きできる。
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_FILE = process.env.KOJI_LOCAL_CONFIG || path.join(os.homedir(), ".koji-nippou-app", "config.json");
const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
const ORIGINAL_TEMPLATE = process.env.ANZEN_TEMPLATE || config.originalTemplatePath || "";
const ORIGINAL_SHA256 = config.originalSha256 || null;
const REMOVE_TEXTS = config.removeTexts || [];

/**
 * 漏れ検査で「出力に残っていてはいけない語」を、実行時に原本から取り出す（テストのコードに書かない）。
 * アプリのクリーン化処理（templateCleaner.js）が原本から除いたもの＝前の工事の記入例・作成者名・
 * コメントの作成者名・プリンター名・外部リンクの参照先・保存先パス・消す指定の文言。
 * @param {import("playwright").Page} page アプリを開いたページ
 * @param {{includeRemoveTexts?: boolean}} [options]
 */
async function leakWordsFromOriginal(page, originalBuffer = fs.readFileSync(ORIGINAL_TEMPLATE), { includeRemoveTexts = true } = {}) {
  const report = await page.evaluate(async ({ b64, removeTexts }) => {
    const { createCleanTemplate } = await import("./js/report-output/templateCleaner.js");
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return (await createCleanTemplate(u.buffer, { removeTexts })).report;
  }, { b64: originalBuffer.toString("base64"), removeTexts: REMOVE_TEXTS });
  const words = new Set();
  const add = (w) => { const t = String(w || "").trim(); if (t.length >= 2 && (!/^[\d.:\s-]+$/.test(t) || /^\d+\.\d+\.\d+\.\d+$/.test(t))) words.add(t); };
  const GENERIC_PATH = new Set(["file:", "C:", "Users", "Desktop", "Documents", "Documents and Settings", "Administrator", "デスクトップ", "サーバー"]);
  // 記入例のうち、前の工事を特定できるもの（工事名・協力会社名・その他の書き込み）。職種・作業内容・指示事項は
  // 「足場」「警備」など一般的な語が多く、正常な出力でも出るため対象にしない
  for (const [category, list] of Object.entries(report.clearedSamples || {})) {
    if (/工事名|協力会社名|その他/.test(category)) for (const v of list) add(v);
  }
  const md = report.metadata || {};
  [md.creator, md.lastModifiedBy, ...(md.commentAuthors || []), ...(md.printerModels || [])].forEach(add);
  for (const target of [...(md.externalLinkTargets || []), md.absPath || ""]) {
    for (const seg of target.split(/[\\/]+/)) if (seg.length >= 3 && !GENERIC_PATH.has(seg)) add(seg);
  }
  // 消す指定の文言（見出しの会社名など）は、同梱のクリーン版では残ってはいけないが、利用者が自分の会社の
  // 原本を登録して出力する場合は正しい様式の文言なので、その検査では対象にしない（includeRemoveTexts: false）
  if (includeRemoveTexts) REMOVE_TEXTS.forEach(add);
  // 様式の固定文言（記入欄ではない、様式に元からある語）は除外する
  for (const generic of ["テンプレート"]) words.delete(generic);
  return [...words];
}
module.exports = { CONFIG_FILE, ORIGINAL_TEMPLATE, ORIGINAL_SHA256, REMOVE_TEXTS, leakWordsFromOriginal };
