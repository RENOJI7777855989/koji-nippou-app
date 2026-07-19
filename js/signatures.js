/* ==========================================================
   署名データ層
   role付きレコード＋companyIdにより、1日報が業者（company-row）
   ごとに複数の職長署名を持てる構造になっている。将来「元請担当・
   監督・確認者・管理者」等、業者に紐づかない役割を追加する場合は
   SIGNATURE_ROLESに1件足すだけでよい（その場合companyIdはnull）。
   ========================================================== */

import { dbGetAll, dbPut, dbDelete } from "./db.js";
import { stampNew } from "./utils.js";

export const SIGNATURE_ROLES = [
  { key: "foreman", label: "職長" }
];

export async function saveSignature({ reportId, companyId = null, role = "foreman", blob }) {
  const roleInfo = SIGNATURE_ROLES.find((r) => r.key === role) || SIGNATURE_ROLES[0];
  const signature = stampNew({
    reportId,
    companyId,
    role: roleInfo.key,
    roleLabel: roleInfo.label,
    imageBlob: blob,
    signedAt: new Date().toISOString()
  });
  await dbPut("signatures", signature);
  return signature;
}

export async function listSignaturesByReport(reportId) {
  const all = await dbGetAll("signatures", "by_reportId", reportId);
  return all.filter((s) => !s.isDeleted);
}

export async function deleteSignature(id) {
  return dbDelete("signatures", id);
}
