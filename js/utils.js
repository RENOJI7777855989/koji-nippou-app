/* ==========================================================
   共通ユーティリティ
   - escapeHtml/createId は旧script.jsから移設
   - stampNew/stampUpdate は、将来のクラウド同期・競合検出を
     見据えたメタ情報（updatedAt/version/isDeleted/deviceId/
     updatedByUserId/updatedByUserName）を全レコードへ一律付与する
     共通処理。更新者情報はcurrentUser.jsから取得するため、
     全データ層の呼び出し元を個別に変更しなくても自動的に
     「誰が最後に更新したか」が記録される。
   ========================================================== */

import { getCurrentUser } from "./currentUser.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

export function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const DEVICE_ID_KEY = "deviceId";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = createId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function nowIso() {
  return new Date().toISOString();
}

export function stampNew(fields) {
  const now = nowIso();
  const user = getCurrentUser();
  return {
    id: createId(),
    ...fields,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: user?.id || "",
    updatedByUserName: user?.displayName || user?.username || "",
    version: 1,
    isDeleted: false,
    deviceId: getDeviceId()
  };
}

export function stampUpdate(record, patch) {
  const user = getCurrentUser();
  return {
    ...record,
    ...patch,
    updatedAt: nowIso(),
    updatedByUserId: user?.id || "",
    updatedByUserName: user?.displayName || user?.username || "",
    version: (record.version || 1) + 1,
    deviceId: getDeviceId()
  };
}
