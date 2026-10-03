/* ==========================================================
   IndexedDB接続・スキーマ定義・汎用CRUDヘルパー
   写真・署名画像はBlobを扱うためlocalStorageでは容量不足となり、
   IndexedDBへ全面移行した。以降、日報系データはすべてここを経由する。
   ========================================================== */

const DB_NAME = "constructionReportsDB";
const DB_VERSION = 10;

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

      // 積算モジュール（現場管理OS拡張 Phase1）。sites/reports等の既存ストアとは
      // 独立し、siteIdのみで紐付ける。1回の取込＝1バッチとしてestimateBatchesに
      // 記録し、再取込しても過去データを消さず履歴として残す。
      if (!db.objectStoreNames.contains("estimateBatches")) {
        const store = db.createObjectStore("estimateBatches", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
      }

      if (!db.objectStoreNames.contains("estimateItems")) {
        const store = db.createObjectStore("estimateItems", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_estimateBatchId", "estimateBatchId");
        store.createIndex("by_siteId_category", ["siteId", "category"]);
      }

      // 業者見積・積算比較機能。estimateBatches/estimateItemsと同じ考え方で
      // siteIdのみで紐付ける独立ストア。既存の積算ストアには一切変更を加えない。
      if (!db.objectStoreNames.contains("vendorQuoteBatches")) {
        const store = db.createObjectStore("vendorQuoteBatches", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
      }

      if (!db.objectStoreNames.contains("vendorQuoteItems")) {
        const store = db.createObjectStore("vendorQuoteItems", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_vendorQuoteBatchId", "vendorQuoteBatchId");
      }

      // ユーザーが比較画面で確定させた「同一項目／別項目」の対応関係。
      // レコードIDではなく正規化した項目名文字列をキーにするため、
      // 再取込後の新しいバッチにも自動適用できる。
      if (!db.objectStoreNames.contains("itemMatchOverrides")) {
        const store = db.createObjectStore("itemMatchOverrides", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_siteId_estimateItemKey", ["siteId", "estimateItemKey"]);
      }

      // 見積落とし発見エンジン。見積落とし候補・逆方向チェック候補に対する
      // ユーザーの最終判断（見積落とし／別項目に含む／一式に含む／対象外／問題なし等）を
      // 正規化キー（itemNormalize.jsのbuildItemKey）で保存し、再取込後も引き継ぐ。
      if (!db.objectStoreNames.contains("omissionDispositions")) {
        const store = db.createObjectStore("omissionDispositions", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_siteId_vendorQuoteBatchId", ["siteId", "vendorQuoteBatchId"]);
      }

      // 共通積算項目マスター。全現場・全業者見積で共有するグローバルな
      // 項目辞書（表記ゆれの別名一覧）。site/vendorQuoteとは独立し、
      // どの現場にも紐付かない（siteIdを持たない）唯一のストア。
      if (!db.objectStoreNames.contains("masterItems")) {
        const store = db.createObjectStore("masterItems", { keyPath: "id" });
        store.createIndex("by_itemCode", "itemCode", { unique: true });
        store.createIndex("by_category", "category");
      }

      // 提出金額内訳書の出力専用データ。積算項目(estimateItems)には手を加えず、
      // 「どの区分グループ・工種・種別に出力するか」の割当と、現場ごとの出力設定
      // （区分グループ一覧・工事名・使用テンプレート等）だけを別ストアに持つ。
      if (!db.objectStoreNames.contains("submissionPlans")) {
        const store = db.createObjectStore("submissionPlans", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
      }

      if (!db.objectStoreNames.contains("submissionAssignments")) {
        const store = db.createObjectStore("submissionAssignments", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
        store.createIndex("by_estimateItemId", "estimateItemId");
      }

      // 提出金額内訳書Excelの取込結果（解析した明細・照合結果・人間の確認結果）。
      // 取込1回=1レコード。既存ストアには影響しない。
      if (!db.objectStoreNames.contains("submissionImports")) {
        const store = db.createObjectStore("submissionImports", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
      }

      // DB v10: 危険予知活動表（KY活動表）の提出状況（現場×日付×業者名）。日報とは独立した提出物。
      // 新しいストアを足すだけで、既存ストア・既存データには触れない（js/ky/kySubmissions.js）。
      if (!db.objectStoreNames.contains("kySubmissions")) {
        const store = db.createObjectStore("kySubmissions", { keyPath: "id" });
        store.createIndex("by_siteId", "siteId");
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

/**
 * 保存に失敗したときのエラーを、原因の分かるErrorにする。WebKit（Safari）では失敗時に
 * トランザクションのエラーが空（null）で、原因はリクエスト側にだけ入っていることがある。
 * プライベートブラウズ等でファイル・画像（Blob）を保存できない場合は、利用者向けの説明にする。
 */
function storageError(err, storeName) {
  const message = err?.message || "";
  if (/Blob\/File/i.test(message)) {
    return new Error("このブラウザの状態ではファイル・画像のデータを保存できません（Safariのプライベートブラウズでは保存できません）。通常のSafari、またはホーム画面に追加したアプリで開いてください。");
  }
  if (err instanceof Error) return err;
  return new Error(`データを保存できませんでした（${storeName}）${message ? "：" + message : ""}`);
}

export async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(value);
    const fail = () => reject(storageError(req.error || tx.error, storeName));
    tx.oncomplete = () => resolve(value);
    tx.onerror = fail;
    tx.onabort = fail;
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
