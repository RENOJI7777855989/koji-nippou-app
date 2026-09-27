/* ==========================================================
   アプリに同梱した標準テンプレート（クリーンな03-2。暗号化済み）の登録・更新

   ■ 暗号化（方式B）
     公開サイト・Gitに置くのは暗号化したファイル（assets/templates/*.xlsx.enc）だけ。
     平文の03-2は公開しない。復号鍵はソースコードに入れず、社内で渡す「セットアップリンク」
     （index.html#setup=<鍵>）の # 以降で渡す（# 以降はブラウザがサーバーへ送らない）。
     各端末でリンクを1回開くと、鍵をこの端末の IndexedDB（meta）に保存し、復号したテンプレートを
     登録する。以後は鍵の入力は不要で、オフラインでも出力できる（出力は登録済みのテンプレートを使う）。
     端末のデータを消した・iPadを買い替えた場合は、同じリンクをもう一度開けば戻る。
     暗号: AES-256-GCM（追加認証データ = テンプレートid）。鍵の識別子 keyId は鍵のハッシュの先頭で、
     鍵そのものは分からない。取得した暗号化ファイルは manifest の cipherSha256 で、復号した内容は
     sha256 で確かめる（改ざん・取り違えは使わない）。
   同梱ファイルは assets/templates/ にあり、manifest.json が一覧（id・様式の種類・
   ファイル名・sha256・版番号）を持つ。ファイルは tools/build-clean-template.js で
   会社様式から他工事・個人・社内の情報を除いて作ったもの（templateCleaner.js）。

   登録の方針:
     ・新規インストール（現場・日報・テンプレートが1件も無い端末）の初回起動だけ、
       自動で登録して標準テンプレートにする（seedBundledTemplatesOnFreshInstall）。
     ・既存の端末は、登録済みのテンプレート・現場・設定に一切触れない。同梱の様式を
       使いたい場合は、テンプレート管理画面のボタンで利用者が登録／更新する。
     ・自動登録は1回だけ（metaに記録）。利用者が削除したものを起動のたびに戻さない。
     ・同梱の様式が新しくなったとき（manifestのsha256が変わったとき）も、自動では
       置き換えず、管理画面に「更新あり」と出して、前の版との違いを確認してから
       差し替える（現在の差し替えの仕組みと同じ。前の版は残る）。
   ========================================================== */

import { dbGet, dbGetAll, dbPut } from "../db.js";
import {
  createReportTemplate,
  updateReportTemplate,
  listReportTemplates,
  replaceReportTemplateFile,
  setAppDefaultReportTemplate,
  getAppDefaultReportTemplate,
  sha256OfBlob
} from "./reportTemplates.js";
import { inspectTemplate, compareTemplateVersions } from "./templateInspector.js";

const DIR = "./assets/templates/";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const bundledRecordId = (entryId) => `bundled-${entryId}`;
const KEY_META = "bundledTemplateKey";

export class BundledKeyRequiredError extends Error {
  constructor(message = "同梱テンプレートを使うには、セットアップリンクを1回開いてください（この端末には鍵がありません）。") {
    super(message);
    this.code = "NEEDS_KEY";
  }
}

function base64UrlToBytes(text) {
  const b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 鍵の識別子（tools/build-clean-template.js の keyIdOf と同じ計算。鍵そのものは分からない） */
export async function keyIdOf(keyBytes) {
  const prefix = new TextEncoder().encode("koji-nippou-template-key:");
  const joined = new Uint8Array(prefix.length + keyBytes.length);
  joined.set(prefix, 0);
  joined.set(keyBytes, prefix.length);
  return hex(await crypto.subtle.digest("SHA-256", joined)).slice(0, 16);
}

/** セットアップリンク（…#setup=鍵）または鍵の文字列から、鍵の文字列を取り出す。無ければnull */
export function extractSetupKey(text) {
  const m = /(?:^|[#&?])setup=([A-Za-z0-9_-]{40,})/.exec(String(text || "").trim()) || /^([A-Za-z0-9_-]{43})$/.exec(String(text || "").trim());
  return m ? m[1] : null;
}

async function storedKey() {
  const rec = await dbGet("meta", KEY_META);
  return rec?.value ? { keyId: rec.keyId, bytes: base64UrlToBytes(rec.value) } : null;
}

/** この端末に保存した鍵の識別子（鍵が無ければnull） */
export async function getStoredKeyId() {
  return (await storedKey())?.keyId || null;
}

async function decryptEntry(entry, encryptedBytes, keyBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  try {
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(entry.iv), additionalData: new TextEncoder().encode(`koji-nippou-template:${entry.id}`) },
      key,
      encryptedBytes
    );
  } catch {
    throw new Error(`同梱テンプレート「${entry.name}」を復号できません（鍵が違うか、ファイルが壊れています）。`);
  }
}

export async function loadBundledManifest() {
  const res = await fetch(`${DIR}manifest.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`同梱テンプレートの一覧を取得できません（${res.status}）`);
  const manifest = await res.json();
  return Array.isArray(manifest.templates) ? manifest.templates : [];
}

/**
 * 同梱ファイルを取得して（暗号化されていれば鍵で復号して）返す。取得したファイル・復号した内容が
 * manifest の指紋と一致しなければ使わない。暗号化されたファイルで鍵が無ければ BundledKeyRequiredError。
 * @param {object} entry manifestの1件
 * @param {{keyBytes?: Uint8Array}} [options] 保存前の鍵で試す場合（セットアップリンク）
 */
export async function fetchBundledFile(entry, { keyBytes = null } = {}) {
  let bytes;
  if (entry.encrypted) {
    const key = keyBytes ? { bytes: keyBytes, keyId: await keyIdOf(keyBytes) } : await storedKey();
    if (!key) throw new BundledKeyRequiredError();
    if (entry.keyId && key.keyId !== entry.keyId) {
      throw new BundledKeyRequiredError(`同梱テンプレート「${entry.name}」は別の鍵で暗号化されています。新しいセットアップリンクを開いてください。`);
    }
    const res = await fetch(`${DIR}${entry.fileName}`);
    if (!res.ok) throw new Error(`同梱テンプレート「${entry.name}」を取得できません（${res.status}）`);
    const encrypted = await res.arrayBuffer();
    if (entry.cipherSha256 && hex(await crypto.subtle.digest("SHA-256", encrypted)) !== entry.cipherSha256) {
      throw new Error(`同梱テンプレート「${entry.name}」の暗号化ファイルが一覧（manifest）と一致しません。アプリを再読み込みしてください。`);
    }
    bytes = await decryptEntry(entry, encrypted, key.bytes);
  } else {
    const res = await fetch(`${DIR}${entry.fileName}`);
    if (!res.ok) throw new Error(`同梱テンプレート「${entry.name}」を取得できません（${res.status}）`);
    bytes = await res.arrayBuffer();
  }
  const blob = new Blob([bytes], { type: XLSX_MIME });
  const sha = await sha256OfBlob(blob);
  if (sha !== entry.sha256) throw new Error(`同梱テンプレート「${entry.name}」の内容が一覧（manifest）と一致しません。アプリを再読み込みしてください。`);
  return blob;
}

/**
 * セットアップリンク（または鍵）で、この端末に鍵を保存し、同梱テンプレートを登録する。
 * 鍵は、実際に同梱ファイルを復号できた場合だけ保存する（違うリンクは保存しない）。
 *  ・この端末に未登録 → 登録する。標準が未設定（または標準が同梱テンプレート）なら標準にする
 *  ・登録済み → 鍵だけ保存する（新しい版があれば管理画面の「更新」で更新できる。自動では更新しない）
 * @returns {Promise<{ installed: string[], alreadyRegistered: string[], madeStandard: boolean }>}
 */
export async function runBundledSetup(linkOrKey) {
  const keyText = extractSetupKey(linkOrKey);
  if (!keyText) throw new Error("セットアップリンク（または鍵）の形式が正しくありません。");
  const keyBytes = base64UrlToBytes(keyText);
  if (keyBytes.length !== 32) throw new Error("セットアップリンク（または鍵）の形式が正しくありません。");
  const keyId = await keyIdOf(keyBytes);
  let entries;
  try {
    entries = (await loadBundledManifest()).filter((e) => e.encrypted && e.keyId === keyId);
  } catch (e) {
    throw new Error(`同梱テンプレートの一覧を取得できません。インターネットにつないだ状態でリンクを開いてください（${e.message}）`);
  }
  if (entries.length === 0) throw new Error("このセットアップリンクに対応する同梱テンプレートがありません（古いリンクか、別のアプリのリンクです）。");
  // 保存する前に、この鍵で本当に復号できることを確かめる
  const blobs = new Map();
  for (const entry of entries) blobs.set(entry.id, await fetchBundledFile(entry, { keyBytes }));
  // metaストアはkeyPathが"key"なので、鍵の値は value に入れる
  await dbPut("meta", { key: KEY_META, keyId, value: keyText, savedAt: new Date().toISOString() });

  const result = { installed: [], alreadyRegistered: [], madeStandard: false };
  for (const entry of entries) {
    if (await findRecord(entry.id)) {
      result.alreadyRegistered.push(entry.id);
      continue;
    }
    const standard = await getAppDefaultReportTemplate();
    const asStandard = !standard || !!standard.bundledId;
    await installBundledTemplate(entry, { asStandard, blob: blobs.get(entry.id) });
    await dbPut("meta", { key: `bundledTemplateSeeded:${entry.id}`, seededAt: new Date().toISOString(), bundleVersion: entry.bundleVersion || 1 });
    result.installed.push(entry.id);
    if (asStandard) result.madeStandard = true;
  }
  return result;
}

async function findRecord(entryId) {
  const all = await listReportTemplates({ format: "excel", templateKind: "report" });
  return all.find((t) => t.bundledId === entryId) || null;
}

/**
 * 管理画面用: 同梱テンプレートごとの状態。
 * status: "not_registered"（この端末に無い）／"up_to_date"／"update_available"（同梱の版が新しい）
 */
export async function getBundledTemplateStatuses() {
  let entries;
  try {
    entries = await loadBundledManifest();
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const record = await findRecord(entry.id);
    let status = "not_registered";
    if (record) status = record.bundledSha256 === entry.sha256 ? "up_to_date" : "update_available";
    // 暗号化されていて、この端末に対応する鍵が無い（登録・更新にセットアップリンクが必要）
    const keyId = await getStoredKeyId();
    const needsKey = !!entry.encrypted && keyId !== entry.keyId;
    if (needsKey && status !== "up_to_date") status = status === "not_registered" ? "needs_key" : "update_needs_key";
    out.push({ entry, record, status, customized: !!record && !!record.sourceFileSha256 && record.sourceFileSha256 !== record.bundledSha256 });
  }
  return out;
}

/** 同梱テンプレートをこの端末に登録する（標準にするかは呼び出し側が決める） */
export async function installBundledTemplate(entry, { asStandard = true, blob: givenBlob = null } = {}) {
  if (await findRecord(entry.id)) throw new Error("この端末には既に登録されています（更新する場合は「更新」を使ってください）");
  const blob = givenBlob || (await fetchBundledFile(entry));
  const created = await createReportTemplate({
    id: bundledRecordId(entry.id),
    companyProfileId: null,
    format: "excel",
    name: entry.name,
    rendererId: "xlsx-template-patch",
    sourceFileBlob: blob,
    sourceFileName: entry.fileName.replace(/\.enc$/, ""),
    sourceFileMimeType: XLSX_MIME,
    layoutId: entry.layoutId || null,
    sourceFileSha256: entry.sha256,
    bundledId: entry.id,
    bundledSha256: entry.sha256,
    bundledVersion: entry.bundleVersion || 1
  });
  return asStandard ? setAppDefaultReportTemplate(created.id) : created;
}

/** 更新前の確認材料（ファイルの検査と、現在の版との固定文言の違い）を作る */
export async function prepareBundledUpdate(entry) {
  const record = await findRecord(entry.id);
  if (!record) throw new Error("この端末に登録されていません");
  const blob = await fetchBundledFile(entry);
  const inspect = await inspectTemplate(await blob.arrayBuffer());
  const compare = inspect.layoutId && record.sourceFileBlob ? await compareTemplateVersions(await record.sourceFileBlob.arrayBuffer(), await blob.arrayBuffer(), inspect.layoutId) : { errors: [], warnings: [], diffs: [] };
  return { record, blob, inspect, compare, errors: [...inspect.errors, ...compare.errors], warnings: [...inspect.warnings, ...compare.warnings] };
}

/** 同梱の新しい版へ更新する（現在の版は前の版として残る。標準・現場の指定・idはそのまま） */
export async function applyBundledUpdate(entry, prepared) {
  const { record, blob, inspect } = prepared;
  const updated = await replaceReportTemplateFile(record.id, { blob, fileName: entry.fileName.replace(/\.enc$/, ""), mimeType: XLSX_MIME, layoutId: inspect.layoutId });
  return updateReportTemplate(updated.id, { bundledSha256: entry.sha256, bundledVersion: entry.bundleVersion || 1, rendererId: "xlsx-template-patch" });
}

/**
 * 新規インストール（現場・日報・帳票テンプレートが1件も無い端末）の初回起動だけ、
 * 同梱テンプレートを登録して標準にする。既存の端末には何もしない。
 * @returns {Promise<string[]>} 登録した同梱テンプレートのid
 */
export async function seedBundledTemplatesOnFreshInstall() {
  const [sites, reports, templates] = await Promise.all([dbGetAll("sites"), dbGetAll("reports"), dbGetAll("reportTemplates")]);
  if (sites.length > 0 || reports.length > 0 || templates.length > 0) return [];
  let entries;
  try {
    entries = await loadBundledManifest();
  } catch {
    return []; // オフライン等。次回の起動でもう一度試す（この端末はまだ新規のまま）
  }
  const seeded = [];
  for (const entry of entries) {
    const markerKey = `bundledTemplateSeeded:${entry.id}`;
    if (await dbGet("meta", markerKey)) continue;
    try {
      await installBundledTemplate(entry, { asStandard: !(await getAppDefaultReportTemplate()) });
      await dbPut("meta", { key: markerKey, seededAt: new Date().toISOString(), bundleVersion: entry.bundleVersion || 1 });
      seeded.push(entry.id);
    } catch (e) {
      if (e?.code === "NEEDS_KEY") continue; // 鍵はセットアップリンクで渡す（この端末ではまだ開いていない）
      console.warn("同梱テンプレートの初回登録に失敗しました（次回の起動で再試行します）", e);
    }
  }
  return seeded;
}
