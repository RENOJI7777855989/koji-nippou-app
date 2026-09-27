/* ==========================================================
   業者見積の追跡情報（段階1・純粋関数、DB・DOM非依存）
   業者見積の明細に「元ファイルのどこから来たか」「元の文字列は何か」
   「再取込で同じ明細か」「一式の可能性があるか」を持たせるための部品。
   ・originalText … 正規化・数値化する前の原文（セルの文字列）。正規化した値
     （quantity/unitPrice/amount/itemName等）とは別に持ち、混ぜない。
   ・lineKey … 見積内の安定した明細キー。提出内訳取込の assignLineKeys を再利用する
     （階層・正規化名称・正規化摘要＋同一内容の出現順。数量・金額は含まないので、
     金額が変わっても同じ明細として追跡でき、diffで「変更」と分かる）。
   ・isLumpSum … 「一式である可能性」の目印であって確定ではない。数量×単価などの
     計算はここでは一切行わない（金額は原文値のまま）。
   ========================================================== */

import { assignLineKeys, diffImportLines } from "../submission-import/importDiff.js";
import { normalizeItemText } from "./itemNormalize.js";

export const LUMP_SUM_LABEL = "一式計上・要確認";

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const LUMP_WORDS = ["一式", "一括"]; // 「一式計上」は「一式」を含む

/**
 * 一式の可能性の判定（自動確定ではなく目印）。
 * @returns {{ isLumpSum: boolean, reasons: string[] }} reasonsは判定根拠（画面表示用）
 */
export function detectLumpSum({ itemName = "", spec = "", unit = "", quantityText = "" } = {}) {
  const reasons = [];
  // 単位が「式」のほか、「1式」「一式」「一括」のように数量と一体で書かれる形も目印にする
  const u = normalizeItemText(unit);
  if (u === "式") reasons.push("単位が「式」");
  else if (u && (/^[0-9]*式$/.test(u) || u.includes("一式") || u.includes("一括"))) reasons.push(`単位が「${String(unit).trim()}」`);
  // 業者によっては数量欄に「一式」「1式」と書く（数値として読めないため数量は空になる）。原文の数量欄も見る
  const q = normalizeItemText(quantityText);
  if (q && (/^[0-9]*式$/.test(q) || q.includes("一式") || q.includes("一括"))) reasons.push(`数量欄が「${String(quantityText).trim()}」`);
  for (const word of LUMP_WORDS) {
    if (String(itemName).includes(word)) reasons.push(`名称に「${word}」`);
    if (String(spec).includes(word)) reasons.push(`摘要に「${word}」`);
  }
  return { isLumpSum: reasons.length > 0, reasons };
}

function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of String(letters || "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1始まり。空なら0
}

/**
 * 列マッピング（項目→列文字）と、その行の全セル文字列（rawRowCells。1列目から順）から、
 * 正規化前の原文を取り出す。マッピングされていない項目は null（「元ファイルに無い」と
 * 「空欄だった」を区別する）。空欄だった項目は空文字列。
 * @returns {{category, itemName, spec, quantity, unit, unitPrice, amount}|null}
 */
export function buildOriginalText(rawRowCells, columnMapping) {
  if (!Array.isArray(rawRowCells) || !columnMapping) return null;
  const pick = (key) => {
    const idx = colLettersToIndex(columnMapping[key]);
    if (idx < 1) return null;
    return rawRowCells[idx - 1] ?? "";
  };
  return {
    category: pick("category"),
    itemName: pick("itemName"),
    spec: pick("spec"),
    quantity: pick("quantity"),
    unit: pick("unit"),
    unitPrice: pick("unitPrice"),
    amount: pick("amount")
  };
}

/** 「12ページ」形式のシート名から頁番号を取り出す（PDFのみ）。取れなければnull */
export function parsePageNumber(sheetName) {
  const m = /^(\d+)ページ$/.exec(String(sheetName ?? "").trim());
  return m ? Number(m[1]) : null;
}

const toLineShape = (item) => ({
  groupName: "",
  workType: item.category || "",
  subType: "",
  name: item.itemName || "",
  spec: item.spec || "",
  quantity: item.quantity ?? null,
  unit: item.unit || "",
  unitPrice: item.unitPrice ?? null,
  amount: item.amount ?? null,
  note: ""
});

/** 見積明細（category/itemName/spec/数量…を持つ配列）に、見積内で安定した lineKey を付ける。配列と同じ順序のキー配列を返す */
export function buildVendorLineKeys(items) {
  return assignLineKeys(items.map(toLineShape)).map((l) => l.lineKey);
}

/**
 * 前回と今回の見積明細（lineKey付き）の差分。追加・削除・変更（数量・単位・単価・金額・名称等が変わった行）・変更なし。
 */
export function diffVendorQuoteLines(prevItems, nextItems) {
  const shaped = (items) => items.map((i) => ({ ...toLineShape(i), lineKey: i.lineKey, _item: i }));
  const diff = diffImportLines(shaped(prevItems), shaped(nextItems));
  return {
    added: diff.added.map((l) => l._item),
    removed: diff.removed.map((l) => l._item),
    changed: diff.changed.map((c) => ({ prev: c.prev._item, next: c.next._item })),
    unchanged: diff.unchanged,
    identical: diff.identical
  };
}
