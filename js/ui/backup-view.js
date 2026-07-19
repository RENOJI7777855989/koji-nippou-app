/* ==========================================================
   バックアップ管理画面（管理者のみ）
   フルバックアップの作成・ダウンロード、バックアップからの復元、
   バックアップ履歴の表示、前回バックアップからの経過時間の注意喚起を扱う。
   常時稼働する自動バックアップではなく、この画面を開いた時にしか
   動かない点に注意（詳細はbackup.js冒頭のコメント参照）。
   ========================================================== */

import {
  exportFullBackup,
  restoreFromBackup,
  analyzeBackupRestore,
  listBackupHistory,
  getLastBackupAt,
  isFolderHandleSupported,
  getSavedExportDirHandle,
  chooseAndSaveExportDirHandle,
  clearExportDirHandle,
  verifyDirHandlePermission,
  writeBackupToDirHandle,
  findLatestBackupInDirHandle
} from "../backup.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

const reminderEl = document.getElementById("backupReminder");
const exportBtn = document.getElementById("exportBackupBtn");
const restoreInput = document.getElementById("restoreFileInput");
const historyListEl = document.getElementById("backupHistoryList");
const historyEmptyEl = document.getElementById("backupHistoryEmpty");
const backBtn = document.getElementById("backToSiteListFromBackupBtn");

const folderSectionEl = document.getElementById("folderHandleSection");
const folderStatusEl = document.getElementById("folderHandleStatus");
const chooseFolderBtn = document.getElementById("chooseFolderHandleBtn");
const clearFolderBtn = document.getElementById("clearFolderHandleBtn");
const restoreFromFolderBtn = document.getElementById("restoreFromFolderBtn");

const conflictDialog = document.getElementById("backupConflictDialog");
const conflictListEl = document.getElementById("backupConflictList");
const conflictApplyBtn = document.getElementById("backupConflictApplyBtn");
const conflictCancelBtn = document.getElementById("backupConflictCancelBtn");
const conflictKeepAllLocalBtn = document.getElementById("conflictKeepAllLocalBtn");
const conflictOverwriteAllBtn = document.getElementById("conflictOverwriteAllBtn");

let pendingRestoreFile = null;

const REMINDER_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function formatDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function renderReminder() {
  const lastAt = await getLastBackupAt();
  if (!lastAt) {
    reminderEl.textContent = "まだ一度もバックアップが作成されていません。";
    reminderEl.hidden = false;
    return;
  }
  const elapsed = Date.now() - new Date(lastAt).getTime();
  if (elapsed > REMINDER_THRESHOLD_MS) {
    reminderEl.textContent = `前回のバックアップから24時間以上経過しています（前回: ${formatDateTime(lastAt)}）。バックアップの作成をおすすめします。`;
    reminderEl.hidden = false;
  } else {
    reminderEl.hidden = true;
  }
}

async function renderHistory() {
  const history = await listBackupHistory();
  historyListEl.innerHTML = "";
  historyEmptyEl.style.display = history.length === 0 ? "block" : "none";

  history.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "backup-history-item";
    const countsSummary = Object.entries(entry.recordCounts || {})
      .map(([store, count]) => `${store}:${count}`)
      .join(" / ");
    li.innerHTML = `
      <p class="backup-history-name">${escapeHtml(entry.filename)}</p>
      <p class="backup-history-meta">${escapeHtml(formatDateTime(entry.createdAt))} ／ ${formatSize(entry.sizeBytes || 0)}</p>
      <p class="backup-history-meta">${escapeHtml(countsSummary)}</p>
    `;
    historyListEl.appendChild(li);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  try {
    const { blob, filename } = await exportFullBackup();

    const dirHandle = await getSavedExportDirHandle();
    if (dirHandle && (await verifyDirHandlePermission(dirHandle, "readwrite"))) {
      await writeBackupToDirHandle(dirHandle, filename, blob);
      showMessage(`フルバックアップを作成し、共有フォルダ「${dirHandle.name}」に保存しました。`);
    } else {
      downloadBlob(blob, filename);
      showMessage("フルバックアップを作成しました。");
    }
    await renderReminder();
    await renderHistory();
  } catch (err) {
    showMessage(`バックアップの作成に失敗しました: ${err.message}`, true);
  } finally {
    exportBtn.disabled = false;
  }
});

function renderConflicts(conflicts) {
  conflictListEl.innerHTML = "";
  conflicts.forEach((c) => {
    const li = document.createElement("li");
    li.className = "backup-conflict-item";
    li.innerHTML = `
      <label class="checkbox-label">
        <input type="checkbox" class="conflictOverwriteCheckbox" data-key="${escapeHtml(c.store)}:${escapeHtml(c.id)}">
        ${escapeHtml(c.storeLabel)}「${escapeHtml(String(c.label))}」をバックアップの内容で上書きする
      </label>
      <p class="backup-history-meta">ローカルの更新: ${escapeHtml(formatDateTime(c.localUpdatedAt))} ／ バックアップの更新: ${escapeHtml(formatDateTime(c.incomingUpdatedAt))}</p>
    `;
    conflictListEl.appendChild(li);
  });
}

async function runRestore(file, skipKeys) {
  const counts = await restoreFromBackup(file, { skipKeys });
  showMessage(`復元しました（${Object.entries(counts).map(([k, v]) => `${k}:${v}件`).join("、")}）`);
  await renderReminder();
}

async function startRestoreFlow(file) {
  const { conflicts } = await analyzeBackupRestore(file);
  if (conflicts.length === 0) {
    if (!confirm("バックアップから復元しますか？バックアップに含まれるデータで、同じIDの既存データが上書きされます（バックアップに無いデータは削除されません）。")) {
      return;
    }
    await runRestore(file, new Set());
    return;
  }
  pendingRestoreFile = file;
  renderConflicts(conflicts);
  conflictDialog.showModal();
}

restoreInput.addEventListener("change", async () => {
  const file = restoreInput.files[0];
  if (!file) return;
  try {
    await startRestoreFlow(file);
  } catch (err) {
    showMessage(`復元に失敗しました: ${err.message}`, true);
  } finally {
    restoreInput.value = "";
  }
});

conflictKeepAllLocalBtn.addEventListener("click", () => {
  conflictListEl.querySelectorAll(".conflictOverwriteCheckbox").forEach((cb) => (cb.checked = false));
});
conflictOverwriteAllBtn.addEventListener("click", () => {
  conflictListEl.querySelectorAll(".conflictOverwriteCheckbox").forEach((cb) => (cb.checked = true));
});
conflictCancelBtn.addEventListener("click", () => {
  pendingRestoreFile = null;
  conflictDialog.close();
});
conflictApplyBtn.addEventListener("click", async () => {
  if (!pendingRestoreFile) return;
  const file = pendingRestoreFile;
  const skipKeys = new Set();
  conflictListEl.querySelectorAll(".conflictOverwriteCheckbox").forEach((cb) => {
    if (!cb.checked) skipKeys.add(cb.dataset.key); // 未チェック＝上書きしない＝ローカルを残す
  });
  pendingRestoreFile = null;
  conflictDialog.close();
  try {
    await runRestore(file, skipKeys);
  } catch (err) {
    showMessage(`復元に失敗しました: ${err.message}`, true);
  }
});

async function renderFolderStatus() {
  if (!isFolderHandleSupported()) {
    folderSectionEl.hidden = true;
    return;
  }
  folderSectionEl.hidden = false;
  const handle = await getSavedExportDirHandle();
  if (!handle) {
    folderStatusEl.textContent = "共有フォルダは設定されていません。";
    clearFolderBtn.hidden = true;
    restoreFromFolderBtn.hidden = true;
    return;
  }
  folderStatusEl.textContent = `記憶しているフォルダ: ${handle.name}`;
  clearFolderBtn.hidden = false;
  restoreFromFolderBtn.hidden = false;
}

chooseFolderBtn.addEventListener("click", async () => {
  try {
    const handle = await chooseAndSaveExportDirHandle();
    showMessage(`共有フォルダ「${handle.name}」を記憶しました。`);
    await renderFolderStatus();
  } catch (err) {
    if (err.name !== "AbortError") showMessage(`フォルダの選択に失敗しました: ${err.message}`, true);
  }
});

clearFolderBtn.addEventListener("click", async () => {
  await clearExportDirHandle();
  showMessage("共有フォルダの記憶を解除しました。");
  await renderFolderStatus();
});

restoreFromFolderBtn.addEventListener("click", async () => {
  try {
    const handle = await getSavedExportDirHandle();
    if (!handle || !(await verifyDirHandlePermission(handle, "read"))) {
      showMessage("共有フォルダにアクセスできません。フォルダを選び直してください。", true);
      return;
    }
    const latest = await findLatestBackupInDirHandle(handle);
    if (!latest) {
      showMessage("共有フォルダにバックアップファイル（backup_*.zip）が見つかりません。", true);
      return;
    }
    const file = new File([latest.file], latest.filename, { type: latest.file.type });
    await startRestoreFlow(file);
  } catch (err) {
    showMessage(`共有フォルダからの復元に失敗しました: ${err.message}`, true);
  }
});

backBtn.addEventListener("click", () => navigate("/sites"));

export async function initBackupView() {
  showView("view-backup");
  await renderReminder();
  await renderHistory();
  await renderFolderStatus();
}
