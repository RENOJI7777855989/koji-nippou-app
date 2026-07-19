/* ==========================================================
   IndexedDB接続・スキーマ定義・汎用CRUDヘルパー
   写真・署名画像はBlobを扱うためlocalStorageでは容量不足となり、
   IndexedDBへ全面移行した。以降、日報系データはすべてここを経由する。
   ========================================================== */

const DB_NAME = "constructionReportsDB";
const DB_VERSION = 3;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("sites")) {
        const store = db.createObjectStore("sites", { keyPath: "id" });
        store.createIndex("by_status", "status");
        store.createIndex("by_updatedAt", "updatedAt");
        store.createIndex("by_name", "name");
      }

      if (!db.objectStoreNames.contains("reports")) {
        const store = db.createObjectStore("reports", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_date", "date");
        store.createIndex("by_siteId_date", ["siteId", "date"]);
        store.createIndex("by_updatedAt", "updatedAt");
      }

      if (!db.objectStoreNames.contains("photos")) {
        const store = db.createObjectStore("photos", { keyPath: "id" });
        store.createIndex("by_reportId", "reportId");
      }

      if (!db.objectStoreNames.contains("signatures")) {
        const store = db.createObjectStore("signatures", { keyPath: "id" });
        store.createIndex("by_reportId", "reportId");
      }

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }

      // 帳票出力機能の基盤（提出先会社プロファイル・帳票テンプレート定義）。
      // 日報・現場データとは独立したストアとし、既存ストアには影響しない。
      if (!db.objectStoreNames.contains("companyProfiles")) {
        const store = db.createObjectStore("companyProfiles", { keyPath: "id" });
        store.createIndex("by_name", "name");
      }

      if (!db.objectStoreNames.contains("reportTemplates")) {
        const store = db.createObjectStore("reportTemplates", { keyPath: "id" });
        store.createIndex("by_companyProfileId", "companyProfileId");
        store.createIndex("by_format", "format");
      }

      // ユーザー管理・権限（ローカル完結。実サーバーが無いため真の
      // アクセス制御ではなくUI上の制限であることに注意。詳細はauth.js参照）。
      if (!db.objectStoreNames.contains("users")) {
        const store = db.createObjectStore("users", { keyPath: "id" });
        store.createIndex("by_username", "username");
      }

      // 変更履歴（誰が・いつ・何を変更したか）
      if (!db.objectStoreNames.contains("auditLog")) {
        const store = db.createObjectStore("auditLog", { keyPath: "id" });
        store.createIndex("by_entityType", "entityType");
        store.createIndex("by_entityType_entityId", ["entityType", "entityId"]);
        store.createIndex("by_at", "at");
      }

      // バックアップ実行履歴
      if (!db.objectStoreNames.contains("backupHistory")) {
        const store = db.createObjectStore("backupHistory", { keyPath: "id" });
        store.createIndex("by_createdAt", "createdAt");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

export async function dbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAll(storeName, indexName, query) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    const req = query !== undefined ? source.getAll(query) : source.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDelete(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
