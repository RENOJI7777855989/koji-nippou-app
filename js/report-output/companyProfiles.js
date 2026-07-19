/* ==========================================================
   提出先会社プロファイルのデータ層
   帳票を提出する元請会社ごとに、ロゴ・印影・既定テンプレートを
   保持する。sites.js/reports.jsと同じCRUDパターンを踏襲する。
   ========================================================== */

import { dbGetAll, dbGet, dbPut, dbDelete } from "../db.js";
import { stampNew, stampUpdate } from "../utils.js";

export async function listCompanyProfiles() {
  const all = await dbGetAll("companyProfiles");
  return all.filter((c) => !c.isDeleted).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function getCompanyProfile(id) {
  return dbGet("companyProfiles", id);
}

export async function createCompanyProfile({ name, memo = "", defaultExcelTemplateId = "", defaultPdfTemplateId = "" }) {
  const profile = stampNew({
    name,
    memo,
    logoBlob: null,
    logoMimeType: "",
    hankoBlob: null,
    hankoMimeType: "",
    defaultExcelTemplateId,
    defaultPdfTemplateId
  });
  await dbPut("companyProfiles", profile);
  return profile;
}

export async function updateCompanyProfile(id, patch) {
  const existing = await dbGet("companyProfiles", id);
  if (!existing) throw new Error("会社プロファイルが見つかりません");
  const updated = stampUpdate(existing, patch);
  await dbPut("companyProfiles", updated);
  return updated;
}

export async function setCompanyLogo(id, blob, mimeType) {
  return updateCompanyProfile(id, { logoBlob: blob, logoMimeType: mimeType });
}

export async function setCompanyHanko(id, blob, mimeType) {
  return updateCompanyProfile(id, { hankoBlob: blob, hankoMimeType: mimeType });
}

export async function deleteCompanyProfile(id) {
  return updateCompanyProfile(id, { isDeleted: true });
}
