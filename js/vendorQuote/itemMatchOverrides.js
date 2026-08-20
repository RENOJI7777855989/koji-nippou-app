/* ==========================================================
   ユーザー確定済み項目対応関係のデータ層
   比較画面で「同一項目」「別項目」と確定した組み合わせを保存する。
   レコードIDではなく正規化した項目名文字列（itemNormalize.js）を
   キーにすることで、業者見積を再取込しても（新しいバッチIDに
   なっても）確定済みの判断を自動的に適用できる。
   ========================================================== */

import { dbGetAll, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";

export async function listItemMatchOverridesBySite(siteId) {
  const all = await dbGetAll("itemMatchOverrides", "by_siteId", siteId);
  return all.filter((o) => !o.isDeleted);
}

/**
 * 同一(siteId, estimateItemKey, vendorItemKey)の組み合わせが既にあれば
 * 更新し、なければ新規作成する（同じペアを何度確定しても重複しない）。
 */
export async function setItemMatchOverride({ siteId, estimateItemKey, vendorItemKey, decision }) {
  const existing = (await listItemMatchOverridesBySite(siteId)).find(
    (o) => o.estimateItemKey === estimateItemKey && o.vendorItemKey === vendorItemKey
  );
  if (existing) {
    const updated = stampUpdate(existing, { decision });
    await dbPut("itemMatchOverrides", updated);
    return updated;
  }
  const created = stampNew({ siteId, estimateItemKey, vendorItemKey, decision });
  await dbPut("itemMatchOverrides", created);
  return created;
}
