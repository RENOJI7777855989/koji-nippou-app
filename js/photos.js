/* ==========================================================
   写真データ層
   選択されたファイルはcanvasで長辺1600px程度に縮小・JPEG再
   エンコードしてから保存し、IndexedDBの容量肥大を防ぐ
   ========================================================== */

import { dbGetAll, dbPut, dbDelete } from "./db.js";
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

export async function deletePhoto(id) {
  return dbDelete("photos", id);
}
