/* ==========================================================
   画面共通の枠（ヘッダー直下のユーザーバー）
   ログイン中ユーザーの表示、ロールに応じた管理者メニューの
   出し分け、ログアウトを担う。ルート遷移とは独立して、
   ログイン・ログアウトのタイミングでrefreshUserBar()を呼べば
   常に最新状態を反映する。
   ========================================================== */

import { getCurrentUser } from "../currentUser.js";
import { ROLE_LABELS, hasPermission, logout } from "../auth.js";
import { navigate } from "../router.js";

const userBar = document.getElementById("userBar");
const userBarInfo = document.getElementById("userBarInfo");
const goToUsersBtn = document.getElementById("goToUsersBtn");
const goToHistoryBtn = document.getElementById("userBarGoToHistoryBtn");
const goToBackupBtn = document.getElementById("userBarGoToBackupBtn");
const logoutBtn = document.getElementById("logoutBtn");

export function refreshUserBar() {
  const user = getCurrentUser();
  if (!user) {
    userBar.hidden = true;
    return;
  }
  userBar.hidden = false;
  userBarInfo.textContent = `ログイン中: ${user.displayName || user.username}（${ROLE_LABELS[user.role] || user.role}）`;
  goToUsersBtn.hidden = !hasPermission("manageUsers");
  goToHistoryBtn.hidden = !hasPermission("viewHistory");
  goToBackupBtn.hidden = !hasPermission("manageBackup");
}

goToUsersBtn.addEventListener("click", () => navigate("/users"));
goToHistoryBtn.addEventListener("click", () => navigate("/history"));
goToBackupBtn.addEventListener("click", () => navigate("/backup"));
logoutBtn.addEventListener("click", () => {
  logout();
  refreshUserBar();
  navigate("/login");
});
