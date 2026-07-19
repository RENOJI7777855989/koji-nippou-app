/* ==========================================================
   旧localStorage（キー: dailyReports）からIndexedDBへのデータ移行
   - 初回起動時に1回だけ実行する
   - 旧日報は「siteName」でグルーピングし、現場という概念が
     無かった過去データを現場単位へ自動変換する
   - 移行元データは削除せず、別キーへ退避して残す
   ========================================================== */

import { dbGet, dbPut } from "./db.js";
import { stampNew } from "./utils.js";

const OLD_STORAGE_KEY = "dailyReports";
const BACKUP_KEY = "dailyReports_migrated_backup";

export async function runMigration() {
  const meta = await dbGet("meta", "migrationDone");
  if (meta && meta.value) return;

  try {
    let oldReports = [];
    try {
      const raw = localStorage.getItem(OLD_STORAGE_KEY);
      oldReports = raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("旧データの読み込みに失敗しました", err);
      oldReports = [];
    }

    if (oldReports.length > 0) {
      const groups = new Map();
      oldReports.forEach((r) => {
        const key = (r.siteName || "").trim() || "（現場名未設定）";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });

      for (const [siteName, reports] of groups) {
        const site = stampNew({
          name: siteName,
          address: "",
          clientName: "",
          startDate: "",
          endDate: "",
          memo: "localStorageから自動移行された現場です。",
          status: "active"
        });
        await dbPut("sites", site);

        for (const r of reports) {
          const report = stampNew({
            id: r.id, // 旧IDを引き継ぎ、再実行時の重複登録を防ぐ
            siteId: site.id,
            date: r.date || "",
            weather: r.weather || "晴れ",
            temperature: "",
            workerCountTotal: "",
            companies: (r.companies || []).map((c) => ({
              companyName: c.companyName || "",
              workerCount: c.workerCount || "",
              machinery: "",
              workContent: c.workContent || "",
              safetyNotes: c.safetyNotes || ""
            })),
            remarks: "",
            tomorrowPlan: r.tomorrowPlan || "",
            photoIds: [],
            signatureIds: []
          });
          if (r.savedAt) report.createdAt = r.savedAt;
          await dbPut("reports", report);
        }
      }

      localStorage.setItem(BACKUP_KEY, localStorage.getItem(OLD_STORAGE_KEY));
      localStorage.removeItem(OLD_STORAGE_KEY);
    }

    await dbPut("meta", { key: "migrationDone", value: true, migratedAt: new Date().toISOString() });
  } catch (err) {
    // 失敗時はmigrationDoneを立てず、次回起動時に再試行する
    console.error("データ移行に失敗しました", err);
  }
}
