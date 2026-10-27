/* ==========================================================
   危険予知活動表（KY活動表）の提出状況のデータ層（IndexedDB "kySubmissions"、DB v10）
   管理するのは「会社指定の紙のKY活動表が現場に提出されたか」だけ。KYの内容・写真・ファイルは持たない。
   「未提出」は紙がまだ提出されていないという意味で、KY活動をしていないという意味ではない。
   日報とは独立した提出物として、現場×日付×業者名ごとに1件持つ。
   ・提出対象は、その日の日報（通常作業の日）の業者名から自動で作る（2026-10-27。syncKyFromReports。未提出で作る）。
     日報に業者が増えれば対象も増える。日報から業者が無くなっても、提出状況・提出時刻は消さない（記録はそのまま残す）。
     日報が無い朝でも、監督が業者名を入れて登録できる（日報に無い業者も登録できる）。
   ・業者は業者名の文字列で識別する（前後の空白だけ除く。業者マスターは無い。表記が違えば別の業者。名寄せしない）。
   ・監督が提出対象から外した業者は「外した」印の記録（removed）にして、日報に残っていても自動では戻さない。
     外すときは、その業者の提出状況・提出時刻・変更履歴を消す（印には業者名と外した日時だけを持つ）。
     監督が追加し直すと、新しい記録（未提出・提出時刻なし）として作る。
   ・「提出済み」にした時点の日時を submittedAt に自動で記録する（押し直しても最初の時刻のまま）。
     未提出・対象外に戻すと submittedAt は空にし（次に提出済みにした時刻を新しく記録する）、変更の履歴（history: 状態と日時）は残す。
   ・日報の提出・確認・署名とは連動しない（日報提出済み＝KY提出済み、とは扱わない。逆も同じ）。日報の編集・削除で KY の記録は消えない。
   ・書き込みは、その現場の日報と KY の記録を読み直してから同じトランザクションで行う（二重登録をしない。保存に失敗したら失敗を返す）。
   ========================================================== */

import { dbGet, dbGetAll, dbGuardedPutMany } from "../db.js";
import { buildChangeEntry } from "../auditLog.js";
import { stampNew, stampUpdate } from "../utils.js";
import { isWorkDay } from "../dashboard/dailyFlow.js";

/** 業者ごとの状態。target=対象か、submitted=提出済か */
export const KY_STATES = [
  { value: "submitted", label: "提出済み" },
  { value: "not_submitted", label: "未提出" },
  { value: "excluded", label: "対象外" }
];

/** レコード → 状態（submitted / not_submitted / excluded） */
export function kyStateOf(record) {
  if (!record || record.target === false) return "excluded";
  return record.submitted ? "submitted" : "not_submitted";
}

/** 状態を変えるときの変更内容（純粋関数）。提出済にしたときだけ、その時点の日時を提出時刻にする */
export function kyPatchFor(record, state, now = new Date().toISOString()) {
  if (state === "submitted") {
    // すでに提出済なら最初の提出時刻を残す（押し直しで時刻が変わらないように）
    return { target: true, submitted: true, submittedAt: record?.submitted && record.submittedAt ? record.submittedAt : now };
  }
  if (state === "not_submitted") return { target: true, submitted: false, submittedAt: null };
  if (state === "excluded") return { target: false, submitted: false, submittedAt: null };
  throw new Error(`危険予知活動表の状態が不正です: ${state}`);
}

/** 業者名の比較用（前後の空白だけを除く。表記ゆれは吸収しない＝別の業者として扱う） */
export const kyVendorKey = (name) => String(name || "").trim();

/** 監督が提出対象から外した印の記録か */
export const isKyRemoved = (record) => record?.removed === true;

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));

/** その日の提出対象（外した印の記録は含めない） */
export async function listKySubmissions(siteId, date) {
  const all = await dbGetAll("kySubmissions", "by_siteId", siteId);
  return all.filter((r) => !r.isDeleted && !isKyRemoved(r) && r.date === date).sort(byOrder);
}

export async function listKySubmissionsBySite(siteId) {
  return (await dbGetAll("kySubmissions", "by_siteId", siteId)).filter((r) => !r.isDeleted && !isKyRemoved(r));
}

/** その日の、監督が提出対象から外した業者名（日報に残っていても自動では対象に戻さない） */
export async function listKyRemovedNames(siteId, date) {
  return (await dbGetAll("kySubmissions", "by_siteId", siteId)).filter((r) => !r.isDeleted && isKyRemoved(r) && r.date === date).sort(byOrder).map((r) => r.vendorName);
}

/**
 * その日の日報（通常作業の日・削除していないもの。同じ日に複数あればすべて）の業者名を、出てきた順に重複なしで（純粋関数）。
 * 名前は前後の空白だけ除き、空の名前は入れない（名寄せしない）
 */
export function reportVendorNamesOfDate(reports, siteId, date) {
  const names = [];
  const live = reports.filter((r) => !r.isDeleted && r.siteId === siteId && r.date === date && isWorkDay(r))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  for (const r of live) for (const c of r.companies || []) {
    const n = kyVendorKey(c.companyName);
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * 日報の業者のうち、まだ記録（提出対象・外した印のどちらも）が無い業者名（純粋関数）。
 * 外した印のある業者・すでに対象の業者は作らない
 */
export function planKySync({ reports, records, siteId, date }) {
  const known = new Set(records.filter((r) => !r.isDeleted && r.date === date).map((r) => kyVendorKey(r.vendorName)));
  return reportVendorNamesOfDate(reports, siteId, date).filter((n) => !known.has(n));
}

async function assertSiteEditable(siteId) {
  const site = await dbGet("sites", siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error("工事完了の現場は、危険予知活動表の提出状況を変更できません（工事完了を解除すると変更できます）。");
  return site;
}

const newTarget = (siteId, date, vendorName, order, source) =>
  stampNew({ siteId, date, vendorName, target: true, submitted: false, submittedAt: null, order, source, history: [{ state: "not_submitted", at: new Date().toISOString() }] });

/** トランザクションの中で、その現場の日報と KY の記録を読む設定と、読んだ結果の取り出し */
const siteReads = (siteId) => [{ store: "reports", index: "by_siteId", key: siteId }, { store: "kySubmissions", index: "by_siteId", key: siteId }];
const readOf = (indexAll, store, siteId) => indexAll.get(`${store}|by_siteId|${siteId}`) || [];

/**
 * 日報の業者から、その日の提出対象を自動で作る（未提出で作る。状態・提出時刻・外した印の記録は変えない）。
 * 工事完了の現場・日付が不正なときは何もしない。保存に失敗したら例外を投げる（画面で知らせる）
 * @returns {Promise<{created: string[]}>} 作った業者名
 */
export async function syncKyFromReports({ siteId, date }) {
  if (!siteId || !isDate(date)) return { created: [] };
  const site = await dbGet("sites", siteId);
  if (!site || site.completedAt) return { created: [] };
  let created = [];
  await dbGuardedPutMany({
    readIndexAll: siteReads(siteId),
    check: ({ indexAll }) => {
      const records = readOf(indexAll, "kySubmissions", siteId);
      created = planKySync({ reports: readOf(indexAll, "reports", siteId), records, siteId, date });
      const start = records.filter((r) => r.date === date).length;
      created = created.map((n, i) => newTarget(siteId, date, n, start + i, "report"));
      return null;
    },
    entriesOf: () => created.map((value) => ({ store: "kySubmissions", value }))
  });
  return { created: created.map((r) => r.vendorName) };
}

/**
 * 対象業者を登録する（未提出で作成。監督が名前を入れる・候補を押す）。同じ日に同じ業者名が対象にあれば新しく作らずにそのレコードを返す。
 * 外した印の記録があれば、その印を消して新しい記録（未提出・提出時刻なし）として作る
 * @returns {Promise<{record: object, created: boolean}>}
 */
export async function addKyVendor({ siteId, date, vendorName }) {
  const name = kyVendorKey(vendorName);
  if (!siteId || !isDate(date)) throw new Error("現場・日付が不正です");
  if (!name) throw new Error("業者名を入力してください");
  await assertSiteEditable(siteId);
  let result = null;
  let entries = [];
  await dbGuardedPutMany({
    readIndexAll: [{ store: "kySubmissions", index: "by_siteId", key: siteId }],
    check: ({ indexAll }) => {
      const sameDay = readOf(indexAll, "kySubmissions", siteId).filter((r) => !r.isDeleted && r.date === date);
      const same = sameDay.filter((r) => kyVendorKey(r.vendorName) === name);
      const active = same.find((r) => !isKyRemoved(r));
      if (active) { result = { record: active, created: false }; entries = []; return null; }
      const record = newTarget(siteId, date, name, sameDay.length, "manual");
      result = { record, created: true };
      entries = [...same.map((r) => ({ store: "kySubmissions", delete: r.id })), { store: "kySubmissions", value: record }];
      return null;
    },
    entriesOf: () => entries
  });
  return result;
}

/**
 * 業者を、この日の危険予知活動表の提出対象から外す（監督の操作。2026-10-03 に追加、2026-10-27 から外した印を残す）。
 * この1件（現場×日付×業者名）の提出状況・提出時刻（submittedAt）・状態の変更履歴（history）は消し、業者名と外した日時だけの
 * 印（removed）に置き換える（日報の業者から自動で作るときに、外した業者を戻さないため）。
 * 日報の業者・工種・人数・作業時間・署名・写真・請求人工などは参照も変更もしない。日報に無い業者でも外せる。工事完了の現場は不可。
 */
export async function deleteKyVendor(id) {
  const record = await dbGet("kySubmissions", id);
  if (!record || record.isDeleted || isKyRemoved(record)) throw new Error("危険予知活動表の記録が見つかりません（すでに削除されている可能性があります）");
  await assertSiteEditable(record.siteId);
  const at = new Date().toISOString();
  const tomb = {
    id: record.id, siteId: record.siteId, date: record.date, vendorName: record.vendorName, order: record.order ?? 0,
    removed: true, removedAt: at, target: false, submitted: false, submittedAt: null, history: [],
    createdAt: record.createdAt, updatedAt: at, version: (record.version || 1) + 1
  };
  await dbGuardedPutMany({
    reads: [{ store: "kySubmissions", id }],
    check: ({ records }) => {
      const cur = records.get(`kySubmissions:${id}`);
      return !cur || cur.isDeleted || isKyRemoved(cur) ? new Error("危険予知活動表の記録が見つかりません（すでに削除されている可能性があります）") : null;
    },
    entries: [
      { store: "kySubmissions", value: tomb },
      { store: "auditLog", value: buildChangeEntry({ entityType: "kySubmission", entityId: id, action: "delete", summary: `危険予知活動表の提出状況（${record.date}）から「${record.vendorName}」を削除` }) }
    ]
  });
  return record;
}

/** 状態（提出済／未提出／対象外）を変える */
export async function setKyState(id, state, now) {
  const record = await dbGet("kySubmissions", id);
  if (!record || record.isDeleted || isKyRemoved(record)) throw new Error("危険予知活動表の記録が見つかりません");
  await assertSiteEditable(record.siteId);
  const at = now || new Date().toISOString();
  const patch = kyPatchFor(record, state, at);
  // 状態の変更履歴（提出済みにした時刻を含む）は消さずに残す（直近100件）
  const history = [...(record.history || []), { state, at }].slice(-100);
  const updated = stampUpdate(record, { ...patch, history });
  await dbGuardedPutMany({
    reads: [{ store: "kySubmissions", id }],
    check: ({ records }) => {
      const cur = records.get(`kySubmissions:${id}`);
      if (!cur || cur.isDeleted || isKyRemoved(cur)) return new Error("危険予知活動表の記録が見つかりません");
      return cur.updatedAt !== record.updatedAt ? new Error("危険予知活動表の提出状況が別の画面で変更されました。画面を開き直してください。") : null;
    },
    entries: [{ store: "kySubmissions", value: updated }]
  });
  return updated;
}
