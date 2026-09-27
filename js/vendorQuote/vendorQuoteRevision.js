/* ==========================================================
   業者見積の版管理（前の版からの確認結果の引き継ぎ）
   内容が変わった見積（別SHA-256）を新しい取込として保存したとき、前の版で人間が
   行った確認結果のうち、「変更のない行」に関するものだけを新しい取込へ引き継ぐ。
   変更された行・追加された行・削除された行は引き継がず、再確認の対象にする。
   引き継ぐのは見積落とし確認（omissionDispositions）:
     ・業者見積側の判断（追加工事・別途工事・対象外 等）… その業者見積行が変更なしの場合
     ・積算側の判断で、含まれ先の業者見積行（linkedItemKey）が変更なしの場合
       （含まれ先を持たない積算側の判断は、見積の内容が変わっているため引き継がない）
   itemMatchOverrides は現場単位の名称キー方式なので、版が変わっても自動で効く（ここでは扱わない）。
   ========================================================== */

import { dbPut } from "../db.js";
import { stampNew } from "../utils.js";
import { listVendorQuoteItemsByBatch } from "./vendorQuoteItems.js";
import { listOmissionDispositionsByBatch } from "./omissionDispositions.js";
import { buildVendorLineKeys, diffVendorQuoteLines } from "./vendorQuoteTrace.js";
import { buildItemKey } from "./itemNormalize.js";

/** lineKeyを持たない従来データにも、その場でlineKeyを付けて比較できるようにする（保存はしない） */
function withLineKeys(items) {
  if (items.every((i) => i.lineKey)) return items;
  const keys = buildVendorLineKeys(items);
  return items.map((i, n) => ({ ...i, lineKey: i.lineKey || keys[n] }));
}

/**
 * @returns {Promise<{ diff: {added:number, removed:number, changed:number, unchanged:number}, carried: number, notCarried: number }>}
 */
export async function carryOverConfirmations({ siteId, fromBatchId, toBatchId }) {
  const prevItems = withLineKeys(await listVendorQuoteItemsByBatch(fromBatchId));
  const nextItems = withLineKeys(await listVendorQuoteItemsByBatch(toBatchId));
  const diff = diffVendorQuoteLines(prevItems, nextItems);
  const changedKeys = new Set([...diff.changed.map((c) => c.prev.lineKey), ...diff.removed.map((i) => i.lineKey)]);
  const unchangedVendorKeys = new Set(
    prevItems.filter((i) => !changedKeys.has(i.lineKey) && nextItems.some((n) => n.lineKey === i.lineKey)).map((i) => buildItemKey(i))
  );

  const prevDispositions = await listOmissionDispositionsByBatch(siteId, fromBatchId);
  const existingNew = await listOmissionDispositionsByBatch(siteId, toBatchId);
  const already = new Set(existingNew.map((d) => `${d.side}|${d.itemKey}`));
  let carried = 0;
  for (const d of prevDispositions) {
    const carry = d.side === "vendor" ? unchangedVendorKeys.has(d.itemKey) : !!d.linkedItemKey && unchangedVendorKeys.has(d.linkedItemKey);
    if (!carry || already.has(`${d.side}|${d.itemKey}`)) continue;
    await dbPut(
      "omissionDispositions",
      stampNew({ siteId, vendorQuoteBatchId: toBatchId, side: d.side, itemKey: d.itemKey, disposition: d.disposition, linkedItemKey: d.linkedItemKey ?? null, note: d.note || "", carriedFromBatchId: fromBatchId })
    );
    carried++;
  }
  return {
    diff: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, unchanged: diff.unchanged },
    carried,
    notCarried: prevDispositions.length - carried
  };
}
