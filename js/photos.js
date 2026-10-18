/* ==========================================================
   写真データ層
   選択されたファイルはcanvasで長辺1600px程度に縮小・JPEG再
   エンコードしてから保存し、IndexedDBの容量肥大を防ぐ
   ========================================================== */

import { dbGetAll, dbPut, dbDelete, dbGet } from "./db.js";
import { recordChange } from "./auditLog.js";
import { stampNew } from "./utils.js";

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

export async function addPhoto(reportId, siteId, file, order = 0) {
  const blob = await resizeImage(file);
  const photo = stampNew({ reportId, siteId, blob, mimeType: "image/jpeg", order, caption: "" });
  await dbPut("photos", photo);
  return photo;
}

export async function listPhotosByReport(reportId) {
  const all = await dbGetAll("photos", "by_reportId", reportId);
  return all.filter((p) => !p.isDeleted).sort((a, b) => a.order - b.order);
}

/**
 * 写真を削除する（保存場所から消す）。2026-10-18 から、削除したことを変更履歴に残す（バックアップから復元するとき、
 * この端末で削除した写真を「復元候補」として見分けるため。過去の削除の記録は作らない）。
 */
export async function deletePhoto(id) {
  const photo = await dbGet("photos", id).catch(() => null);
  await dbDelete("photos", id);
  await recordChange({ entityType: "photo", entityId: id, action: "delete", summary: `写真を削除（日報 ${photo?.reportId || "不明"}）` }).catch(() => {});
}
