/* ==========================================================
   再取込の差分（純粋関数）
   行ごとの安定キー（階層＋正規化した名称・摘要＋同一内容の出現順）で前回と
   今回の取込明細を突き合わせ、追加・削除・変更・変更なしに分ける。
   数値（数量・単位・単価・金額）や備考が変わった行は「変更」とし、前回の
   確認結果を引き継がず、もう一度確認してもらう。
   ========================================================== */

import { normalizeItemText } from "../vendorQuote/itemNormalize.js";

/** 明細ごとの安定キー。同じ内容の行が複数あれば出現順の番号を付ける。 */
export function assignLineKeys(lines) {
  const seen = new Map();
  return lines.map((line) => {
    const base = [line.groupName, line.workType, line.subType, normalizeItemText(line.name), normalizeItemText(line.spec)].map(normalizeItemText).join("|");
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...line, lineKey: `${base}#${n}` };
  });
}

// セル内改行の表記（CRLF／LF）はExcelの保存し直しで変わり得るため、内容の違いとは扱わない
const lf = (t) => String(t ?? "").replace(/\r\n/g, "\n");
const contentSignature = (l) => JSON.stringify([l.quantity, l.unit, l.unitPrice, l.amount, lf(l.note), lf(l.name), lf(l.spec), l.groupSymbol, l.workTypeSymbol, l.subTypeSymbol]);

/**
 * @param {object[]} prevLines 前回取込の明細（lineKey付き）
 * @param {object[]} nextLines 今回の明細（lineKey付き）
 * @returns {{ added: object[], removed: object[], changed: {prev, next}[], unchanged: number, identical: boolean }}
 */
export function diffImportLines(prevLines, nextLines) {
  const prevByKey = new Map(prevLines.map((l) => [l.lineKey, l]));
  const nextByKey = new Map(nextLines.map((l) => [l.lineKey, l]));
  const added = nextLines.filter((l) => !prevByKey.has(l.lineKey));
  const removed = prevLines.filter((l) => !nextByKey.has(l.lineKey));
  const changed = [];
  let unchanged = 0;
  for (const next of nextLines) {
    const prev = prevByKey.get(next.lineKey);
    if (!prev) continue;
    if (contentSignature(prev) === contentSignature(next)) unchanged++;
    else changed.push({ prev, next });
  }
  return { added, removed, changed, unchanged, identical: added.length === 0 && removed.length === 0 && changed.length === 0 };
}
