/* ==========================================================
   危険予知活動表（KY活動表）の提出状況のデータ層（IndexedDB "kySubmissions"、DB v10）
   管理するのは「会社指定の紙のKY活動表が現場に提出されたか」だけ。KYの内容・写真・ファイルは持たない。
   「未提出」は紙がまだ提出されていないという意味で、KY活動をしていないという意味ではない。
   日報とは独立した提出物として、現場×日付×業者名ごとに1件持つ。
   ・日報の有無に関係なく登録できる（朝、日報を書く前に受け付けるため）。日報から自動では作らない。
   ・業者は業者名の文字列で識別する（業者マスターは無い。表記が違えば別の業者）。
   ・対象業者は監督が選んで登録したものだけ（全業者を自動で対象にしない）。
   ・「提出済み」にした時点の日時を submittedAt に自動で記録する（押し直しても最初の時刻のまま）。
     未提出・対象外に戻すと submittedAt は空にするが、変更の履歴（history: 状態と日時）は消さずに残す。
   ・日報の提出・確認とは連動しない（日報提出済み＝KY提出済み、とは扱わない。逆も同じ）。
   ========================================================== */

import { dbGet, dbGetAll, dbPut } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";

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

export async function listKySubmissions(siteId, date) {
  const all = await dbGetAll("kySubmissions", "by_siteId", siteId);
  return all.filter((r) => !r.isDeleted && r.date === date).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

export async function listKySubmissionsBySite(siteId) {
  return (await dbGetAll("kySubmissions", "by_siteId", siteId)).filter((r) => !r.isDeleted);
}

async function assertSiteEditable(siteId) {
  const site = await dbGet("sites", siteId);
  if (!site) throw new Error("現場が見つかりません");
  if (site.completedAt) throw new Error("工事完了の現場は、危険予知活動表の提出状況を変更できません（工事完了を解除すると変更できます）。");
}

/**
 * 対象業者を登録する（未提出で作成）。同じ日に同じ業者名が既にあれば、新しく作らずにそのレコードを返す。
 * @returns {Promise<{record: object, created: boolean}>}
 */
export async function addKyVendor({ siteId, date, vendorName }) {
  const name = kyVendorKey(vendorName);
  if (!siteId || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("現場・日付が不正です");
  if (!name) throw new Error("業者名を入力してください");
  await assertSiteEditable(siteId);
  const existing = await listKySubmissions(siteId, date);
  const same = existing.find((r) => kyVendorKey(r.vendorName) === name);
  if (same) return { record: same, created: false };
  const record = stampNew({ siteId, date, vendorName: name, target: true, submitted: false, submittedAt: null, order: existing.length, history: [{ state: "not_submitted", at: new Date().toISOString() }] });
  await dbPut("kySubmissions", record);
  return { record, created: true };
}

/** 状態（提出済／未提出／対象外）を変える */
export async function setKyState(id, state, now) {
  const record = await dbGet("kySubmissions", id);
  if (!record || record.isDeleted) throw new Error("危険予知活動表の記録が見つかりません");
  await assertSiteEditable(record.siteId);
  const at = now || new Date().toISOString();
  const patch = kyPatchFor(record, state, at);
  // 状態の変更履歴（提出済みにした時刻を含む）は消さずに残す（直近100件）
  const history = [...(record.history || []), { state, at }].slice(-100);
  const updated = stampUpdate(record, { ...patch, history });
  await dbPut("kySubmissions", updated);
  return updated;
}
