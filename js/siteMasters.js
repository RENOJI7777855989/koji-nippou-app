/* ==========================================================
   現場ごとの棟・工種の一覧（2026-11-01）
   現場のレコードに任意の項目を足すだけ（DBの構造・版は v10 のまま。以前の現場には無くてよい）:
     site.buildings = [{ id, name, active, order, createdAt, updatedAt }]
     site.trades    = [{ id, name, active, order, createdAt, updatedAt }]
   ・同じ現場で同じ名前（表記ゆれをそろえて比べる）は二重に登録しない。棟は全角半角・空白・大文字小文字をそろえる
     （buildingKey）。工種は 03-2 の稼動人数表と同じそろえ方（normalizeTrade。末尾の「工事」「工」など・とび＝鳶）。
   ・使った項目を消すと過去の日報が壊れるので、物理削除はせず「使用停止」（active: false）にする。
   ・日報の業者の行には、棟の id と保存した時点の棟の名前（buildingName）を持たせるので、ここで名前を変えても
     過去の日報の表示・帳票は変わらない。工種は従来どおり名前（occupation）を保存し、一覧の id（tradeId）は参考に持つ。
   ・工事完了の現場は変更できない。その現場のデータだけを変える。
   ========================================================== */

import { getSite, updateSite } from "./sites.js";
import { createId } from "./utils.js";
import { normalizeTrade } from "./report-output/tradeAttendance.js";

export const MASTER_COMPLETED_MESSAGE = "工事完了の現場は、棟・工種の一覧を変更できません（工事完了を解除すると変更できます）。";

/** 棟の名前の比べ方（全角半角・空白・大文字小文字をそろえる）。「Ａ棟」「A 棟」「a棟」は同じ棟 */
export function buildingKey(name) {
  return String(name || "").normalize("NFKC").replace(/[\s　]+/g, "").toUpperCase();
}

/** 工種の名前の比べ方（03-2 の稼動人数表と同じ）。「塗装」「塗装工事」は同じ工種 */
export const tradeKey = (name) => normalizeTrade(name);

const KINDS = {
  buildings: { key: buildingKey, label: "棟" },
  trades: { key: tradeKey, label: "工種" }
};

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`知らない一覧です: ${kind}`);
  return k;
}

/** 一覧（並び順）。includeInactive: 使用停止も含める */
export function listMaster(site, kind, { includeInactive = false } = {}) {
  kindOf(kind);
  return [...(site?.[kind] || [])]
    .filter((x) => includeInactive || x.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 同じ名前（表記ゆれをそろえて）の項目。exceptId は名前を変える項目自身 */
export function findMasterDuplicate(list, kind, name, exceptId = null) {
  const key = kindOf(kind).key(name);
  if (!key) return null;
  return (list || []).find((x) => x.id !== exceptId && kindOf(kind).key(x.name) === key) || null;
}

async function mutate(siteId, kind, fn) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error(MASTER_COMPLETED_MESSAGE);
  const list = (site[kind] || []).map((x) => ({ ...x }));
  const item = fn(list);
  const updated = await updateSite(siteId, { [kind]: list });
  return { site: updated, item };
}

function duplicateMessage(dup, label) {
  return dup.active === false
    ? `「${dup.name}」が使用停止中です（同じ${label}として扱います）。新しく登録せず、使用を再開してください。`
    : `「${dup.name}」がすでに登録されています（同じ${label}として扱います）。`;
}

/** 追加する。同じ名前（表記ゆれを含む）があれば登録しない */
export async function addMasterItem(siteId, kind, name) {
  const { label } = kindOf(kind);
  const n = String(name || "").trim();
  if (!n) throw new Error(`${label}の名前を入力してください。`);
  return mutate(siteId, kind, (list) => {
    const dup = findMasterDuplicate(list, kind, n);
    if (dup) throw new Error(duplicateMessage(dup, label));
    const now = new Date().toISOString();
    const item = { id: createId(), name: n, active: true, order: list.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1, createdAt: now, updatedAt: now };
    list.push(item);
    return item;
  });
}

/** 名前を変える（過去の日報は保存した時点の名前のまま） */
export async function renameMasterItem(siteId, kind, id, name) {
  const { label } = kindOf(kind);
  const n = String(name || "").trim();
  if (!n) throw new Error(`${label}の名前を入力してください。`);
  return mutate(siteId, kind, (list) => {
    const item = list.find((x) => x.id === id);
    if (!item) throw new Error(`${label}が見つかりません。`);
    const dup = findMasterDuplicate(list, kind, n, id);
    if (dup) throw new Error(duplicateMessage(dup, label));
    item.name = n;
    item.updatedAt = new Date().toISOString();
    return item;
  });
}

/** 使用停止・再開（物理削除はしない） */
export async function setMasterItemActive(siteId, kind, id, active) {
  const { label } = kindOf(kind);
  return mutate(siteId, kind, (list) => {
    const item = list.find((x) => x.id === id);
    if (!item) throw new Error(`${label}が見つかりません。`);
    item.active = !!active;
    item.updatedAt = new Date().toISOString();
    return item;
  });
}

/** 並び順を1つ上（delta=-1）・下（+1）へ */
export async function moveMasterItem(siteId, kind, id, delta) {
  return mutate(siteId, kind, (list) => {
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const i = sorted.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= sorted.length) return null;
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    sorted.forEach((x, k) => { const t = list.find((y) => y.id === x.id); t.order = k; });
    return list.find((x) => x.id === id);
  });
}

/**
 * 過去の日報の工種のうち、一覧に無いもの（表記ゆれをそろえて比べる）。自動では登録しない（利用者が確認して登録する）。
 * @returns {{name: string, variants: string[], rows: number}[]} name は最初に出てきた書き方
 */
export function tradeCandidatesFromReports(site, reports) {
  const known = new Set((site?.trades || []).map((t) => tradeKey(t.name)));
  const byKey = new Map();
  for (const r of [...(reports || [])].filter((r) => !r.isDeleted).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    for (const c of r.companies || []) {
      const raw = String(c.occupation || "").trim();
      const key = tradeKey(raw);
      if (!key || known.has(key)) continue;
      if (!byKey.has(key)) byKey.set(key, { name: raw, variants: [], rows: 0 });
      const e = byKey.get(key);
      if (!e.variants.includes(raw)) e.variants.push(raw);
      e.rows++;
    }
  }
  return [...byKey.values()];
}

/** 工種の名前に合う一覧の項目（表記ゆれをそろえて）。無ければ null */
export function matchTrade(site, name) {
  const key = tradeKey(name);
  if (!key) return null;
  return (site?.trades || []).find((t) => tradeKey(t.name) === key) || null;
}
