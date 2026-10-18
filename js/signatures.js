/* ==========================================================
   署名データ層
   role付きレコード＋companyIdにより、1日報が業者（company-row）
   ごとに複数の職長署名を持てる構造になっている。将来「元請担当・
   監督・確認者・管理者」等、業者に紐づかない役割を追加する場合は
   SIGNATURE_ROLESに1件足すだけでよい（その場合companyIdはnull）。
   ========================================================== */

import { dbGetAll, dbGuardedPutMany } from "./db.js";
import { buildChangeEntry } from "./auditLog.js";
import { stampNew } from "./utils.js";

export const SIGNATURE_ROLES = [
  { key: "foreman", label: "職長" }
];

/**
 * 署名を保存する。replaceId（今表示している署名）があれば、その削除・新しい署名の保存・削除の変更履歴を
 * 1つのトランザクションで書く（途中で失敗すれば何も変わらず、古い署名が残る。新しい署名だけが中途半端に残ることもない）。
 * 画像（blob）はトランザクションの前に作っておくこと（トランザクションの途中で画像の生成などを待たない）。
 * 同じ日報・同じ業者の行・同じ役割の、ほかの署名（以前からの重複）は削除しない（どれが正しいかを推測しない）。
 * @returns {Promise<object>} 保存した署名
 */
export async function saveSignature({ reportId, companyId = null, role = "foreman", blob, replaceId = null }) {
  const roleInfo = SIGNATURE_ROLES.find((r) => r.key === role) || SIGNATURE_ROLES[0];
  const signature = stampNew({
    reportId,
    companyId,
    role: roleInfo.key,
    roleLabel: roleInfo.label,
    imageBlob: blob,
    signedAt: new Date().toISOString()
  });
  let old = null;
  await dbGuardedPutMany({
    reads: replaceId ? [{ store: "signatures", id: replaceId }] : [],
    extraStores: ["signatures", "auditLog"],
    check: ({ records }) => { old = replaceId ? records.get(`signatures:${replaceId}`) || null : null; return null; },
    entriesOf: () => [
      ...(old ? [{ store: "signatures", delete: replaceId }, { store: "auditLog", value: buildChangeEntry({ entityType: "signature", entityId: replaceId, action: "delete", summary: `職長サインを削除（日報 ${old.reportId || "不明"}・書き直し）` }) }] : []),
      { store: "signatures", value: signature }
    ]
  });
  return signature;
}

export async function listSignaturesByReport(reportId) {
  const all = await dbGetAll("signatures", "by_reportId", reportId);
  return all.filter((s) => !s.isDeleted);
}

/**
 * 署名を削除する（保存場所から消す）。削除と、削除したことの変更履歴を1つのトランザクションで書く
 * （変更履歴は、バックアップから復元するとき、この端末で削除した署名を「復元候補」として見分けるため。2026-10-18 から）。
 */
export async function deleteSignature(id) {
  let sig = null;
  await dbGuardedPutMany({
    reads: [{ store: "signatures", id }],
    extraStores: ["auditLog"],
    check: ({ records }) => { sig = records.get(`signatures:${id}`) || null; return null; },
    entriesOf: () => (sig ? [{ store: "signatures", delete: id }, { store: "auditLog", value: buildChangeEntry({ entityType: "signature", entityId: id, action: "delete", summary: `職長サインを削除（日報 ${sig.reportId || "不明"}）` }) }] : [])
  });
}

/* ---------- 署名の重複（同じ日報・同じ業者の行・同じ役割に、削除されていない署名が2件以上） ----------
   画面・出力・カレンダーは、日報ごとに「業者の行（companyId）× 役割（role。今は職長 foreman だけ）」で1件の署名を引く
   （2件あると、どちらが使われるかは読み込みの順しだい）。そこで、この3つの組を重複の判定に使う。
   companyId の無い署名（業者に結び付かない役割のため）は、companyId を空として同じように数える。 */
export const signatureDupKey = (s) => [s.reportId, s.companyId || "", s.role || "foreman"].join("|");

/** 署名の一覧から、重複している組（キー → 署名id の一覧）を返す（削除済みは数えない） */
export function signatureDuplicateGroups(signatures) {
  const groups = new Map();
  for (const s of signatures || []) {
    if (!s || s.isDeleted || !s.reportId) continue;
    const k = signatureDupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s.id);
  }
  return new Map([...groups].filter(([, ids]) => ids.length > 1));
}

/**
 * 書き込みの前（before）と後（after）の署名の一覧を比べ、後で新しく重複になった組（または重複が増えた組）を返す。
 * 前からある重複（増えていないもの）は existing として別に返す（勝手に直さない・消さない。利用者に知らせるだけ）
 * @returns {{added: {key: string, reportId: string, companyId: string, role: string, ids: string[]}[], existing: object[]}}
 */
export function compareSignatureDuplicates(before, after) {
  const b = signatureDuplicateGroups(before);
  const a = signatureDuplicateGroups(after);
  const describe = (k, ids) => { const [reportId, companyId, role] = k.split("|"); return { key: k, reportId, companyId, role, ids }; };
  const added = []; const existing = [];
  for (const [k, ids] of a) ((b.get(k)?.length || 1) < ids.length ? added : existing).push(describe(k, ids));
  return { added, existing };
}
