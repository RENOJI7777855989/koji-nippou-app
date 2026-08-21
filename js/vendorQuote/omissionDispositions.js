/* ==========================================================
   見積落とし候補・逆方向チェック候補への、ユーザー最終判断のデータ層
   itemMatchOverrides.jsと同じ考え方（レコードIDではなく正規化キーで
   保存する）だが、対応するvendor項目が無いケースや判断の種類が
   複数ある(見積落とし/別項目に含む/一式に含む/対象外/問題なし、
   逆方向は追加工事/別途工事/積算対象外/二重計上の可能性/問題なし)
   ため、itemMatchOverridesとは別ストアとして持つ。
   ========================================================== */

import { dbGetAll, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";

export async function listOmissionDispositionsBySite(siteId) {
  const all = await dbGetAll("omissionDispositions", "by_siteId", siteId);
  return all.filter((d) => !d.isDeleted);
}

export async function listOmissionDispositionsByBatch(siteId, vendorQuoteBatchId) {
  const all = await dbGetAll("omissionDispositions", "by_siteId_vendorQuoteBatchId", [siteId, vendorQuoteBatchId]);
  return all.filter((d) => !d.isDeleted);
}

/**
 * 同一(siteId, vendorQuoteBatchId, side, itemKey)の判断が既にあれば更新し、
 * なければ新規作成する。
 */
export async function setOmissionDisposition({ siteId, vendorQuoteBatchId, side, itemKey, disposition, linkedItemKey = null, note = "" }) {
  const existing = (await listOmissionDispositionsByBatch(siteId, vendorQuoteBatchId)).find(
    (d) => d.side === side && d.itemKey === itemKey
  );
  if (existing) {
    const updated = stampUpdate(existing, { disposition, linkedItemKey, note });
    await dbPut("omissionDispositions", updated);
    return updated;
  }
  const created = stampNew({ siteId, vendorQuoteBatchId, side, itemKey, disposition, linkedItemKey, note });
  await dbPut("omissionDispositions", created);
  return created;
}
