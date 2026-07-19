/* ==========================================================
   ログイン画面／初回起動時の初期セットアップ画面
   ユーザーが1人も登録されていない場合は、最初の管理者アカウントを
   その場で作成してログインする「初期セットアップ」モードになる。
   ========================================================== */

import { hasAnyUser, createUser, login, ROLES } from "../auth.js";
import { restoreFromBackup } from "../backup.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { refreshUserBar } from "./app-shell.js";

const titleEl = document.getElementById("loginTitle");
const setupNoticeEl = document.getElementById("loginSetupNotice");
const form = document.getElementById("loginForm");
const usernameInput = document.getElementById("loginUsername");
const passwordInput = document.getElementById("loginPassword");
const displayNameWrap = document.getElementById("loginDisplayNameWrap");
const displayNameInput = document.getElementById("loginDisplayName");
const submitBtn = document.getElementById("loginSubmitBtn");
const restoreSection = document.getElementById("loginRestoreSection");
const restoreFileInput = document.getElementById("loginRestoreFileInput");

let setupMode = false;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    showMessage("ユーザー名とパスワードを入力してください。", true);
    return;
  }

  try {
    if (setupMode) {
      await createUser({ username, password, displayName: displayNameInput.value, role: ROLES.ADMIN });
    }
    const result = await login(username, password);
    if (!result.ok) {
      showMessage(result.error, true);
      return;
    }
    refreshUserBar();
    showMessage(`ようこそ、${result.user.displayName}さん`);
    navigate("/sites");
  } catch (err) {
    showMessage(err.message, true);
  }
});

restoreFileInput.addEventListener("change", async () => {
  const file = restoreFileInput.files[0];
  if (!file) return;
  if (!confirm("バックアップから復元しますか？このファイルに含まれるユーザー・現場・日報などのデータがこの端末に書き戻されます。")) {
    restoreFileInput.value = "";
    return;
  }
  try {
    await restoreFromBackup(file);
    showMessage("バックアップから復元しました。ログインしてください。");
    await initLoginView();
  } catch (err) {
    showMessage(`復元に失敗しました: ${err.message}`, true);
  } finally {
    restoreFileInput.value = "";
  }
});

export async function initLoginView() {
  showView("view-login");
  form.reset();
  setupMode = !(await hasAnyUser());
  titleEl.textContent = setupMode ? "初期セットアップ" : "ログイン";
  setupNoticeEl.hidden = !setupMode;
  displayNameWrap.hidden = !setupMode;
  restoreSection.hidden = !setupMode; // 復元すればユーザーは既に揃うため、通常ログイン時は不要
  submitBtn.textContent = setupMode ? "管理者アカウントを作成してログイン" : "ログイン";
  usernameInput.focus();
}
