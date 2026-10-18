/* ==========================================================
   バックアップ（フルエクスポート／復元）
   サーバーが無いため「常時稼働する自動バックアップジョブ」は
   実現できない。ここで提供するのは、アプリを開いている間だけ動く
   手動バックアップと、前回バックアップからの経過時間に基づく
   リマインドである（getLastBackupAt参照）。真の日次自動バックアップ
   ではないことに注意。
   写真・署名・ロゴ印影・帳票テンプレート原本などのBlobは、JSONに
   埋め込めないため、ZIP内の別ファイル（blobs/配下）として書き出し、
   JSON側にはファイル名だけを記録する。
   ========================================================== */

import { dbGetAll, dbGet, dbPut, dbDelete, dbGuardedPutMany, DB_VERSION } from "./db.js";
import { loadZip, readZipEntryBytes, readZipEntryText, buildZip } from "./zipUtil.js";
import { stampNew } from "./utils.js";
import { recordChange } from "./auditLog.js";
import { compareSignatureDuplicates, signatureDuplicateGroups, signatureDupKey } from "./signatures.js";

/** バックアップの形式の版（2026-10-18 から manifest に formatVersion・dbVersion・添付ファイルの指紋を書く。それ以前は版1） */
export const BACKUP_FORMAT_VERSION = 2;

export const DATA_STORES = [
  "sites",
  "reports",
  "photos",
  "signatures",
  "companyProfiles",
  "reportTemplates",
  "users",
  "auditLog",
  "estimateBatches",
  "estimateItems",
  "vendorQuoteBatches",
  "vendorQuoteItems",
  "itemMatchOverrides",
  "omissionDispositions",
  "masterItems",
  "submissionPlans",
  "submissionAssignments",
  "submissionImports",
  "kySubmissions"
];

// 復元時の競合一覧に表示するための、ストアごとの見出しラベルと代表フィールド
const STORE_LABELS = {
  sites: "現場",
  reports: "工事日報",
  photos: "写真",
  signatures: "署名",
  companyProfiles: "会社プロフィール",
  reportTemplates: "帳票テンプレート",
  users: "ユーザー",
  auditLog: "変更履歴",
  estimateBatches: "積算取込",
  estimateItems: "積算項目",
  vendorQuoteBatches: "業者見積取込",
  vendorQuoteItems: "業者見積項目",
  itemMatchOverrides: "項目対応関係",
  omissionDispositions: "見積落とし確認結果",
  masterItems: "共通積算項目マスター",
  submissionPlans: "提出内訳の出力設定",
  submissionAssignments: "提出内訳の区分割当",
  submissionImports: "提出内訳Excelの取込結果",
  kySubmissions: "危険予知活動表の提出状況"
};
const RECORD_LABEL_FIELDS = {
  sites: "name",
  reports: "date",
  companyProfiles: "name",
  reportTemplates: "name",
  users: "username",
  estimateBatches: "sourceFileName",
  estimateItems: "itemName",
  vendorQuoteBatches: "sourceFileName",
  vendorQuoteItems: "itemName",
  omissionDispositions: "disposition",
  masterItems: "standardName",
  submissionPlans: "projectTitle",
  submissionImports: "sourceFileName",
  kySubmissions: "vendorName"
};

// ストアごとに、Blobを含むフィールド一覧（バックアップ時は別ファイルへ退避する）
const BLOB_FIELDS = {
  photos: [{ field: "blob", mimeField: "mimeType" }],
  signatures: [{ field: "imageBlob", mimeField: null }],
  companyProfiles: [
    { field: "logoBlob", mimeField: "logoMimeType" },
    { field: "hankoBlob", mimeField: "hankoMimeType" }
  ],
  reportTemplates: [{ field: "sourceFileBlob", mimeField: "sourceFileMimeType" }],
  estimateBatches: [{ field: "sourceFileBlob", mimeField: "sourceFileMimeType" }],
  vendorQuoteBatches: [{ field: "sourceFileBlob", mimeField: "sourceFileMimeType" }]
};

export async function exportFullBackup() {
  const modifications = new Map();
  const exportedAt = new Date().toISOString();
  const recordCounts = {};
  const blobs = {}; // 添付ファイル名 → SHA-256（復元の検査で、壊れていないか確かめる）

  for (const storeName of DATA_STORES) {
    const all = await dbGetAll(storeName);
    recordCounts[storeName] = all.length;
    const blobDefs = BLOB_FIELDS[storeName] || [];

    const serializable = [];
    for (const record of all) {
      const clone = { ...record };
      for (const { field, mimeField } of blobDefs) {
        const blob = record[field];
        if (blob instanceof Blob) {
          const fileName = `blobs/${storeName}-${field}-${record.id}.bin`;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          modifications.set(fileName, bytes);
          blobs[fileName] = await sha256OfBytes(bytes);
          clone[field] = null;
          clone[`${field}File`] = fileName;
          clone[`${field}MimeTypeBackup`] = (mimeField && record[mimeField]) || blob.type || "";
        }
      }
      serializable.push(clone);
    }
    modifications.set(`data/${storeName}.json`, new TextEncoder().encode(JSON.stringify(serializable)));
  }

  const manifest = { formatVersion: BACKUP_FORMAT_VERSION, dbVersion: DB_VERSION, exportedAt, recordCounts, blobs };
  modifications.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

  const emptyZip = { buffer: new Uint8Array(0), entries: new Map() };
  const blob = buildZip(emptyZip, modifications, "application/zip");

  const filename = `backup_${exportedAt.replace(/[:.]/g, "-")}.zip`;
  const historyEntry = stampNew({
    type: "full",
    filename,
    recordCounts,
    sizeBytes: blob.size
  });
  historyEntry.createdAt = exportedAt; // stampNewのcreatedAtと同義だが明示しておく
  await dbPut("backupHistory", historyEntry);
  await recordChange({ entityType: "backup", entityId: historyEntry.id, action: "create", summary: "フルバックアップを作成" });

  return { blob, filename };
}

export async function listBackupHistory() {
  const all = await dbGetAll("backupHistory");
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getLastBackupAt() {
  const history = await listBackupHistory();
  return history[0]?.createdAt || null;
}

/* ==========================================================
   復元（2026-10-18 作り直し。設計C）
   ① 検査（書き込まない）: ZIPの構造・manifest・各ストアのJSON・id（欠落・重複）・必須項目・参照関係・
      添付ファイル（存在・空でない・記録された指紋と一致）・manifestの件数・テンプレートの指紋・形式/DBの版
      → 異常があれば理由の一覧を返し、復元しない（欠けた値を補ったり、既存の画像を空にしたりしない）
   ② 計画（書き込まない）: レコードごとに 新規／上書き／同じ内容／ローカルを残す（競合）／復元候補・要確認 に分ける
      ・ローカルの方が新しい・updatedAt が無い・同じ updatedAt で内容が違う → 競合（既定はローカルを残す）
      ・写真・署名・KY（物理削除するもの）で、この端末に無いが親（日報・現場）がこの端末にあるもの → 復元候補・要確認
        （削除済みと断定しない。既定は復元しない。この端末で削除した記録（変更履歴）があれば、その旨も示す）
   ③ 一括適用: 利用者が選んだ内容で最終の状態を検査（標準テンプレートが1件か・現場の固定が指す版があるか・参照）してから、
      すべてのストアへの書き込みを IndexedDB の1つのトランザクション（db.js の dbGuardedPutMany）で行う。
      1件でも失敗すればトランザクション全体を中止する（IndexedDB の仕組み。途中までの書き込みは残らない）。
      同じトランザクションの中で、計画の時点の端末の状態（result.guard）から変わっていないかを先に確かめ、
      変わっていれば何も書かずに中止する（別のタブ・ウィンドウで変更された場合。計画を作り直す）
   ④ 確認: 書き込み後に件数・添付ファイルの指紋・現場の固定を読み直して確かめる
   ・バックアップに無いデータは消さない（従来どおり「合成」。完全な置き換えではない）
   ・形式の版（formatVersion）・DBの版（dbVersion）が無い古いバックアップは、従来の形式（版1・DB v10以前）として受け付ける。
     このアプリより新しい形式・新しいDBの版のバックアップは、書き込まずに中止する
   ========================================================== */

/** レコードの必須項目（ストアごと。実データの形に合わせた最小限） */
const REQUIRED_FIELDS = {
  sites: ["name"],
  reports: ["siteId", "date"],
  photos: ["reportId"],
  signatures: ["reportId"],
  kySubmissions: ["siteId", "date", "vendorName"],
  auditLog: ["entityType", "action"]
};
/** 物理削除するストア（この端末に無いレコードが「削除したもの」か分からない）と、その親 */
const PHYSICAL_DELETE_PARENT = { photos: { store: "reports", field: "reportId" }, signatures: { store: "reports", field: "reportId" }, kySubmissions: { store: "sites", field: "siteId" } };
const AUDIT_ENTITY = { photos: "photo", signatures: "signature", kySubmissions: "kySubmission" };

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256OfBytes(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
async function sha256OfBlob(blob) { return sha256OfBytes(await blob.arrayBuffer()); }

/** 比較用: キーを並べ替えたJSON。Blobは指紋に置き換える（中身が同じなら同じ） */
async function comparableText(record, storeName, blobSha) {
  const clone = { ...record };
  for (const { field } of BLOB_FIELDS[storeName] || []) {
    if (blobSha && blobSha[field]) clone[field] = `sha256:${blobSha[field]}`;
    else if (clone[field] instanceof Blob) clone[field] = `sha256:${await sha256OfBlob(clone[field])}`;
    delete clone[`${field}File`];
    delete clone[`${field}MimeTypeBackup`];
  }
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  return JSON.stringify(sortKeys(clone));
}

/**
 * 計画の時点の端末の状態を、トランザクションの中で同期的に比べるための文字列（キーを並べ替えたJSON）。
 * Blob は中身を同期的に読めないので「大きさ・種類」に置き換える（中身の照合は、適用の直前に SHA-256 で別に行う）。
 * レコードが無ければ null。updatedAt・論理削除の印（isDeleted）を含むすべての項目を比べるので、updatedAt が同じまま
 * 内容だけが変わった場合も違いが分かる
 */
function syncFingerprint(record) {
  if (!record) return null;
  const sortKeys = (v) => (v instanceof Blob ? `blob:${v.size}:${v.type}` : Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  return JSON.stringify(sortKeys(record));
}
/** レコードの Blob の項目ごとの SHA-256（無ければ空） */
async function blobShasOf(record, storeName) {
  const out = {};
  if (!record) return out;
  for (const { field } of BLOB_FIELDS[storeName] || []) if (record[field] instanceof Blob) out[field] = await sha256OfBlob(record[field]);
  return out;
}
/** 計画の正しさに関わるストア全体（標準テンプレートの数・現場の固定が指す版を、最終の状態の検査で使う） */
const GUARD_WHOLE_STORES = ["sites", "reportTemplates"];
const wholeStoreFingerprint = (records) => JSON.stringify(records.map((r) => [String(r.id), syncFingerprint(r)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

/** 計画を作った後に端末のデータが変わったときのエラー（復元は中止し、何も書かない） */
export const RESTORE_PLAN_STALE_MESSAGE = "端末のデータが計画作成後に変更されたため、復元を中止しました。最新の状態を再検査してください";
function staleError(changes) {
  const e = new Error(`${RESTORE_PLAN_STALE_MESSAGE}（変わったもの: ${changes.slice(0, 5).join("／")}${changes.length > 5 ? ` ほか${changes.length - 5}件` : ""}）`);
  e.stale = true;
  e.changes = changes;
  return e;
}

/**
 * ① 検査 ＋ ② 計画（どちらも書き込まない）。
 * @returns {Promise<{ok: boolean, errors: {store: string, id: string, reason: string}[], warnings: string[], manifest: object|null,
 *   format: {formatVersion: number, dbVersion: number|null, legacy: boolean}, stores: object, items: object[], attachments: number}>}
 *   items: { key, store, id, record（Blobを復元した形）, action: "new"|"overwrite"|"same"|"conflict"|"candidate", reason, defaultApply }
 */
export async function analyzeBackupFile(file) {
  const errors = [];
  const warnings = [];
  const err = (store, id, reason) => errors.push({ store, id: id == null ? "" : String(id), reason });
  const result = { ok: false, errors, warnings, manifest: null, format: null, stores: {}, items: [], attachments: 0, fileName: file?.name || "" };

  // ZIPの構造
  let zip;
  try { zip = loadZip(await file.arrayBuffer()); } catch (e) { err("(ファイル)", "", `ZIPファイルとして読めません（${e.message}）`); return result; }

  // manifest
  let manifest = null;
  try {
    const text = await readZipEntryText(zip, "manifest.json");
    if (!text) err("manifest.json", "", "manifest.json がありません（このアプリのバックアップではない可能性があります）");
    else manifest = JSON.parse(text);
  } catch (e) { err("manifest.json", "", `manifest.json を読めません（${e.message}）`); }
  if (manifest && (typeof manifest !== "object" || Array.isArray(manifest) || !manifest.recordCounts || typeof manifest.recordCounts !== "object")) {
    err("manifest.json", "", "manifest.json の形式が正しくありません（recordCounts がありません）");
    manifest = null;
  }
  if (!manifest) return result;
  result.manifest = manifest;
  const formatVersion = manifest.formatVersion == null ? 1 : Number(manifest.formatVersion);
  const dbVersion = manifest.dbVersion == null ? null : Number(manifest.dbVersion);
  result.format = { formatVersion, dbVersion, legacy: manifest.formatVersion == null };
  if (!Number.isInteger(formatVersion) || formatVersion < 1) err("manifest.json", "", `形式の版（formatVersion: ${manifest.formatVersion}）が正しくありません`);
  else if (formatVersion > BACKUP_FORMAT_VERSION) err("manifest.json", "", `このアプリより新しい形式（版${formatVersion}）のバックアップです。アプリを更新してから復元してください（書き込まずに中止しました）`);
  if (dbVersion != null && (!Number.isInteger(dbVersion) || dbVersion > DB_VERSION)) err("manifest.json", "", `このアプリより新しいDBの版（v${manifest.dbVersion}）のバックアップです。アプリを更新してから復元してください（書き込まずに中止しました）`);
  const knownStores = new Set(DATA_STORES);
  for (const name of zip.entries.keys()) {
    const m = name.match(/^data\/(.+)\.json$/);
    if (m && !knownStores.has(m[1])) err(m[1], "", `このアプリが知らないデータ（data/${m[1]}.json）が含まれています（新しい形式の可能性があるため中止しました）`);
  }
  for (const s of Object.keys(manifest.recordCounts)) if (!knownStores.has(s)) err(s, "", `manifest に、このアプリが知らないデータ（${s}）があります`);
  const blobHashes = manifest.blobs && typeof manifest.blobs === "object" ? manifest.blobs : null;

  // 各ストアのJSON・id・必須項目・件数・添付ファイル
  const incoming = {}; // store -> Map(id -> { record, blobSha })
  for (const storeName of DATA_STORES) {
    const map = new Map();
    incoming[storeName] = map;
    let text;
    try { text = await readZipEntryText(zip, `data/${storeName}.json`); } catch (e) { err(storeName, "", `data/${storeName}.json を読めません（${e.message}）`); continue; }
    const expected = manifest.recordCounts[storeName];
    if (text == null) {
      // 古いバックアップ（そのストアができる前の版）には無いことがある。manifest にも件数が無い（または0）なら0件として扱う
      if (expected) err(storeName, "", `manifest では ${expected}件ですが、data/${storeName}.json がありません`);
      continue;
    }
    let records;
    try { records = JSON.parse(text); } catch (e) { err(storeName, "", `data/${storeName}.json が壊れています（JSONとして読めません: ${e.message}）`); continue; }
    if (!Array.isArray(records)) { err(storeName, "", `data/${storeName}.json の形式が正しくありません（一覧ではありません）`); continue; }
    if (expected != null && expected !== records.length) err(storeName, "", `件数が manifest（${expected}件）と実際（${records.length}件）で違います`);
    const blobDefs = BLOB_FIELDS[storeName] || [];
    for (const rec of records) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) { err(storeName, "", "レコードの形式が正しくありません"); continue; }
      const id = rec.id;
      if (isBlank(id) || (typeof id !== "string" && typeof id !== "number")) { err(storeName, "", "id がありません"); continue; }
      if (map.has(id)) { err(storeName, id, "id が重複しています"); continue; }
      const missing = (REQUIRED_FIELDS[storeName] || []).filter((f) => isBlank(rec[f]));
      if (missing.length) err(storeName, id, `必須の項目がありません（${missing.join("・")}）`);
      const record = { ...rec };
      const blobSha = {};
      for (const { field } of blobDefs) {
        const fileName = rec[`${field}File`];
        if (!fileName) continue;
        result.attachments++;
        const bytes = await readZipEntryBytes(zip, fileName).catch(() => null);
        if (!bytes) { err(storeName, id, `添付ファイル（${field}）が見つかりません（${fileName}）`); continue; }
        if (!bytes.byteLength) { err(storeName, id, `添付ファイル（${field}）が空です（${fileName}）`); continue; }
        const sha = await sha256OfBytes(bytes);
        if (blobHashes && blobHashes[fileName] && blobHashes[fileName] !== sha) { err(storeName, id, `添付ファイル（${field}）が壊れています（記録された指紋と中身が違います）`); continue; }
        if (storeName === "reportTemplates" && field === "sourceFileBlob" && rec.sourceFileSha256 && rec.sourceFileSha256 !== sha) { err(storeName, id, "テンプレートのファイルの中身が、記録された指紋（SHA-256）と違います"); continue; }
        record[field] = new Blob([bytes], { type: rec[`${field}MimeTypeBackup`] || "" });
        blobSha[field] = sha;
        delete record[`${field}File`];
        delete record[`${field}MimeTypeBackup`];
      }
      if (storeName === "reportTemplates" && rec.revision != null && !(Number.isInteger(rec.revision) && rec.revision >= 1)) err(storeName, id, `テンプレートの版（${rec.revision}）が正しくありません`);
      map.set(id, { record, blobSha });
    }
  }

  // 参照関係（バックアップの中、またはこの端末にあればよい）
  const localIds = {};
  for (const s of ["sites", "reports"]) localIds[s] = new Set((await dbGetAll(s)).map((r) => r.id));
  const exists = (store, id) => incoming[store].has(id) || localIds[store].has(id);
  for (const [id, { record }] of incoming.reports) if (!isBlank(record.siteId) && !exists("sites", record.siteId)) err("reports", id, `参照している現場（${record.siteId}）がバックアップにもこの端末にもありません`);
  for (const s of ["photos", "signatures"]) for (const [id, { record }] of incoming[s]) if (!isBlank(record.reportId) && !exists("reports", record.reportId)) err(s, id, `参照している日報（${record.reportId}）がバックアップにもこの端末にもありません`);
  for (const [id, { record }] of incoming.kySubmissions) if (!isBlank(record.siteId) && !exists("sites", record.siteId)) err("kySubmissions", id, `参照している現場（${record.siteId}）がバックアップにもこの端末にもありません`);

  // ② 計画。あわせて、計画の正しさに関わる端末の状態を記録する（result.guard。適用のときに、変わっていないか確かめる）:
  //   ・バックアップのすべてのレコードについて、同じidの端末のレコードの有無・内容（updatedAt・論理削除の印を含む全項目）・添付ファイルの指紋
  //   ・参照先（日報→現場、写真・署名→日報、KY→現場）で、バックアップに無く端末にだけあるもの（有無・内容）
  //   ・現場・帳票テンプレートのストア全体（標準テンプレートの数・現場の固定が指す版の検査に使うため。追加・削除も分かる）
  const guard = { records: new Map(), wholeStores: {} };
  const watch = async (store, id, local) => {
    const key = `${store}:${id}`;
    if (guard.records.has(key)) return;
    guard.records.set(key, { store, id, fp: syncFingerprint(local), blobSha: await blobShasOf(local, store) });
  };
  const deletedByLog = new Set((await dbGetAll("auditLog")).filter((a) => a.action === "delete" && Object.values(AUDIT_ENTITY).includes(a.entityType)).map((a) => `${a.entityType}:${a.entityId}`));
  for (const storeName of DATA_STORES) {
    const st = { new: 0, overwrite: 0, same: 0, conflict: 0, candidate: 0, attachments: 0, errors: errors.filter((e) => e.store === storeName).length };
    result.stores[storeName] = st;
    for (const [id, { record, blobSha }] of incoming[storeName]) {
      st.attachments += Object.keys(blobSha).length;
      const local = await dbGet(storeName, id);
      const key = `${storeName}:${id}`;
      await watch(storeName, id, local);
      const localBlobSha = guard.records.get(key).blobSha;
      const label = record[RECORD_LABEL_FIELDS[storeName]] || id;
      let action; let reason = ""; let defaultApply;
      if (!local) {
        const parent = PHYSICAL_DELETE_PARENT[storeName];
        if (parent && !isBlank(record[parent.field]) && (await dbGet(parent.store, record[parent.field]))) {
          action = "candidate"; defaultApply = false;
          reason = deletedByLog.has(`${AUDIT_ENTITY[storeName]}:${id}`)
            ? "この端末で削除した記録があります（復元すると戻ります）"
            : "この端末に無いデータです（この端末で削除した可能性があります。削除の記録は無いため、削除済みとは断定できません）";
        } else { action = "new"; defaultApply = true; }
      } else if ((await comparableText(local, storeName, localBlobSha)) === (await comparableText(record, storeName, blobSha))) {
        action = "same"; defaultApply = false;
      } else if (!local.updatedAt || !record.updatedAt) {
        action = "conflict"; defaultApply = false; reason = "更新日時（updatedAt）が無いため、どちらが新しいか判断できません";
      } else if (local.updatedAt === record.updatedAt) {
        action = "conflict"; defaultApply = false; reason = "更新日時が同じなのに内容が違います";
      } else if (local.updatedAt > record.updatedAt) {
        action = "conflict"; defaultApply = false; reason = local.isDeleted && !record.isDeleted ? "この端末では削除済みです（復元すると、削除したデータが戻ります）" : "この端末の方が新しい内容です";
      } else { action = "overwrite"; defaultApply = true; }
      st[action === "same" ? "same" : action]++;
      const parentRef = storeName === "reports" ? ["sites", record.siteId] : storeName === "photos" || storeName === "signatures" ? ["reports", record.reportId] : storeName === "kySubmissions" ? ["sites", record.siteId] : null;
      if (parentRef && !isBlank(parentRef[1]) && !incoming[parentRef[0]].has(parentRef[1])) await watch(parentRef[0], parentRef[1], await dbGet(parentRef[0], parentRef[1]));
      result.items.push({ key, store: storeName, storeLabel: STORE_LABELS[storeName] || storeName, id, label: String(label), record, blobSha, action, reason, defaultApply, localUpdatedAt: local?.updatedAt || "", incomingUpdatedAt: record.updatedAt || "" });
    }
  }
  for (const s of GUARD_WHOLE_STORES) guard.wholeStores[s] = wholeStoreFingerprint(await dbGetAll(s));
  result.guard = guard;
  result.state = "planned"; // 適用したら "applied"、計画が古くなったら "stale"（どちらも、この計画では二度と適用しない）
  // 既定の選び方（新規・上書きだけを書く）で復元したときの最終の状態も検査する（標準テンプレートの重複・現場の固定が指す版）。
  // 選び方を変えたときは、適用の直前にもう一度検査する（applyBackupRestore）
  if (errors.length === 0) {
    const defaultWrites = result.items.filter((it) => it.defaultApply && it.action !== "same").map((it) => ({ store: it.store, value: it.record }));
    for (const p of await checkFinalState(defaultWrites)) err(p.store, p.id, p.reason);
    // 前からある署名の重複（復元で増えないもの）は、直さず・消さずに知らせるだけ
    for (const g of (await signatureDupCheck(defaultWrites)).existing) warnings.push(`この端末に、前から重複している署名があります（${g.text}）。復元では直しません（どちらも削除しません）`);
    for (const e of errors) if (result.stores[e.store]) result.stores[e.store].errors++;
  }
  result.ok = errors.length === 0;
  return result;
}

/* ---------- 最終の状態の検査（書き込みを確定する前に行う。同期の中心部は、トランザクションの中でも同じものを使う） ---------- */

/** 参照（子 → 親）。復元後の予定の状態で、書き込む子レコードの親があること */
const PARENT_REF = { reports: ["sites", "siteId"], photos: ["reports", "reportId"], signatures: ["reports", "reportId"], kySubmissions: ["sites", "siteId"] };
/** 復旧で消すレコードを参照している子（索引で探す）。復元の後に利用者が足した子があれば、復旧を中止する */
const CHILD_INDEXES = {
  sites: [["reports", "by_siteId"], ["kySubmissions", "by_siteId"], ["estimateBatches", "by_siteId"], ["estimateItems", "by_siteId"], ["vendorQuoteBatches", "by_siteId"], ["vendorQuoteItems", "by_siteId"], ["itemMatchOverrides", "by_siteId"], ["omissionDispositions", "by_siteId"], ["submissionPlans", "by_siteId"], ["submissionAssignments", "by_siteId"], ["submissionImports", "by_siteId"]],
  reports: [["photos", "by_reportId"], ["signatures", "by_reportId"]],
  estimateBatches: [["estimateItems", "by_estimateBatchId"]],
  vendorQuoteBatches: [["vendorQuoteItems", "by_vendorQuoteBatchId"]],
  estimateItems: [["submissionAssignments", "by_estimateItemId"]]
};

/** list（ストアの全レコード）に、書き込み（put）・削除を重ねた結果 */
function overlay(list, storeName, puts = [], deletes = []) {
  const map = new Map((list || []).map((r) => [r.id, r]));
  for (const w of puts) if (w.store === storeName) map.set(w.value.id, w.value);
  for (const d of deletes) if (d.store === storeName) map.delete(d.delete);
  return [...map.values()];
}
/** テンプレートの SHA-256（記録された sourceFileSha256。無ければ前もって計算したもの） */
async function templateShaMap(templates) {
  const m = new Map();
  for (const t of templates) if (!t.sourceFileSha256 && t.sourceFileBlob instanceof Blob) m.set(t.id, await sha256OfBlob(t.sourceFileBlob));
  return m;
}
/** 標準テンプレートが1件以下か・現場の固定（templatePin）が指すテンプレート（id、または退避した版）が SHA-256 まで一致して存在するか（同期） */
function finalStateProblemsSync(templates, sites, shaMap) {
  const problems = [];
  const shaOf = (t) => t.sourceFileSha256 || shaMap.get(t.id) || "";
  const live = templates.filter((t) => !t.isDeleted);
  const defaults = live.filter((t) => t.isAppDefault && (t.templateKind || "report") === "report");
  if (defaults.length > 1) problems.push({ store: "reportTemplates", id: defaults.map((t) => t.id).join("・"), reason: `標準テンプレートが${defaults.length}件になります（1件だけにする必要があります）` });
  for (const site of sites) {
    const pin = site.templatePin;
    if (site.isDeleted || !pin || !pin.templateId) continue;
    const found = live.some((t) => (t.id === pin.templateId || (t.templateKind === "report_archive" && t.archivedOf === pin.templateId)) && (!pin.sha256 || shaOf(t) === pin.sha256));
    if (!found) problems.push({ store: "sites", id: site.id, reason: `現場「${site.name || site.id}」が固定しているテンプレート（${pin.templateId}・第${pin.revision || "?"}版・SHA-256 ${String(pin.sha256 || "").slice(0, 12)}）が見つかりません` });
  }
  return problems;
}
/** 書き込む子レコード（日報・写真・署名・KY）の親が、復元後の予定の状態にあるか（同期。lookup(ストア, id) は予定の状態のレコード） */
function refProblemsSync(puts, lookup) {
  const problems = [];
  for (const w of puts) {
    const ref = PARENT_REF[w.store];
    if (!ref) continue;
    const pid = w.value[ref[1]];
    if (isBlank(pid)) continue;
    if (!lookup(ref[0], pid)) problems.push({ store: w.store, id: w.value.id, reason: `復元後に、参照している${STORE_LABELS[ref[0]]}（${pid}）がありません` });
  }
  return problems;
}
function finalStateError(problems, prefix = "復元すると整合しない状態になるため、書き込みませんでした") {
  const e = new Error(`${prefix}（${problems.slice(0, 5).map((p) => p.reason).join("／")}${problems.length > 5 ? ` ほか${problems.length - 5}件` : ""}）`);
  e.problems = problems;
  return e;
}

/** 最終の状態（今の端末＋書き込む予定のレコード）の検査（トランザクションの外。添付ファイルの SHA-256 の計算を含む） */
async function checkFinalState(writes) {
  const templates = overlay(await dbGetAll("reportTemplates"), "reportTemplates", writes);
  const sites = overlay(await dbGetAll("sites"), "sites", writes);
  const problems = finalStateProblemsSync(templates, sites, await templateShaMap(templates));
  const byKey = new Map(writes.map((w) => [`${w.store}:${w.value.id}`, w.value]));
  const parents = new Map();
  for (const w of writes) {
    const ref = PARENT_REF[w.store];
    if (!ref || isBlank(w.value[ref[1]])) continue;
    const k = `${ref[0]}:${w.value[ref[1]]}`;
    if (!byKey.has(k) && !parents.has(k)) parents.set(k, await dbGet(ref[0], w.value[ref[1]]));
  }
  problems.push(...refProblemsSync(writes, (s, id) => byKey.get(`${s}:${id}`) || parents.get(`${s}:${id}`)));
  problems.push(...(await signatureDupCheck(writes)).problems);
  return problems;
}

/* ---------- 署名の重複（同じ日報・同じ業者の行・同じ役割に、削除されていない署名が2件以上。signatures.js の signatureDupKey） ----------
   書き込み（復元・復旧）で新しく重複になる（重複が増える）場合は、確定する前に中止する。前からある重複は、直さず・消さずに知らせるだけ */

/** 書き込み・削除で署名が変わる日報（書き込む署名の日報と、上書きされる署名の今の日報） */
async function signatureReportsTouched(puts, deletes = []) {
  const ids = new Set();
  for (const w of puts) if (w.store === "signatures") {
    if (w.value.reportId) ids.add(w.value.reportId);
    const local = await dbGet("signatures", w.value.id);
    if (local?.reportId) ids.add(local.reportId);
  }
  for (const d of deletes) if (d.store === "signatures") { const local = await dbGet("signatures", d.delete); if (local?.reportId) ids.add(local.reportId); }
  return [...ids];
}
/** 署名の重複の比較（同期。before: 書き込みの前のその日報の署名、after: 書き込んだ後の予定）→ 問題（新しい重複）と、前からある重複 */
function signatureDupProblemsSync(before, puts, deletes, reportIds, dates = new Map(), verb = "復元") {
  const set = new Set(reportIds);
  const after = overlay(before, "signatures", puts, deletes).filter((x) => set.has(x.reportId));
  const { added, existing } = compareSignatureDuplicates(before.filter((x) => set.has(x.reportId)), after);
  const describe = (g) => `日報 ${dates.get(g.reportId) || g.reportId}・業者の行 ${g.companyId || "（なし）"}・${g.role === "foreman" ? "職長" : g.role}: 署名 ${g.ids.join("・")}`;
  return {
    problems: added.map((g) => ({ store: "signatures", id: g.ids.join("・"), reason: `${verb}すると、同じ日報・同じ業者の行の署名が${g.ids.length}件に重複します（${describe(g)}）。どちらも削除しません`, group: g })),
    existing: existing.map((g) => ({ ...g, text: describe(g) }))
  };
}
/** 署名の組ごとの件数（削除済みは数えない）。トランザクションの前に数えておき、中の確認・確定した後の確認の基準にする */
function signatureCounts(list) {
  const out = {};
  for (const x of list || []) if (x && !x.isDeleted && x.reportId) out[signatureDupKey(x)] = (out[signatureDupKey(x)] || 0) + 1;
  return out;
}
/**
 * トランザクションの中の確認（同期）: 読み直したその日報の署名（current）に書き込み・削除を重ねた後で、組の件数が
 * トランザクションの前に数えた件数（baseline。重複でなければ1）より多くなる組を問題にする。
 * 中で読み直した件数を基準にしないのは、前の検査の後に別の処理が足した署名を「前からある重複」と見誤らないため
 */
function signatureDupExceedsSync(current, puts, deletes, reportIds, baseline, dates = new Map(), verb = "復元") {
  const set = new Set(reportIds);
  const after = overlay(current, "signatures", puts, deletes).filter((x) => set.has(x.reportId));
  const problems = [];
  for (const [k, list] of signatureDuplicateGroups(after)) {
    if (list.length <= (baseline[k] || 1)) continue;
    const [reportId, companyId, role] = k.split("|");
    problems.push({ store: "signatures", id: list.join("・"), reason: `${verb}すると、同じ日報・同じ業者の行の署名が${list.length}件に重複します（日報 ${dates.get(reportId) || reportId}・業者の行 ${companyId || "（なし）"}・${role === "foreman" ? "職長" : role}: 署名 ${list.join("・")}）。どちらも削除しません` });
  }
  return problems;
}
/** 署名の重複の検査（トランザクションの外。今の端末の署名を読む） */
async function signatureDupCheck(puts, deletes = [], verb = "復元") {
  const reportIds = await signatureReportsTouched(puts, deletes);
  const before = []; const dates = new Map();
  for (const rid of reportIds) {
    before.push(...(await dbGetAll("signatures", "by_reportId", rid)));
    const r = await dbGet("reports", rid);
    if (r?.date) dates.set(rid, r.date);
  }
  return { reportIds, dates, before, ...signatureDupProblemsSync(before, puts, deletes, reportIds, dates, verb) };
}

/**
 * 計画の時点から端末のデータが変わっていないか（トランザクションの外で。添付ファイルの中身も SHA-256 で比べる）。
 * 変わったもの（"ストア:id" など）の一覧を返す
 */
async function guardChangesAsync(guard) {
  const changes = [];
  for (const [key, g] of guard.records) {
    const now = await dbGet(g.store, g.id);
    if (syncFingerprint(now) !== g.fp) { changes.push(key); continue; }
    const sha = await blobShasOf(now, g.store);
    if (JSON.stringify(sha) !== JSON.stringify(g.blobSha)) changes.push(`${key}（添付ファイル）`);
  }
  for (const [s, fp] of Object.entries(guard.wholeStores)) if (wholeStoreFingerprint(await dbGetAll(s)) !== fp) changes.push(`${s}（全体）`);
  return changes;
}
/** 同じ確認を、トランザクションの中で読んだ結果に対して同期的に行う（添付ファイルは大きさ・種類まで） */
function guardChangesSync(guard, { records, all }) {
  const changes = [];
  for (const [key, g] of guard.records) if (syncFingerprint(records.get(key)) !== g.fp) changes.push(key);
  for (const [s, fp] of Object.entries(guard.wholeStores)) if (wholeStoreFingerprint(all[s] || []) !== fp) changes.push(`${s}（全体）`);
  return changes;
}

/* ---------- 復元の記録（退避と状態）と復旧（2026-10-18。案3） ----------
   ・保存場所は既存の meta ストア（DBの版は v10 のまま。meta はバックアップの対象外で、キーで1件ずつ読み書きされるだけ。
     既存のキー（migrationDone・backupExportDirHandle・bundledTemplateKey・bundledTemplateSeeded:*・anthropicApiKey）とは
     接頭辞で分ける）。1回の復元につき2件:
       restoreJournal:<復元id>      状態の記録（小さい。状態が変わるたびに書き直す）
       restoreJournalData:<復元id>  退避（書き込んだレコードごとに: 復元前の内容（無かったものは null＝復旧で削除）・添付ファイルの指紋・
                                     書き込んだ内容の指紋）。復元のトランザクションで1回だけ書き、決着したら（確認成功・復旧済み・閉じた）消す。
                                     画像（Blob）を含むので、状態の更新では書き直さない（WebKit で、保存場所から読んだ Blob を書き直すと
                                     読めなくなることがあったため）
   ・状態: 復元準備中（画面の中だけ。トランザクションが確定するまで、退避も復元も保存されない）→ written（書き込み済み・確認待ち）→
     verified（確認成功）／needs_recovery（復旧が必要）→ recovered（復旧済み）／recovery_failed（復旧失敗。データは変わっていない。
     もう一度試せる）。利用者が「復旧せずに閉じる」を選ぶと closed。決着していない（written・needs_recovery・recovery_failed）記録が
     あるあいだは、新しい復元をしない（後の復元の上から前の復旧をすると、後の復元を壊すため）
   ・退避と復元の書き込み、復旧の書き込みと退避の削除・状態の更新は、それぞれ1つのトランザクション（どちらか一方だけが残らない）
   ・復旧は自動では行わない（画面で利用者が押したときだけ） */
const JOURNAL_PREFIX = "restoreJournal:";
const JOURNAL_DATA_PREFIX = "restoreJournalData:";
export const RESTORE_JOURNAL_STATE_LABELS = {
  written: "書き込み済み・確認待ち",
  verified: "確認成功",
  needs_recovery: "復旧が必要",
  recovered: "復旧済み",
  recovery_failed: "復旧失敗（データは変わっていません）",
  closed: "復旧せずに閉じた"
};
const UNRESOLVED_STATES = ["written", "needs_recovery", "recovery_failed"];
const dataKeyOf = (restoreId) => `${JOURNAL_DATA_PREFIX}${restoreId}`;

/** 文字列の短い指紋（同期。変化の検出用で、暗号的な強さは要らない。53ビット×2） */
function fpHash(str) {
  if (str == null) return null;
  const h = (seed) => {
    let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  };
  return `${h(1)}${h(2)}:${str.length}`;
}
/** レコードの複製（Blob は中身を読み直した独立した Blob にする）。expectedSha があれば中身の指紋を確かめ、違えば null を返す */
async function independentCopy(record, storeName, expectedSha = null) {
  const out = { ...record };
  const sha = {};
  for (const { field } of BLOB_FIELDS[storeName] || []) {
    if (!(record[field] instanceof Blob)) continue;
    const bytes = await record[field].arrayBuffer();
    sha[field] = await sha256OfBytes(bytes);
    if (expectedSha && expectedSha[field] !== sha[field]) return null;
    out[field] = new Blob([bytes], { type: record[field].type || "" });
  }
  if (expectedSha && Object.keys(expectedSha).length !== Object.keys(sha).length) return null;
  return { record: out, sha };
}

/** 復元の記録（状態）の一覧（新しい順）。onlyUnresolved: 決着していないものだけ */
export async function listRestoreJournals({ onlyUnresolved = false } = {}) {
  const all = await dbGetAll("meta", null, IDBKeyRange.bound(JOURNAL_PREFIX, `${JOURNAL_PREFIX}￿`));
  return all.filter((j) => !onlyUnresolved || UNRESOLVED_STATES.includes(j.state)).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/** 状態の記録だけを書き換える（1つのトランザクションで、今の状態が fromStates のどれかであることを確かめてから）。dropData: 退避も消す */
async function setJournalState(key, fromStates, toState, extra = {}, { dropData = false } = {}) {
  const at = new Date().toISOString();
  let updated = null;
  await dbGuardedPutMany({
    reads: [{ store: "meta", id: key }],
    check: ({ records }) => {
      const cur = records.get(`meta:${key}`);
      if (!cur) return new Error("復元の記録が見つかりません");
      if (!fromStates.includes(cur.state)) return new Error(`復元の記録の状態が「${RESTORE_JOURNAL_STATE_LABELS[cur.state] || cur.state}」に変わっているため、更新しませんでした`);
      updated = { ...cur, ...extra, state: toState, stateAt: at, history: [...(cur.history || []), { state: toState, at, note: extra.lastError || "" }].slice(-50) };
      return null;
    },
    // check の中で作る updated を使うため、entries は後から差し込む（下の entriesOf）
    entries: [],
    entriesOf: () => [{ store: "meta", value: updated }, ...(dropData ? [{ store: "meta", delete: dataKeyOf(updated.restoreId) }] : [])]
  });
  return updated;
}

/** 書き込んだレコードが、書き込んだとおりに読めるか（内容の指紋・添付ファイルの SHA-256）と、最終の状態（標準テンプレート・現場の固定）の確認 */
async function verifyJournalData(data) {
  const mismatches = [];
  for (const e of data.entries) {
    const label = `${STORE_LABELS[e.store] || e.store}:${e.id}`;
    const saved = await dbGet(e.store, e.id);
    if (!saved) { mismatches.push(`${label} が見つかりません`); continue; }
    if (fpHash(syncFingerprint(saved)) !== e.afterHash) { mismatches.push(`${label} の内容が書き込んだものと違います`); continue; }
    for (const [field, sha] of Object.entries(e.afterBlobSha || {})) {
      if (!(saved[field] instanceof Blob)) { mismatches.push(`${label} の添付ファイルがありません`); continue; }
      let actual = "";
      try { actual = await sha256OfBlob(saved[field]); } catch (err) { mismatches.push(`${label} の添付ファイルを読めません（${err.message}）`); continue; }
      if (actual !== sha) mismatches.push(`${label} の添付ファイルの指紋が違います`);
    }
  }
  for (const p of await checkFinalState([])) mismatches.push(p.reason);
  // 署名の重複（書き込む前より増えた組）
  for (const rid of data.sigReports || []) {
    for (const [k, ids] of signatureDuplicateGroups(await dbGetAll("signatures", "by_reportId", rid))) {
      if (ids.length > ((data.sigBaseline || {})[k] || 1)) mismatches.push(`署名が重複しています（日報 ${rid}・業者の行 ${k.split("|")[1] || "（なし）"}: 署名 ${ids.join("・")}）`);
    }
  }
  return mismatches;
}

/**
 * ③ 一括適用 ＋ ④ 確認。analysis は analyzeBackupFile の結果（ok であること）。
 * ・計画を作った後に端末のデータが変わっていたら（別のタブ・ウィンドウでの変更など）、何も書かずに中止する（error.stale = true）。
 *   トランザクションの前（添付ファイルの SHA-256 を含む）と、トランザクションの中（同期。添付ファイルは大きさ・種類まで）の2回確かめる
 * ・書き込みを確定する前の検査（案2）: 標準テンプレートの重複・現場の固定が指すテンプレート（id・SHA-256）・書き込む日報・写真・署名・KY の
 *   親が復元後にあること。トランザクションの前に行い、同じ検査（同期の部分）をトランザクションの中でもう一度行う。問題があれば書き込まない
 * ・退避（案3）: 書き込むレコードの復元前の内容（無かったものは「無かった」）を、復元の書き込みと同じトランザクションで meta に保存する
 * ・確定した後の確認で食い違いがあれば、記録を「復旧が必要」にして失敗とする（自動では戻さない。error.needsRecovery・error.journalKey）
 * 一度適用した計画・古くなった計画は、もう一度は適用しない（もう一度検査して計画を作り直す）。
 * @param {{applyKeys: Set<string>}} choices 既定で適用しない項目（競合・復元候補）のうち、利用者が選んだもの（"ストア:id"）
 * @returns {Promise<{written: number, counts: object, verified: boolean, restoreId: string}>}
 */
export async function applyBackupRestore(analysis, { applyKeys = new Set() } = {}) {
  if (!analysis?.ok) throw new Error("検査で問題が見つかったバックアップは復元できません");
  if (analysis.state === "stale") throw staleError(["（この計画は古くなっています）"]);
  if (analysis.state !== "planned" || !analysis.guard) throw new Error("この復元の計画は使えません（適用済み、または計画が作られていません）。もう一度ファイルを選んで検査してください");
  const pending = await listRestoreJournals({ onlyUnresolved: true });
  if (pending.length) throw new Error(`前回のバックアップからの復元が決着していません（${RESTORE_JOURNAL_STATE_LABELS[pending[0].state]}・${pending[0].fileName || ""}）。バックアップ管理の「未完了の復元」で確認・復旧してから、もう一度復元してください`);
  const chosen = analysis.items.filter((it) => it.action !== "same" && (it.defaultApply || applyKeys.has(it.key)));
  const writes = chosen.map((it) => ({ store: it.store, value: it.record }));
  const counts = {};
  for (const it of chosen) counts[it.store] = (counts[it.store] || 0) + 1;
  // 計画の時点から端末のデータが変わっていないか（添付ファイルの中身を含む）
  const changedBefore = await guardChangesAsync(analysis.guard);
  if (changedBefore.length) { analysis.state = "stale"; throw staleError(changedBefore); }
  // 書き込みを確定する前の検査（標準テンプレート・現場の固定・参照）
  const problems = await checkFinalState(writes);
  if (problems.length) throw finalStateError(problems);
  // 署名の重複: トランザクションの中でも確かめるため、署名が変わる日報と、その日報の今の署名の組ごとの件数（確定した後の確認の基準）
  const sigCheck = await signatureDupCheck(writes);
  const sigBaseline = signatureCounts(sigCheck.before);
  // 退避: 書き込むレコードの復元前の内容（添付ファイルは独立した複製。計画の時点の指紋と一致すること）
  const entries = [];
  for (const it of chosen) {
    const g = analysis.guard.records.get(it.key);
    const local = await dbGet(it.store, it.id);
    if (syncFingerprint(local) !== g.fp) { analysis.state = "stale"; throw staleError([it.key]); }
    let before = null; let beforeBlobSha = {};
    if (local) {
      const copy = await independentCopy(local, it.store, g.blobSha);
      if (!copy) { analysis.state = "stale"; throw staleError([`${it.key}（添付ファイル）`]); }
      before = copy.record; beforeBlobSha = copy.sha;
    }
    entries.push({ store: it.store, id: it.id, before, beforeBlobSha, afterHash: fpHash(syncFingerprint(it.record)), afterBlobSha: { ...(it.blobSha || {}) } });
  }
  const restoreId = crypto.randomUUID();
  const at = new Date().toISOString();
  const journal = { key: `${JOURNAL_PREFIX}${restoreId}`, kind: "restoreJournal", restoreId, fileName: analysis.fileName || "", createdAt: at, state: "written", stateAt: at, history: [{ state: "written", at, note: "" }], counts, added: entries.filter((e) => !e.before).length, overwritten: entries.filter((e) => e.before).length };
  const data = { key: dataKeyOf(restoreId), kind: "restoreJournalData", restoreId, createdAt: at, entries, sigReports: sigCheck.reportIds, sigBaseline };
  // トランザクションの中で使うテンプレートの SHA-256（記録の無いものだけ。前もって計算する）
  const shaMap = await templateShaMap(overlay(await dbGetAll("reportTemplates"), "reportTemplates", writes));
  const writeByKey = new Map(writes.map((w) => [`${w.store}:${w.value.id}`, w.value]));
  // 確認・検査・退避・書き込みを1つのトランザクションで（すべてのストア。1件でも失敗すれば全体を取り消す）
  try {
    await dbGuardedPutMany({
      reads: [...analysis.guard.records.values()].map((g) => ({ store: g.store, id: g.id })),
      readAll: Object.keys(analysis.guard.wholeStores),
      readIndexAll: sigCheck.reportIds.map((rid) => ({ store: "signatures", index: "by_reportId", key: rid })),
      check: (got) => {
        const c = guardChangesSync(analysis.guard, got);
        if (c.length) return staleError(c);
        const templates = overlay(got.all.reportTemplates, "reportTemplates", writes);
        const sites = overlay(got.all.sites, "sites", writes);
        const sigBefore = sigCheck.reportIds.flatMap((rid) => got.indexAll.get(`signatures|by_reportId|${rid}`) || []);
        const p = [...finalStateProblemsSync(templates, sites, shaMap), ...refProblemsSync(writes, (s, id) => writeByKey.get(`${s}:${id}`) || got.records.get(`${s}:${id}`)), ...signatureDupExceedsSync(sigBefore, writes, [], sigCheck.reportIds, sigBaseline, sigCheck.dates)];
        return p.length ? finalStateError(p) : null;
      },
      entries: [...writes, { store: "meta", value: data }, { store: "meta", value: journal }]
    });
  } catch (e) {
    if (e?.stale) analysis.state = "stale";
    throw e;
  }
  analysis.state = "applied";
  // ④ 確定した後の確認（書き込んだとおりに読めるか・添付ファイルの指紋・最終の状態）
  const mismatches = await verifyJournalData(data);
  if (mismatches.length) {
    await setJournalState(journal.key, ["written"], "needs_recovery", { lastError: mismatches.slice(0, 5).join("／") }).catch(() => {});
    const e = new Error(`書き込みは完了しましたが、書き込み後の確認で食い違いが見つかりました（${mismatches.slice(0, 5).join("／")}）。バックアップ管理の「未完了の復元」から、復元前の状態に戻せます（自動では戻しません）`);
    e.mismatches = mismatches;
    e.needsRecovery = true;
    e.journalKey = journal.key;
    throw e;
  }
  await setJournalState(journal.key, ["written"], "verified", {}, { dropData: true });
  await recordChange({ entityType: "backup", entityId: "restore", action: "update", summary: `バックアップ「${analysis.fileName}」から復元（${Object.entries(counts).map(([k, v]) => `${STORE_LABELS[k] || k}:${v}件`).join("、") || "変更なし"}）` });
  return { written: writes.length, counts, verified: true, restoreId };
}

/**
 * 確認が済んでいない復元（written。確認の前にページが閉じられた等）を確かめる。成功なら verified（退避を消す）、食い違いがあれば needs_recovery
 * @returns {Promise<{state: string, mismatches: string[]}>}
 */
export async function verifyPendingRestore(key) {
  const st = await dbGet("meta", key);
  if (!st) throw new Error("復元の記録が見つかりません");
  if (st.state !== "written") throw new Error(`この復元は「${RESTORE_JOURNAL_STATE_LABELS[st.state] || st.state}」のため、確認は不要です`);
  const data = await dbGet("meta", dataKeyOf(st.restoreId));
  if (!data) throw new Error("退避した情報が見つかりません");
  const mismatches = await verifyJournalData(data);
  if (mismatches.length) { await setJournalState(key, ["written"], "needs_recovery", { lastError: mismatches.slice(0, 5).join("／") }); return { state: "needs_recovery", mismatches }; }
  await setJournalState(key, ["written"], "verified", {}, { dropData: true });
  return { state: "verified", mismatches: [] };
}

/**
 * 復旧: 退避した情報で、復元前の状態に戻す（利用者が押したときだけ）。1つのトランザクションで:
 *   ・今の状態が「復元で書き込んだとおり」か確かめる（違えば＝復元の後に編集されていれば、何も書かずに中止し、競合の一覧を返す）
 *   ・消すレコード（復元で新しく足したもの）を参照する子が、復元の後に足されていないか確かめる（あれば中止）
 *   ・戻した後の状態で、標準テンプレートの重複・現場の固定が指すテンプレートを確かめる（問題があれば中止）
 *   ・上書きしたレコードを元の内容に戻し、足したレコードを消し、退避を消し、状態を recovered にする
 * 途中で失敗すれば、トランザクション全体を取り消す（データは変わらない）。そのときは状態を recovery_failed にする（もう一度試せる）
 * @returns {Promise<{restored: number, deleted: number}>}
 */
export async function recoverRestore(key) {
  const st = await dbGet("meta", key);
  if (!st) throw new Error("復元の記録が見つかりません");
  if (!UNRESOLVED_STATES.includes(st.state)) throw new Error(`この復元は「${RESTORE_JOURNAL_STATE_LABELS[st.state] || st.state}」のため、復旧できません`);
  const fail = async (err, conflicts = []) => {
    await setJournalState(key, UNRESOLVED_STATES, "recovery_failed", { lastError: err.message, conflicts: conflicts.slice(0, 50) }).catch(() => {});
    throw err;
  };
  const data = await dbGet("meta", dataKeyOf(st.restoreId));
  if (!data) return fail(new Error("退避した情報が見つからないため、復旧できません（復元前のバックアップのファイルから戻すことを検討してください）"));
  // 今の状態が「復元で書き込んだとおり」か（トランザクションの前。分かりやすい一覧のため。正式な確認はトランザクションの中）
  const label = (e) => `${STORE_LABELS[e.store] || e.store}「${e.before?.[RECORD_LABEL_FIELDS[e.store]] || e.id}」`;
  const conflicts = [];
  for (const e of data.entries) if (fpHash(syncFingerprint(await dbGet(e.store, e.id))) !== e.afterHash) conflicts.push(label(e));
  if (conflicts.length) {
    const err = new Error(`復元の後に変更されたデータがあるため、復旧を中止しました（${conflicts.slice(0, 5).join("・")}${conflicts.length > 5 ? ` ほか${conflicts.length - 5}件` : ""}）。変更した内容を消さないよう、自動では戻しません。手動で直すか、復元前のバックアップのファイルを確認してください`);
    err.conflicts = conflicts;
    return fail(err, conflicts);
  }
  // 戻す内容（Blob は独立した複製にし、退避したときの指紋と一致することを確かめる）
  const puts = []; const deletes = []; const expected = [];
  for (const e of data.entries) {
    if (!e.before) { deletes.push({ store: e.store, delete: e.id }); expected.push({ e, record: null, sha: {} }); continue; }
    const copy = await independentCopy(e.before, e.store, e.beforeBlobSha);
    if (!copy) return fail(new Error(`${label(e)} の退避した添付ファイルが壊れているため、復旧できません（データは変わっていません）`));
    puts.push({ store: e.store, value: copy.record });
    expected.push({ e, record: copy.record, sha: copy.sha });
  }
  const deletedSet = new Set(deletes.map((d) => `${d.store}:${d.delete}`));
  const indexReads = [];
  for (const d of deletes) for (const [store, index] of CHILD_INDEXES[d.store] || []) indexReads.push({ store, index, key: d.delete });
  const shaMap = await templateShaMap([...overlay(await dbGetAll("reportTemplates"), "reportTemplates", puts, deletes)]);
  // 署名の重複（戻した後に重複が増えないか）。トランザクションの外で先に確かめ、中でもう一度確かめる
  const sigCheck = await signatureDupCheck(puts, deletes, "復旧");
  if (sigCheck.problems.length) return fail(finalStateError(sigCheck.problems, "復旧すると署名が重複するため、復旧を中止しました（データは変わっていません）"), sigCheck.problems.map((p) => p.reason));
  try {
    await dbGuardedPutMany({
      reads: [...data.entries.map((e) => ({ store: e.store, id: e.id })), { store: "meta", id: key }, { store: "meta", id: data.key }],
      readAll: ["sites", "reportTemplates"],
      readIndexKeys: indexReads,
      readIndexAll: sigCheck.reportIds.map((rid) => ({ store: "signatures", index: "by_reportId", key: rid })),
      check: ({ records, all, indexKeys, indexAll }) => {
        const cur = records.get(`meta:${key}`);
        if (!cur || cur.state !== st.state || cur.stateAt !== st.stateAt || !records.get(`meta:${data.key}`)) return new Error("復元の記録が別の画面で変更されたため、復旧を中止しました（データは変わっていません）。画面を開き直してください");
        const changed = data.entries.filter((e) => fpHash(syncFingerprint(records.get(`${e.store}:${e.id}`))) !== e.afterHash).map(label);
        if (changed.length) { const err = new Error(`復元の後に変更されたデータがあるため、復旧を中止しました（${changed.slice(0, 5).join("・")}）`); err.conflicts = changed; return err; }
        const orphans = [];
        for (const r of indexReads) for (const childKey of indexKeys.get(`${r.store}|${r.index}|${r.key}`) || []) if (!deletedSet.has(`${r.store}:${childKey}`)) orphans.push(`${STORE_LABELS[r.store] || r.store}:${childKey}（復旧で消す記録を参照）`);
        if (orphans.length) { const err = new Error(`復元の後に、復元で足した記録を参照するデータが足されているため、復旧を中止しました（${orphans.slice(0, 5).join("・")}）`); err.conflicts = orphans; return err; }
        const templates = overlay(all.reportTemplates, "reportTemplates", puts, deletes);
        const sites = overlay(all.sites, "sites", puts, deletes);
        const sigBefore = sigCheck.reportIds.flatMap((rid) => indexAll.get(`signatures|by_reportId|${rid}`) || []);
        const p = [...finalStateProblemsSync(templates, sites, shaMap), ...signatureDupExceedsSync(sigBefore, puts, deletes, sigCheck.reportIds, signatureCounts(sigCheck.before), sigCheck.dates, "復旧")];
        return p.length ? finalStateError(p, "復旧すると整合しない状態になるため、復旧を中止しました") : null;
      },
      entries: [...puts, ...deletes, { store: "meta", delete: data.key }, { store: "meta", value: { ...st, state: "recovered", stateAt: new Date().toISOString(), lastError: "", conflicts: [], history: [...(st.history || []), { state: "recovered", at: new Date().toISOString(), note: "" }].slice(-50) } }]
    });
  } catch (err) {
    return fail(err, err.conflicts || []);
  }
  // 戻した後の確認（復旧の書き込みが確定した後。食い違いがあれば recovery_failed にする。データは戻した状態のまま）
  const mismatches = [];
  for (const { e, record, sha } of expected) {
    const now = await dbGet(e.store, e.id);
    if (!record) { if (now) mismatches.push(`${label(e)} が消えていません`); continue; }
    if (!now || fpHash(syncFingerprint(now)) !== fpHash(syncFingerprint(record))) { mismatches.push(`${label(e)} が元の内容に戻っていません`); continue; }
    for (const [field, s] of Object.entries(sha)) if (!(now[field] instanceof Blob) || (await sha256OfBlob(now[field])) !== s) mismatches.push(`${label(e)} の添付ファイルが元に戻っていません`);
  }
  if (mismatches.length) {
    await setJournalState(key, ["recovered"], "recovery_failed", { lastError: `復旧の書き込み後の確認で食い違い: ${mismatches.slice(0, 5).join("／")}` }).catch(() => {});
    throw new Error(`復旧の書き込みは完了しましたが、確認で食い違いが見つかりました（${mismatches.slice(0, 5).join("／")}）。復元前のバックアップのファイルを確認してください`);
  }
  await recordChange({ entityType: "backup", entityId: "restore-recovery", action: "update", summary: `バックアップ「${st.fileName}」からの復元を取り消し、復元前の状態に戻した（戻した ${puts.length}件・削除 ${deletes.length}件）` });
  return { restored: puts.length, deleted: deletes.length };
}

/** 復旧せずに記録を閉じる（利用者が選んだときだけ。退避を消し、状態を closed にする。データは変えない） */
export async function closeRestoreJournal(key) {
  return setJournalState(key, UNRESOLVED_STATES, "closed", { lastError: "" }, { dropData: true });
}

/**
 * 復元前のバックアップ: 今のデータの完全なバックアップを作り、作ったファイルを読み直して確かめる
 * （全ストアの件数・添付ファイルの件数と指紋が、今の保存データと一致すること）。保存（ダウンロード・共有）は画面側が行う。
 * @returns {Promise<{blob: Blob, filename: string, check: {stores: number, records: number, attachments: number}}>}
 */
export async function createVerifiedBackup() {
  const { blob, filename } = await exportFullBackup();
  const re = await analyzeBackupFile(new File([blob], filename));
  const problems = [...re.errors.map((e) => `${e.store}:${e.id} ${e.reason}`)];
  let records = 0; let attachments = 0;
  const exportedAt = re.manifest?.exportedAt || "";
  for (const storeName of DATA_STORES) {
    // バックアップを作ったときに変更履歴へ足す1件（「フルバックアップを作成」）は、バックアップの中には入らないので比べない
    const local = (await dbGetAll(storeName)).filter((r) => !(storeName === "auditLog" && r.entityType === "backup" && (r.at || r.createdAt || "") >= exportedAt));
    const inZip = re.items.filter((it) => it.store === storeName);
    records += inZip.length;
    if (local.length !== inZip.length) problems.push(`${STORE_LABELS[storeName] || storeName} の件数が違います（保存データ ${local.length}件・バックアップ ${inZip.length}件）`);
    const byId = new Map(inZip.map((it) => [it.id, it]));
    for (const rec of local) {
      for (const { field } of BLOB_FIELDS[storeName] || []) {
        if (!(rec[field] instanceof Blob)) continue;
        attachments++;
        const sha = byId.get(rec.id)?.blobSha?.[field];
        if (!sha || sha !== (await sha256OfBlob(rec[field]))) problems.push(`${STORE_LABELS[storeName] || storeName}:${rec.id} の添付ファイルがバックアップと一致しません`);
      }
    }
  }
  if (attachments !== re.attachments) problems.push(`添付ファイルの件数が違います（保存データ ${attachments}件・バックアップ ${re.attachments}件）`);
  if (problems.length) throw new Error(`復元前のバックアップを確かめられませんでした（${problems.slice(0, 5).join("／")}）。復元は開始しません`);
  return { blob, filename, check: { stores: DATA_STORES.length, records, attachments } };
}

/* ==========================================================
   保存先フォルダの記憶（File System Access API）
   同じWi-Fi/LAN上の共有フォルダをOSレベルでドライブ割り当て／
   接続しておけば、ここで一度選択したフォルダにバックアップを
   直接書き出し、そこから最新のバックアップを直接読み込める。
   Chrome/Edge等の対応ブラウザのみで使える機能で、非対応ブラウザ
   （Safari等）では呼び出し元でフォールバック（従来のダウンロード／
   ファイル選択）に切り替えること。
   ========================================================== */

const EXPORT_DIR_HANDLE_KEY = "backupExportDirHandle";

export function isFolderHandleSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function getSavedExportDirHandle() {
  const entry = await dbGet("meta", EXPORT_DIR_HANDLE_KEY);
  return entry ? entry.handle : null;
}

export async function chooseAndSaveExportDirHandle() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await dbPut("meta", { key: EXPORT_DIR_HANDLE_KEY, handle });
  return handle;
}

export async function clearExportDirHandle() {
  await dbDelete("meta", EXPORT_DIR_HANDLE_KEY);
}

export async function verifyDirHandlePermission(handle, mode = "readwrite") {
  if ((await handle.queryPermission({ mode })) === "granted") return true;
  if ((await handle.requestPermission({ mode })) === "granted") return true;
  return false;
}

export async function writeBackupToDirHandle(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * 記憶したフォルダの中から、ファイル名（backup_ISO日時.zip）が
 * 最も新しいバックアップZIPを探す。見つからなければnull。
 */
export async function findLatestBackupInDirHandle(dirHandle) {
  let latestName = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && /^backup_.*\.zip$/i.test(name)) {
      if (!latestName || name > latestName) latestName = name;
    }
  }
  if (!latestName) return null;
  const fileHandle = await dirHandle.getFileHandle(latestName);
  const file = await fileHandle.getFile();
  return { file, filename: latestName };
}
