/* ==========================================================
   ユーザー管理画面（管理者のみ）
   一覧・追加・編集（表示名/ロール/パスワード再設定）・無効化を扱う。
   最後の1人の管理者を無効化／降格できないようにする安全弁を持つ
   （それをすると誰もユーザー管理画面に入れなくなるため）。
   ========================================================== */

import { listUsers, createUser, updateUserProfile, resetPassword, deactivateUser, ROLES, ROLE_LABELS } from "../auth.js";
import { getCurrentUser } from "../currentUser.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

const listEl = document.getElementById("userList");
const emptyEl = document.getElementById("userListEmpty");
const addBtn = document.getElementById("addUserBtn");
const backBtn = document.getElementById("backToSiteListFromUsersBtn");

const dialog = document.getElementById("userFormDialog");
const form = document.getElementById("userForm");
const formTitle = document.getElementById("userFormTitle");
const usernameInput = document.getElementById("userUsernameInput");
const usernameRequiredMark = document.getElementById("userUsernameRequiredMark");
const displayNameInput = document.getElementById("userDisplayNameInput");
const roleSelect = document.getElementById("userRoleSelect");
const passwordInput = document.getElementById("userPasswordInput");
const passwordRequiredMark = document.getElementById("userPasswordRequiredMark");
const cancelBtn = document.getElementById("userCancelBtn");

let editingId = null;

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

async function renderList() {
  const users = await listUsers();
  listEl.innerHTML = "";
  emptyEl.style.display = users.length === 0 ? "block" : "none";

  users.forEach((u) => {
    const li = document.createElement("li");
    li.className = "user-item";
    li.dataset.userId = u.id;
    li.innerHTML = `
      <div class="user-item-info">
        <p class="user-item-name">${escapeHtml(u.displayName)}（${escapeHtml(u.username)}）</p>
        <p class="user-item-meta"><span class="status-badge">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span> 登録日: ${formatDate(u.createdAt)}</p>
      </div>
      <div class="user-item-actions">
        <button type="button" class="secondary-btn editUserBtn">編集</button>
        <button type="button" class="secondary-btn resetPasswordBtn">パスワード再設定</button>
        <button type="button" class="secondary-btn deactivateUserBtn">無効化</button>
      </div>
    `;
    listEl.appendChild(li);
  });
}

async function countActiveAdmins() {
  const users = await listUsers();
  return users.filter((u) => u.role === ROLES.ADMIN).length;
}

function resetForm() {
  editingId = null;
  form.reset();
  usernameInput.disabled = false;
  usernameRequiredMark.style.display = "inline";
  passwordRequiredMark.style.display = "inline";
  passwordInput.placeholder = "4文字以上";
}

addBtn.addEventListener("click", () => {
  resetForm();
  formTitle.textContent = "ユーザーを追加";
  dialog.showModal();
  usernameInput.focus();
});

cancelBtn.addEventListener("click", () => dialog.close());
backBtn.addEventListener("click", () => navigate("/sites"));

listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".user-item");
  if (!li) return;
  const userId = li.dataset.userId;
  const users = await listUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return;

  if (e.target.closest(".editUserBtn")) {
    resetForm();
    editingId = user.id;
    formTitle.textContent = "ユーザーを編集";
    usernameInput.value = user.username;
    usernameInput.disabled = true;
    usernameRequiredMark.style.display = "none";
    displayNameInput.value = user.displayName;
    roleSelect.value = user.role;
    passwordRequiredMark.style.display = "none";
    passwordInput.placeholder = "変更する場合のみ入力（4文字以上）";
    dialog.showModal();
    return;
  }

  if (e.target.closest(".resetPasswordBtn")) {
    const newPassword = prompt(`「${user.displayName}」の新しいパスワードを入力してください（4文字以上）`);
    if (newPassword === null) return;
    try {
      await resetPassword(user.id, newPassword);
      showMessage("パスワードを再設定しました。");
    } catch (err) {
      showMessage(err.message, true);
    }
    return;
  }

  if (e.target.closest(".deactivateUserBtn")) {
    if (user.role === ROLES.ADMIN && (await countActiveAdmins()) <= 1) {
      showMessage("最後の管理者は無効化できません。先に別の管理者を作成してください。", true);
      return;
    }
    if (!confirm(`ユーザー「${user.displayName}」を無効化しますか？`)) return;
    await deactivateUser(user.id);
    showMessage("ユーザーを無効化しました。");
    await renderList();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const displayName = displayNameInput.value.trim();
  const role = roleSelect.value;

  try {
    if (editingId) {
      if (role !== ROLES.ADMIN) {
        const current = await listUsers();
        const target = current.find((u) => u.id === editingId);
        if (target?.role === ROLES.ADMIN && (await countActiveAdmins()) <= 1) {
          showMessage("最後の管理者のロールは変更できません。", true);
          return;
        }
      }
      await updateUserProfile(editingId, { displayName, role });
      if (passwordInput.value) {
        await resetPassword(editingId, passwordInput.value);
      }
      showMessage("ユーザー情報を更新しました。");
    } else {
      const username = usernameInput.value.trim();
      if (!username) {
        showMessage("ユーザー名を入力してください。", true);
        return;
      }
      await createUser({ username, password: passwordInput.value, displayName, role });
      showMessage("ユーザーを追加しました。");
    }
  } catch (err) {
    showMessage(err.message, true);
    return;
  }

  dialog.close();
  await renderList();
});

export async function initUserManagementView() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  showView("view-users");
  await renderList();
}
