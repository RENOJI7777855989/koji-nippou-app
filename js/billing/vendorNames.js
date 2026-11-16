/* ==========================================================
   業者名の確認（名寄せ）と、棟の使用設定（2026-11-16）
   ・日報の業者の行は従来どおり業者名の文字列（companies[].companyName）だけを持つ。日報は書き換えない。
   ・業者名が完全に同じ（前後の空白だけ除く）行は、従来どおり同じ業者。
   ・表記が違う名前（「株式会社タナベ建設」「（株）タナベ建設」など）は、候補として示すだけで自動ではまとめない。
     利用者が「同じ業者」と確認した名前だけを、現場の記録 site.vendorDirectory の1つのグループにまとめる。
     「別の業者」と確認した組も記録し、候補に出し直さない（どちらも変更・解除できる）。
       site.vendorDirectory = {
         groups:   [{ id, displayName, names: [業者名…], createdAt, updatedAt }],   // id が内部の業者ID（画面には出さない）
         distinct: [{ a, b, decidedAt }]                                          // 別の業者と確認した名前の組
       }
     グループに入っていない名前は、その名前だけで1つの業者（内部の業者IDは "name:" ＋名前）。
   ・業者ID（グループの id）・棟ID（作業行の buildingId）・日報の行ID（companyId）は別のもの。
   ・DB の構造・版（v10）は変えない（現場のレコードに任意の項目を足すだけ。バックアップは現場のレコードごと）。
   ・この記録を使うのは「請求人工と稼働の照合」・業者ごとのPDF（js/billing/billingReconcile.js・vendorMonthSheets.js）。
     業者管理の既存の表（業者別稼働・請求人工管理）・ダッシュボード・03-2 は従来どおり業者名で数える。
   ・棟の使用設定: site.useBuildings（true＝使う・false＝使わない）。未設定の現場は、棟の一覧に1つでも棟があれば
     「使う」、無ければ「使わない」として扱う（以前の現場の動きを変えないため）。
   ========================================================== */

import { getSite, updateSite } from "../sites.js";
import { createId } from "../utils.js";

export const VENDOR_COMPLETED_MESSAGE = "工事完了の現場は、業者名の確認結果・棟の使用設定を変更できません（工事完了を解除すると変更できます）。";

const trimName = (s) => String(s ?? "").trim();

/** 棟を使う現場か（明示の設定 → 無ければ棟の一覧の有無） */
export function siteUsesBuildings(site) {
  if (site?.useBuildings === true) return true;
  if (site?.useBuildings === false) return false;
  return (site?.buildings || []).length > 0;
}

/* ---------- 候補の見つけ方（純粋関数）---------- */
const CORP_WORDS = ["株式会社", "有限会社", "合同会社", "合資会社", "合名会社", "(株)", "(有)", "(同)", "(資)", "(名)", "株)", "(株", "有)", "(有"];

/** 比べるための名前（全角半角・空白・会社の種類の表記をそろえる）。表示・保存には使わない */
export function vendorCompareKey(name) {
  let s = trimName(name).normalize("NFKC").replace(/[\s　・･.,，、]+/g, "").replace(/（/g, "(").replace(/）/g, ")");
  for (const w of CORP_WORDS) s = s.split(w).join("");
  return s.toLowerCase();
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 2つの名前が同じ業者かもしれない理由（違えば null）。似ているだけなので確定はしない
 */
export function vendorSimilarity(a, b) {
  const ka = vendorCompareKey(a), kb = vendorCompareKey(b);
  if (!ka || !kb || trimName(a) === trimName(b)) return null;
  if (ka === kb) return { level: "high", reason: "会社の種類（株式会社・（株）など）・空白・全角半角の違いだけです" };
  const [s, l] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (s.length >= 2 && l.includes(s)) return { level: "medium", reason: "一方の名前が、もう一方の名前に含まれています" };
  const p = commonPrefix(ka, kb);
  if (p >= 2 && p * 2 >= s.length) return { level: "low", reason: "名前の先頭が同じです" };
  return null;
}

/* ---------- 記録の読み方（純粋関数）---------- */
export function directoryOf(site) {
  const d = site?.vendorDirectory || {};
  return {
    groups: (d.groups || []).filter((g) => g && g.id && Array.isArray(g.names)).map((g) => ({ ...g, names: [...new Set(g.names.map(trimName).filter(Boolean))] })),
    distinct: (d.distinct || []).filter((x) => x && x.a && x.b)
  };
}

const pairKey = (a, b) => [trimName(a), trimName(b)].sort().join("\u0000");

/**
 * 業者名 → 業者（内部の業者IDと表示名）を引く関数
 * @returns {(name: string) => {id: string, name: string, names: string[], grouped: boolean} | null}
 */
export function vendorResolver(site) {
  const dir = directoryOf(site);
  const byName = new Map();
  for (const g of dir.groups) for (const n of g.names) byName.set(n, g);
  return (raw) => {
    const n = trimName(raw);
    if (!n) return null;
    const g = byName.get(n);
    if (g) return { id: g.id, name: trimName(g.displayName) || g.names[0], names: g.names, grouped: true };
    return { id: `name:${n}`, name: n, names: [n], grouped: false };
  };
}

/**
 * 現場で使われている業者名（出どころごとの件数）。
 * @param {{site: object, reports: object[], ky?: object[], quoteBatches?: object[]}} p
 * @returns {{name: string, reportRows: number, reportDays: number, firstDate: string, lastDate: string, trades: string[], ky: number, billingStatus: number, quotes: number}[]}
 */
export function collectVendorNames({ site, reports = [], ky = [], quoteBatches = [] }) {
  const m = new Map();
  const ensure = (n) => {
    if (!m.has(n)) m.set(n, { name: n, reportRows: 0, days: new Set(), firstDate: "", lastDate: "", trades: new Set(), ky: 0, billingStatus: 0, quotes: 0 });
    return m.get(n);
  };
  for (const r of reports) {
    if (r.isDeleted) continue;
    for (const c of r.companies || []) {
      const n = trimName(c.companyName);
      if (!n) continue;
      const e = ensure(n);
      e.reportRows++;
      if (r.date) {
        e.days.add(r.date);
        if (!e.firstDate || r.date < e.firstDate) e.firstDate = r.date;
        if (r.date > e.lastDate) e.lastDate = r.date;
      }
      if (trimName(c.occupation)) e.trades.add(trimName(c.occupation));
    }
  }
  for (const k of ky) { if (k?.removed) continue; const n = trimName(k?.vendorName); if (n) ensure(n).ky++; }
  for (const mo of Object.values(site?.billingMonths || {})) for (const n of Object.keys(mo?.vendors || {})) { const t = trimName(n); if (t) ensure(t).billingStatus++; }
  for (const b of quoteBatches) { if (b?.isDeleted) continue; const n = trimName(b?.vendorName); if (n) ensure(n).quotes++; }
  return [...m.values()].map((e) => ({ ...e, reportDays: e.days.size, days: undefined, trades: [...e.trades] })).sort((a, b) => b.reportRows - a.reportRows || a.name.localeCompare(b.name, "ja"));
}

/**
 * 同じ業者かもしれない名前の組（確認待ち）と、確認済みの組。
 * 同じグループに入っている組・「別の業者」と確認した組は確認待ちにしない。
 * @returns {{pending: object[], decidedDistinct: object[], groups: object[]}}
 */
export function vendorNameCandidates({ site, names }) {
  const dir = directoryOf(site);
  const resolve = vendorResolver(site);
  const distinct = new Map(dir.distinct.map((x) => [pairKey(x.a, x.b), x]));
  const info = new Map(names.map((x) => [x.name, x]));
  const pending = [];
  const decidedDistinct = [];
  const list = names.map((x) => x.name);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const sim = vendorSimilarity(a, b);
      if (!sim) continue;
      if (resolve(a).id === resolve(b).id) continue; // すでに同じ業者
      const pair = { a, b, ...sim, aInfo: info.get(a), bInfo: info.get(b), affectsReports: (info.get(a)?.reportRows || 0) > 0 && (info.get(b)?.reportRows || 0) > 0 };
      const d = distinct.get(pairKey(a, b));
      if (d) decidedDistinct.push({ ...pair, decidedAt: d.decidedAt || "" });
      else pending.push(pair);
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  pending.sort((x, y) => order[x.level] - order[y.level] || x.a.localeCompare(y.a, "ja"));
  // 「別の業者」と確認したが、今は候補にならない組（名前が無くなった等）も、解除できるように出す
  for (const d of dir.distinct) if (!decidedDistinct.some((x) => pairKey(x.a, x.b) === pairKey(d.a, d.b))) decidedDistinct.push({ a: d.a, b: d.b, level: "", reason: "", decidedAt: d.decidedAt || "" });
  return { pending, decidedDistinct, groups: dir.groups.map((g) => ({ ...g, displayName: trimName(g.displayName) || g.names[0], info: g.names.map((n) => info.get(n) || { name: n, reportRows: 0 }) })) };
}

/** 日報の数字に関わる確認待ちの名前（照合で「業者名確認待ち」にする） */
export function pendingNameSet(candidates) {
  const s = new Set();
  for (const p of candidates.pending) if (p.affectsReports) { s.add(p.a); s.add(p.b); }
  return s;
}

/* ---------- 保存（現場のレコード）---------- */
async function mutateDirectory(siteId, fn) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error(VENDOR_COMPLETED_MESSAGE);
  const dir = directoryOf(site);
  const now = new Date().toISOString();
  fn(dir, now);
  return updateSite(siteId, { vendorDirectory: { groups: dir.groups.filter((g) => g.names.length >= 2), distinct: dir.distinct } });
}

/**
 * 名前を同じ業者としてまとめる（すでにどれかがグループにあれば、そのグループに足す）。日報は変えない
 * @param {string[]} names 2つ以上
 * @param {string} [displayName] 画面・PDFに出す名前（既定は最初の名前）
 */
export async function mergeVendorNames(siteId, names, displayName) {
  const list = [...new Set((names || []).map(trimName).filter(Boolean))];
  if (list.length < 2) throw new Error("同じ業者にまとめる名前を2つ以上選んでください。");
  return mutateDirectory(siteId, (dir, now) => {
    const hit = dir.groups.filter((g) => g.names.some((n) => list.includes(n)));
    const all = [...new Set([...hit.flatMap((g) => g.names), ...list])];
    const keep = hit[0] || { id: createId(), createdAt: now };
    dir.groups = dir.groups.filter((g) => !hit.includes(g));
    const disp = trimName(displayName) || trimName(keep.displayName) || all[0];
    if (!all.includes(disp)) throw new Error("表示名は、まとめる名前のどれかを選んでください。");
    dir.groups.push({ ...keep, displayName: disp, names: all, updatedAt: now });
    // 同じ業者にした組は「別の業者」の記録から外す
    dir.distinct = dir.distinct.filter((x) => !(all.includes(trimName(x.a)) && all.includes(trimName(x.b))));
  });
}

/** 名前をグループから外す（その名前は単独の業者に戻る。残りが1つになったグループは無くなる） */
export async function unmergeVendorName(siteId, name) {
  const n = trimName(name);
  return mutateDirectory(siteId, (dir, now) => {
    const g = dir.groups.find((x) => x.names.includes(n));
    if (!g) throw new Error(`「${n}」は、ほかの名前とまとめられていません。`);
    g.names = g.names.filter((x) => x !== n);
    if (trimName(g.displayName) === n) g.displayName = g.names[0] || "";
    g.updatedAt = now;
  });
}

/** 表示名を変える（グループの名前のどれか） */
export async function setVendorDisplayName(siteId, groupId, displayName) {
  const d = trimName(displayName);
  return mutateDirectory(siteId, (dir, now) => {
    const g = dir.groups.find((x) => x.id === groupId);
    if (!g) throw new Error("業者のまとまりが見つかりません。");
    if (!g.names.includes(d)) throw new Error("表示名は、まとめた名前のどれかを選んでください。");
    g.displayName = d;
    g.updatedAt = now;
  });
}

/** 2つの名前を「別の業者」と記録する（候補に出し直さない） */
export async function markVendorsDistinct(siteId, a, b) {
  const x = trimName(a), y = trimName(b);
  if (!x || !y || x === y) throw new Error("別の業者として記録する2つの名前を選んでください。");
  return mutateDirectory(siteId, (dir, now) => {
    if (dir.groups.some((g) => g.names.includes(x) && g.names.includes(y))) throw new Error("この2つは同じ業者にまとめられています。先にまとめを解除してください。");
    if (!dir.distinct.some((d) => pairKey(d.a, d.b) === pairKey(x, y))) dir.distinct.push({ a: x, b: y, decidedAt: now });
  });
}

/** 「別の業者」の記録を消す（また候補に出る） */
export async function clearVendorsDistinct(siteId, a, b) {
  return mutateDirectory(siteId, (dir) => {
    dir.distinct = dir.distinct.filter((d) => pairKey(d.a, d.b) !== pairKey(a, b));
  });
}

/** 棟の使用設定を保存する */
export async function setSiteUseBuildings(siteId, use) {
  const site = await getSite(siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error(VENDOR_COMPLETED_MESSAGE);
  return updateSite(siteId, { useBuildings: !!use });
}
