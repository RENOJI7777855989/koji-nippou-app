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

import { dbGetAll, dbGet, dbPut, dbDelete } from "./db.js";
import { loadZip, readZipEntryBytes, readZipEntryText, buildZip } from "./zipUtil.js";
import { stampNew } from "./utils.js";
import { recordChange } from "./auditLog.js";

const DATA_STORES = [
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
  "itemMatchOverrides"
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
  itemMatchOverrides: "項目対応関係"
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
  vendorQuoteItems: "itemName"
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
          modifications.set(fileName, new Uint8Array(await blob.arrayBuffer()));
          clone[field] = null;
          clone[`${field}File`] = fileName;
          clone[`${field}MimeTypeBackup`] = (mimeField && record[mimeField]) || blob.type || "";
        }
      }
      serializable.push(clone);
    }
    modifications.set(`data/${storeName}.json`, new TextEncoder().encode(JSON.stringify(serializable)));
  }

  const manifest = { exportedAt, recordCounts };
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

/**
 * バックアップZIPを解析し、復元すると既存データより古い内容で
 * 上書きされてしまうレコード（＝競合）を検出する。実際の復元は行わない。
 * 競合判定は各レコードのupdatedAt比較のみで、内容の差分までは見ない。
 */
export async function analyzeBackupRestore(file) {
  const zip = loadZip(await file.arrayBuffer());
  const manifestText = await readZipEntryText(zip, "manifest.json");
  if (!manifestText) throw new Error("バックアップファイルの形式が不正です（manifest.jsonが見つかりません）");

  const conflicts = [];
  for (const storeName of DATA_STORES) {
    const dataText = await readZipEntryText(zip, `data/${storeName}.json`);
    if (!dataText) continue;
    const records = JSON.parse(dataText);

    for (const record of records) {
      if (!record.updatedAt) continue;
      const existing = await dbGet(storeName, record.id);
      if (!existing || !existing.updatedAt) continue;
      if (existing.updatedAt > record.updatedAt) {
        conflicts.push({
          store: storeName,
          storeLabel: STORE_LABELS[storeName] || storeName,
          id: record.id,
          label: record[RECORD_LABEL_FIELDS[storeName]] || record.id,
          localUpdatedAt: existing.updatedAt,
          incomingUpdatedAt: record.updatedAt
        });
      }
    }
  }
  return { manifest: JSON.parse(manifestText), conflicts };
}

/**
 * バックアップZIPから全ストアを復元する。既存レコードとID一致するものは
 * 上書きされる（アップサート）。バックアップに含まれないレコードは
 * 削除されない＝完全な置き換えではなく「合成」であることに注意。
 * skipKeys（"ストア名:id"の集合）に含まれるレコードは復元をスキップし、
 * ローカルの内容を残す（analyzeBackupRestoreで検出した競合の解決に使う）。
 */
export async function restoreFromBackup(file, { skipKeys } = {}) {
  const skip = skipKeys instanceof Set ? skipKeys : new Set(skipKeys || []);
  const zip = loadZip(await file.arrayBuffer());
  const manifestText = await readZipEntryText(zip, "manifest.json");
  if (!manifestText) throw new Error("バックアップファイルの形式が不正です（manifest.jsonが見つかりません）");

  const restoredCounts = {};
  for (const storeName of DATA_STORES) {
    const dataText = await readZipEntryText(zip, `data/${storeName}.json`);
    if (!dataText) continue;
    const records = JSON.parse(dataText);
    const blobDefs = BLOB_FIELDS[storeName] || [];

    let appliedCount = 0;
    for (const record of records) {
      if (skip.has(`${storeName}:${record.id}`)) continue;
      for (const { field } of blobDefs) {
        const fileKey = `${field}File`;
        if (record[fileKey]) {
          const bytes = await readZipEntryBytes(zip, record[fileKey]);
          const mimeType = record[`${field}MimeTypeBackup`] || "";
          record[field] = bytes ? new Blob([bytes], { type: mimeType }) : null;
          delete record[fileKey];
          delete record[`${field}MimeTypeBackup`];
        }
      }
      await dbPut(storeName, record);
      appliedCount++;
    }
    restoredCounts[storeName] = appliedCount;
  }

  await recordChange({
    entityType: "backup",
    entityId: "restore",
    action: "update",
    summary: `バックアップから復元（${Object.entries(restoredCounts).map(([k, v]) => `${k}:${v}件`).join("、")}）`
  });
  return restoredCounts;
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
