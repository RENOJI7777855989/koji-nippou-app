/* ==========================================================
   ログイン中ユーザーの保持
   このアプリはサーバーを持たないため、ここでの「ログイン状態」は
   ブラウザのlocalStorageに保存されるだけの状態にすぎない。
   utils.js（stampNew/stampUpdateの更新者記録）とauth.js（権限判定）の
   両方から参照される、循環importを避けるための最小モジュール。
   ========================================================== */

const CURRENT_USER_KEY = "currentUser";

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(CURRENT_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCurrentUser(user) {
  if (user) {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(CURRENT_USER_KEY);
  }
}
