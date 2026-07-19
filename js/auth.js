/* ==========================================================
   ユーザー管理・ログイン・権限判定
   重要な限界: このアプリはサーバーを持たないため、ここでの認証は
   「同じブラウザ内でのUI上の役割分担」であり、真のアクセス制御
   （第三者のなりすまし防止等）ではない。ブラウザの開発者ツールから
   IndexedDBを直接操作すれば誰でも回避できる。パスワードはソルト付き
   SHA-256でハッシュ化して保存するが、これはうっかり画面越しに他人の
   パスワードが読めてしまうことを防ぐ程度の意味しかない。
   ========================================================== */

import { dbGet, dbGetAll, dbPut } from "./db.js";
import { stampNew, stampUpdate } from "./utils.js";
import { getCurrentUser, setCurrentUser } from "./currentUser.js";
import { recordChange } from "./auditLog.js";

export const ROLES = {
  ADMIN: "admin",
  SUPERVISOR: "supervisor",
  VIEWER: "viewer"
};

export const ROLE_LABELS = {
  [ROLES.ADMIN]: "管理者",
  [ROLES.SUPERVISOR]: "監督",
  [ROLES.VIEWER]: "閲覧のみ"
};

// action名 → 許可されるロールの一覧。
const PERMISSIONS = {
  manageUsers: [ROLES.ADMIN],
  manageSites: [ROLES.ADMIN],
  manageTemplates: [ROLES.ADMIN],
  manageBackup: [ROLES.ADMIN],
  viewHistory: [ROLES.ADMIN],
  editSites: [ROLES.ADMIN, ROLES.SUPERVISOR],
  editReports: [ROLES.ADMIN, ROLES.SUPERVISOR],
  sign: [ROLES.ADMIN, ROLES.SUPERVISOR],
  output: [ROLES.ADMIN, ROLES.SUPERVISOR]
};

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

async function findByUsername(username) {
  const all = await dbGetAll("users", "by_username", username);
  return all.find((u) => !u.isDeleted) || null;
}

export async function hasAnyUser() {
  const all = await dbGetAll("users");
  return all.some((u) => !u.isDeleted);
}

export async function listUsers() {
  const all = await dbGetAll("users");
  return all.filter((u) => !u.isDeleted).sort((a, b) => a.username.localeCompare(b.username, "ja"));
}

export async function getUser(id) {
  return dbGet("users", id);
}

export async function createUser({ username, password, displayName, role }) {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) throw new Error("ユーザー名を入力してください");
  if (!password || password.length < 4) throw new Error("パスワードは4文字以上で入力してください");
  if (!Object.values(ROLES).includes(role)) throw new Error(`不正なロールです: ${role}`);
  const existing = await findByUsername(normalizedUsername);
  if (existing) throw new Error("同じユーザー名が既に存在します");

  const salt = randomSalt();
  const passwordHash = await hashPassword(password, salt);
  const user = stampNew({
    username: normalizedUsername,
    displayName: displayName?.trim() || normalizedUsername,
    role,
    passwordSalt: salt,
    passwordHash
  });
  await dbPut("users", user);
  await recordChange({ entityType: "user", entityId: user.id, action: "create", summary: `ユーザー「${user.username}」（${ROLE_LABELS[role]}）を作成` });
  return user;
}

export async function updateUserProfile(id, { displayName, role }) {
  const existing = await dbGet("users", id);
  if (!existing) throw new Error("ユーザーが見つかりません");
  const patch = {};
  if (displayName !== undefined) patch.displayName = displayName.trim() || existing.username;
  if (role !== undefined) {
    if (!Object.values(ROLES).includes(role)) throw new Error(`不正なロールです: ${role}`);
    patch.role = role;
  }
  const updated = stampUpdate(existing, patch);
  await dbPut("users", updated);
  await recordChange({ entityType: "user", entityId: id, action: "update", summary: `ユーザー「${updated.username}」の情報を更新` });

  // 自分自身の情報を更新した場合、ログインセッションにも反映する
  const current = getCurrentUser();
  if (current && current.id === id) {
    setCurrentUser({ ...current, displayName: updated.displayName, role: updated.role });
  }
  return updated;
}

export async function resetPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 4) throw new Error("パスワードは4文字以上で入力してください");
  const existing = await dbGet("users", id);
  if (!existing) throw new Error("ユーザーが見つかりません");
  const salt = randomSalt();
  const passwordHash = await hashPassword(newPassword, salt);
  const updated = stampUpdate(existing, { passwordSalt: salt, passwordHash });
  await dbPut("users", updated);
  await recordChange({ entityType: "user", entityId: id, action: "update", summary: `ユーザー「${updated.username}」のパスワードをリセット` });
  return updated;
}

export async function deactivateUser(id) {
  const existing = await dbGet("users", id);
  if (!existing) throw new Error("ユーザーが見つかりません");
  const updated = stampUpdate(existing, { isDeleted: true });
  await dbPut("users", updated);
  await recordChange({ entityType: "user", entityId: id, action: "delete", summary: `ユーザー「${updated.username}」を無効化` });
  return updated;
}

export async function login(username, password) {
  const user = await findByUsername(username.trim());
  if (!user) return { ok: false, error: "ユーザー名またはパスワードが違います" };
  const hash = await hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) return { ok: false, error: "ユーザー名またはパスワードが違います" };
  const session = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
  setCurrentUser(session);
  return { ok: true, user: session };
}

export function logout() {
  setCurrentUser(null);
}

/**
 * 現在のリリースではmain.jsからログインの必須化を外しているため、
 * getCurrentUser()は常にnullを返す＝誰もログインしていない。
 * その場合は「未ログイン＝権限なし」ではなく「ログイン機能自体を
 * 使っていない＝全操作を許可（オープンアクセス）」として扱う。
 * 将来main.jsでログインを再度必須化すれば、ここに到達する時点で
 * 必ずユーザーが存在するようになるため、下のロール判定がそのまま
 * 有効になる（このファイル自体の変更は不要）。
 */
export function hasPermission(action) {
  const user = getCurrentUser();
  if (!user) return true;
  const allowedRoles = PERMISSIONS[action];
  if (!allowedRoles) return false;
  return allowedRoles.includes(user.role);
}

/** 現場に対する閲覧・編集権限。管理者と閲覧のみは全現場、監督は担当現場のみ。 */
export function canAccessSite(site) {
  const user = getCurrentUser();
  if (!user) return true;
  if (user.role === ROLES.ADMIN || user.role === ROLES.VIEWER) return true;
  if (user.role === ROLES.SUPERVISOR) return (site?.assignedUserIds || []).includes(user.id);
  return false;
}
