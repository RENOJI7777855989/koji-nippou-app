/* ==========================================================
   共通積算項目マスター（データ層）
   全現場・全業者見積で共有するグローバルな項目辞書。一度「この
   表記とこの表記は同じ項目」と確定させると、別の現場・別の業者
   見積でも自動的に同じ判断が適用されるようにするための唯一の
   共有ストア（siteIdを持たない）。
   数量・単価・金額は持たせない（それらは取引・現場ごとに変わる
   事実であり、マスターに保存すると古い値が紛れ込むリスクが
   あるため。既存の「根拠のない金額を作らない」方針と一致させる）。
   項目コードは公共工事等の正式なコード体系には準拠せず、
   このアプリ内で一意な識別のためだけの連番（M-0001形式）を
   自動採番する。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";
import { normalizeItemText } from "./itemNormalize.js";

export async function listMasterItems() {
  const all = await dbGetAll("masterItems");
  return all.filter((m) => !m.isDeleted).sort((a, b) => (a.itemCode || "").localeCompare(b.itemCode || ""));
}

export async function getMasterItem(id) {
  return dbGet("masterItems", id);
}

async function nextItemCode() {
  // 論理削除された項目もitemCodeの一意制約(IndexedDBのunique index)を
  // 引き続き占有しているため、削除済みを除外せず全件から最大値を求める
  // （削除後に番号を再利用すると一意制約違反で保存に失敗するため）。
  const all = await dbGetAll("masterItems");
  let max = 0;
  for (const m of all) {
    const match = /^M-(\d+)$/.exec(m.itemCode || "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `M-${String(max + 1).padStart(4, "0")}`;
}

/**
 * 新しいマスター項目を作成する。standardNameはそのまま最初の別名としても
 * 登録し、以後の完全一致照合（normalizeItemText経由）に使えるようにする。
 */
export async function createMasterItem({ category = "", standardName, unit = "", memo = "" }) {
  if (!standardName || !standardName.trim()) throw new Error("標準項目名を入力してください");
  const itemCode = await nextItemCode();
  const item = stampNew({
    itemCode,
    category,
    standardName: standardName.trim(),
    aliases: [standardName.trim()],
    unit,
    memo
  });
  await dbPut("masterItems", item);
  return item;
}

/** 別名を追加する（正規化して既存と重複するものは追加しない） */
export async function addAliasToMasterItem(id, alias) {
  const trimmed = (alias || "").trim();
  if (!trimmed) return getMasterItem(id);
  const existing = await getMasterItem(id);
  if (!existing) throw new Error("マスター項目が見つかりません");
  const normalized = normalizeItemText(trimmed);
  const already = (existing.aliases || []).some((a) => normalizeItemText(a) === normalized);
  if (already) return existing;
  const updated = stampUpdate(existing, { aliases: [...(existing.aliases || []), trimmed] });
  await dbPut("masterItems", updated);
  return updated;
}

export async function renameMasterItem(id, patch) {
  const existing = await getMasterItem(id);
  if (!existing) throw new Error("マスター項目が見つかりません");
  const updated = stampUpdate(existing, patch);
  await dbPut("masterItems", updated);
  return updated;
}

export async function deleteMasterItem(id) {
  const existing = await getMasterItem(id);
  if (!existing) throw new Error("マスター項目が見つかりません");
  const updated = stampUpdate(existing, { isDeleted: true });
  await dbPut("masterItems", updated);
  return updated;
}

/**
 * 重複登録してしまった項目を統合する。fromの別名をintoへ移し替えたうえで
 * fromを削除する。itemCodeはintoのものが残る（fromのコードは失われる）。
 */
export async function mergeMasterItems(intoId, fromId) {
  if (intoId === fromId) return getMasterItem(intoId);
  const into = await getMasterItem(intoId);
  const from = await getMasterItem(fromId);
  if (!into || !from) throw new Error("マスター項目が見つかりません");

  const mergedAliases = [...(into.aliases || [])];
  for (const alias of from.aliases || []) {
    const normalized = normalizeItemText(alias);
    if (!mergedAliases.some((a) => normalizeItemText(a) === normalized)) mergedAliases.push(alias);
  }
  const updated = stampUpdate(into, { aliases: mergedAliases });
  await dbPut("masterItems", updated);
  await deleteMasterItem(fromId);
  return updated;
}
