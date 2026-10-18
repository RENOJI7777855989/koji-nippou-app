/* ==========================================================
   バックアップ管理画面（管理者のみ）
   フルバックアップの作成・ダウンロード、バックアップからの復元、
   バックアップ履歴の表示、前回バックアップからの経過時間の注意喚起を扱う。
   常時稼働する自動バックアップではなく、この画面を開いた時にしか
   動かない点に注意（詳細はbackup.js冒頭のコメント参照）。
   ========================================================== */

import {
  exportFullBackup,
  analyzeBackupFile,
  RESTORE_PLAN_STALE_MESSAGE,
  RESTORE_JOURNAL_STATE_LABELS,
  listRestoreJournals,
  verifyPendingRestore,
  recoverRestore,
  closeRestoreJournal,
  applyBackupRestore,
  createVerifiedBackup,
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
import { storageProtectionStatus } from "../storagePersist.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { refreshRestorePendingBanner } from "./restore-pending-banner.js";

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

const restoreDialog = document.getElementById("backupRestoreDialog");
const restoreFileInfoEl = document.getElementById("restoreFileInfo");
const restoreErrorsEl = document.getElementById("restoreErrors");
const restorePlanEl = document.getElementById("restorePlan");
const restoreChoicesEl = document.getElementById("restoreChoices");
const restorePreBackupEl = document.getElementById("restorePreBackup");
const restorePreBackupBtn = document.getElementById("restorePreBackupBtn");
const restorePreBackupStatusEl = document.getElementById("restorePreBackupStatus");
const restorePreBackupConfirmLabel = document.getElementById("restorePreBackupConfirmLabel");
const restorePreBackupConfirm = document.getElementById("restorePreBackupConfirm");
const restoreStatusEl = document.getElementById("restoreStatus");
const restoreApplyBtn = document.getElementById("restoreApplyBtn");
const restoreCancelBtn = document.getElementById("restoreCancelBtn");
const journalSectionEl = document.getElementById("restoreJournalSection");
const closeDialog = document.getElementById("restoreCloseDialog");
const closeConfirm = document.getElementById("restoreCloseConfirm");
const closeOkBtn = document.getElementById("restoreCloseOkBtn");
const closeCancelBtn = document.getElementById("restoreCloseCancelBtn");
const closeTargetEl = document.getElementById("restoreCloseTarget");

/** 復元の途中の状態（検査の結果・復元前のバックアップ） */
let restoreState = { analysis: null, preBackup: null, busy: false };

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

const ACTION_LABELS = { new: "新規", overwrite: "上書き", same: "同じ内容", conflict: "ローカルを残す（競合）", candidate: "復元候補・要確認" };

function renderRestoreDialog() {
  const a = restoreState.analysis;
  const f = a.format;
  restoreFileInfoEl.textContent = `ファイル: ${a.fileName}${a.manifest?.exportedAt ? `（作成 ${formatDateTime(a.manifest.exportedAt)}）` : ""}${f ? `・形式 ${f.legacy ? "版1（従来の形式）" : `版${f.formatVersion}`}${f.dbVersion ? `・DB v${f.dbVersion}` : ""}` : ""}`;
  // 検査の結果
  if (a.errors.length) {
    restoreErrorsEl.hidden = false;
    restoreErrorsEl.innerHTML = `<p class="restore-errors-head">検査で ${a.errors.length}件の問題が見つかったため、復元できません（何も書き込んでいません）。</p><ul>${a.errors.slice(0, 200).map((e) => `<li>${escapeHtml(e.store)}${e.id ? `（${escapeHtml(e.id)}）` : ""}: ${escapeHtml(e.reason)}</li>`).join("")}</ul>${a.errors.length > 200 ? `<p>ほか ${a.errors.length - 200}件</p>` : ""}`;
  } else {
    restoreErrorsEl.hidden = true;
    restoreErrorsEl.innerHTML = "";
  }
  // 計画（ストアごとの件数）
  const rows = Object.entries(a.stores).filter(([, s]) => s.new + s.overwrite + s.same + s.conflict + s.candidate + s.errors > 0);
  const warningsHtml = (a.warnings || []).length ? `<div class="restore-warnings"><p class="restore-errors-head">確認してください（${a.warnings.length}件。復元は止めません）</p><ul>${a.warnings.slice(0, 50).map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>` : "";
  restorePlanEl.innerHTML = warningsHtml + (a.manifest ? `<h4>復元の内容（ストアごと）</h4><div class="dash-table-wrap"><table class="dash-table restore-plan-table"><thead><tr><th>データ</th><th class="num">新規</th><th class="num">上書き</th><th class="num">同じ内容</th><th class="num">ローカルを残す（競合）</th><th class="num">復元候補・要確認</th><th class="num">添付ファイル</th><th class="num">検査エラー</th></tr></thead><tbody>${rows.map(([store, s]) => `<tr data-store="${escapeHtml(store)}"><td>${escapeHtml(a.items.find((it) => it.store === store)?.storeLabel || store)}</td><td class="num">${s.new}</td><td class="num">${s.overwrite}</td><td class="num">${s.same}</td><td class="num">${s.conflict}</td><td class="num">${s.candidate}</td><td class="num">${s.attachments}</td><td class="num">${s.errors}</td></tr>`).join("")}</tbody></table></div><p class="app-subtitle">バックアップに無いデータは消しません。「ローカルを残す（競合）」と「復元候補・要確認」は、下で選んだものだけを復元します（既定では復元しません）。</p>` : "");
  // 選択（競合・復元候補）
  const choices = a.ok ? a.items.filter((it) => it.action === "conflict" || it.action === "candidate") : [];
  restoreChoicesEl.innerHTML = choices.length ? `<h4>選んで復元するもの（${choices.length}件）</h4>
    <div class="toolbar"><button type="button" class="secondary-btn" data-restore-all="0">すべて復元しない</button><button type="button" class="secondary-btn" data-restore-all="1">すべて復元する</button></div>
    <ul class="backup-conflict-list">${choices.map((it) => `<li class="backup-conflict-item"><label class="checkbox-label"><input type="checkbox" class="restoreChoice" data-key="${escapeHtml(it.key)}"> ${escapeHtml(it.storeLabel)}「${escapeHtml(it.label)}」を復元する（${escapeHtml(ACTION_LABELS[it.action])}）</label><p class="backup-history-meta">${escapeHtml(it.reason)}${it.localUpdatedAt || it.incomingUpdatedAt ? `　この端末: ${escapeHtml(it.localUpdatedAt ? formatDateTime(it.localUpdatedAt) : "なし")}／バックアップ: ${escapeHtml(it.incomingUpdatedAt ? formatDateTime(it.incomingUpdatedAt) : "なし")}` : ""}</p></li>`).join("")}</ul>` : "";
  restorePreBackupEl.hidden = !a.ok;
  restorePreBackupStatusEl.textContent = "";
  restorePreBackupConfirmLabel.hidden = true;
  restorePreBackupConfirm.checked = false;
  restoreStatusEl.textContent = "";
  updateRestoreApplyButton();
}

function updateRestoreApplyButton() {
  const a = restoreState.analysis;
  restoreApplyBtn.disabled = restoreState.busy || !a?.ok || !restoreState.preBackup || !restorePreBackupConfirm.checked;
}

async function startRestoreFlow(file) {
  const pending = await listRestoreJournals({ onlyUnresolved: true }).catch(() => []);
  if (pending.length) {
    showMessage("前回のバックアップからの復元が決着していません。上の「未完了の復元」で確認・復旧してから、もう一度復元してください（何も書き込んでいません）。", true);
    await renderRestoreJournals();
    return;
  }
  restoreState = { analysis: null, preBackup: null, busy: false, file };
  showMessage("バックアップを検査しています…");
  restoreState.analysis = await analyzeBackupFile(file);
  renderRestoreDialog();
  restoreDialog.showModal();
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

restoreChoicesEl.addEventListener("click", (e) => {
  const all = e.target.closest("[data-restore-all]");
  if (all) restoreChoicesEl.querySelectorAll(".restoreChoice").forEach((cb) => (cb.checked = all.dataset.restoreAll === "1"));
});
restorePreBackupConfirm.addEventListener("change", updateRestoreApplyButton);

restorePreBackupBtn.addEventListener("click", async () => {
  restorePreBackupBtn.disabled = true;
  restoreState.preBackup = null;
  restorePreBackupConfirm.checked = false;
  restorePreBackupConfirmLabel.hidden = true;
  restorePreBackupStatusEl.textContent = "作成して確かめています…";
  updateRestoreApplyButton();
  try {
    const pre = await createVerifiedBackup();
    const dirHandle = await getSavedExportDirHandle();
    let where;
    if (dirHandle && (await verifyDirHandlePermission(dirHandle, "readwrite"))) {
      await writeBackupToDirHandle(dirHandle, pre.filename, pre.blob);
      where = `共有フォルダ「${dirHandle.name}」`;
    } else {
      downloadBlob(pre.blob, pre.filename);
      where = "この端末のダウンロード（iPadはファイルアプリの「ダウンロード」）";
    }
    restoreState.preBackup = pre;
    restorePreBackupStatusEl.textContent = `作成しました: ${pre.filename}（${formatSize(pre.blob.size)}）。読み直して確かめました（${pre.check.records}件・添付ファイル ${pre.check.attachments}件が今のデータと一致）。保存先: ${where}`;
    restorePreBackupConfirmLabel.hidden = false;
    await renderHistory();
  } catch (err) {
    restorePreBackupStatusEl.textContent = `作成できませんでした: ${err.message}（復元は開始できません）`;
  } finally {
    restorePreBackupBtn.disabled = false;
    updateRestoreApplyButton();
  }
});

restoreCancelBtn.addEventListener("click", () => {
  if (restoreState.busy) return;
  restoreState = { analysis: null, preBackup: null, busy: false };
  restoreDialog.close();
});

restoreApplyBtn.addEventListener("click", async () => {
  const a = restoreState.analysis;
  if (!a?.ok || !restoreState.preBackup || !restorePreBackupConfirm.checked) return;
  const applyKeys = new Set([...restoreChoicesEl.querySelectorAll(".restoreChoice")].filter((cb) => cb.checked).map((cb) => cb.dataset.key));
  restoreState.busy = true;
  updateRestoreApplyButton();
  restoreCancelBtn.disabled = true;
  restoreStatusEl.textContent = "復元しています…（画面を閉じないでください）";
  try {
    const res = await applyBackupRestore(a, { applyKeys });
    restoreDialog.close();
    showMessage(`復元しました（${Object.entries(res.counts).map(([k, n]) => `${a.items.find((it) => it.store === k)?.storeLabel || k}:${n}件`).join("、") || "変更なし"}）。書き込み後の確認も済んでいます。`);
    restoreState = { analysis: null, preBackup: null, busy: false };
    await renderReminder();
  } catch (err) {
    if (err?.stale && restoreState.file) {
      // 計画を作った後に端末のデータが変わった: 何も書いていない。古い計画は使わず、今の状態で検査し直して計画を作り直す。
      // 復元前のバックアップは計画より前の状態かもしれないので、作り直しを求める（確認欄も外す）
      showMessage(`${RESTORE_PLAN_STALE_MESSAGE}。`, true);
      restoreState.busy = false;
      restoreState.preBackup = null;
      try {
        restoreState.analysis = await analyzeBackupFile(restoreState.file);
        renderRestoreDialog();
        restoreStatusEl.textContent = `${RESTORE_PLAN_STALE_MESSAGE}。今の状態で検査し直し、復元の内容を作り直しました（何も書き込んでいません）。内容を確かめ、復元前のバックアップを作り直してから復元してください。`;
      } catch (e2) {
        restoreState.analysis = null;
        restoreStatusEl.textContent = `${RESTORE_PLAN_STALE_MESSAGE}。再検査できませんでした（${e2.message}）。画面を閉じて、もう一度ファイルを選んでください。`;
      }
    } else {
      restoreStatusEl.textContent = `復元できませんでした: ${err.message}`;
      showMessage(`復元できませんでした: ${err.message}`, true);
      if (err?.needsRecovery) { restoreState.analysis = null; await renderRestoreJournals(); await refreshRestorePendingBanner(); }
    }
  } finally {
    restoreState.busy = false;
    restoreCancelBtn.disabled = false;
    updateRestoreApplyButton();
  }
});

/** 未完了の復元（written・needs_recovery・recovery_failed）。確認・復旧・閉じるは、利用者が押したときだけ */
async function renderRestoreJournals() {
  const list = await listRestoreJournals({ onlyUnresolved: true }).catch(() => []);
  journalSectionEl.hidden = list.length === 0;
  if (!list.length) { journalSectionEl.innerHTML = ""; return; }
  journalSectionEl.innerHTML = `<h3>未完了の復元</h3>
    <p class="restore-journal-lead">バックアップからの復元が決着していません。決着するまで、新しい復元はできません。復元前の状態に戻す（復旧）のは、下のボタンを押したときだけです。</p>
    ${list.map((j) => `<div class="restore-journal-item" data-key="${escapeHtml(j.key)}">
      <p><strong>${escapeHtml(RESTORE_JOURNAL_STATE_LABELS[j.state] || j.state)}</strong>　${escapeHtml(j.fileName || "")}（${escapeHtml(formatDateTime(j.createdAt))}・上書き ${j.overwritten || 0}件・追加 ${j.added || 0}件）</p>
      ${j.lastError ? `<p class="restore-journal-error">${escapeHtml(j.lastError)}</p>` : ""}
      ${(j.conflicts || []).length ? `<p class="restore-journal-error">復元の後に変更されたデータ（手動での対応が必要）: ${escapeHtml(j.conflicts.slice(0, 20).join("・"))}${j.conflicts.length > 20 ? ` ほか${j.conflicts.length - 20}件` : ""}</p>` : ""}
      <div class="toolbar">
        ${j.state === "written" ? `<button type="button" data-journal-action="verify">書き込みを確認する</button>` : ""}
        <button type="button" data-journal-action="recover">復元前の状態に戻す（復旧）</button>
        <button type="button" class="secondary-btn restore-journal-close" data-journal-action="close">復旧せずに記録を閉じる（退避データを削除）</button>
      </div>
    </div>`).join("")}`;
}

journalSectionEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-journal-action]");
  if (!btn) return;
  const key = btn.closest("[data-key]").dataset.key;
  const action = btn.dataset.journalAction;
  if (action === "recover" && !confirm("この復元で書き込んだ内容を取り消し、復元前の状態に戻します。\n・復元で上書きしたデータは元の内容に戻ります\n・復元で追加したデータは削除されます\n・復元の後に変更されたデータがあれば、消さずに中止します\nよろしいですか？")) return;
  if (action === "close" && !(await askCloseWithoutRecovery(btn.closest("[data-key]").querySelector("p")?.textContent || ""))) return;
  journalSectionEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    if (action === "verify") {
      const r = await verifyPendingRestore(key);
      showMessage(r.state === "verified" ? "書き込みを確認しました（復元は成功しています）。" : `確認で食い違いが見つかりました（${r.mismatches.slice(0, 3).join("／")}）。「復元前の状態に戻す」で戻せます。`, r.state !== "verified");
    } else if (action === "recover") {
      const r = await recoverRestore(key);
      showMessage(`復元前の状態に戻しました（戻した ${r.restored}件・削除 ${r.deleted}件）。`);
    } else if (action === "close") {
      await closeRestoreJournal(key);
      showMessage("記録を閉じました（データは変えていません）。");
    }
  } catch (err) {
    showMessage(`${action === "recover" ? "復旧できませんでした" : "できませんでした"}: ${err.message}`, true);
  } finally {
    await renderRestoreJournals();
    await renderHistory();
    await refreshRestorePendingBanner();
  }
});

/** 「復旧せずに記録を閉じる」の確認（理解した旨の確認欄にチェックするまで実行できない。キャンセルでは何も変えない） */
function askCloseWithoutRecovery(targetText) {
  return new Promise((resolve) => {
    closeTargetEl.textContent = targetText ? `対象: ${targetText}` : "";
    closeConfirm.checked = false;
    closeOkBtn.disabled = true;
    const done = (v) => { closeDialog.close(); closeConfirm.onchange = null; closeOkBtn.onclick = null; closeCancelBtn.onclick = null; closeDialog.oncancel = null; resolve(v); };
    closeConfirm.onchange = () => { closeOkBtn.disabled = !closeConfirm.checked; };
    closeOkBtn.onclick = () => { if (closeConfirm.checked) done(true); };
    closeCancelBtn.onclick = () => done(false);
    closeDialog.oncancel = (e) => { e.preventDefault(); done(false); };
    closeDialog.showModal();
  });
}

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

/** 保存データの保護（ブラウザが返した結果だけを表示する。保護されたと推測では出さない） */
async function renderStorageProtection() {
  const el = document.getElementById("storageProtection");
  if (!el) return;
  const st = await storageProtectionStatus();
  const mb = (b) => (b == null ? "" : `${(b / 1024 / 1024).toFixed(1)}MB`);
  const state = !st.supported ? "このブラウザでは、保存データを残すよう求める仕組みが使えないため、状態を確認できません。"
    : st.persisted === true ? "このブラウザは、保存データを残すことを許可しています（ブラウザが返した結果）。"
    : st.persisted === false ? "このブラウザは、保存データを残すことをまだ許可していません。使わない期間が続く・容量が足りないなどのときに、ブラウザが保存データを削除する可能性があります。"
    : "保存データの状態を確認できませんでした。";
  el.innerHTML = `<h3>保存データの保護</h3>
    <p class="storage-protection-state${st.persisted === true ? " is-ok" : " is-warn"}">${escapeHtml(state)}</p>
    <ul class="storage-protection-tips">
      ${st.standalone ? "<li>ホーム画面に追加したアプリとして開いています。</li>" : "<li>iPadでは、Safariの共有ボタン →「ホーム画面に追加」から開くと、保存データが消されにくくなります（ブラウザのタブで開いたままにしない）。</li>"}
      <li>許可されていても、端末の故障・初期化・機種変更・サイトデータの削除では消えます。定期的に「フルバックアップを作成してダウンロード」し、ファイルを端末の外（パソコン・共有フォルダなど）にも保存してください。</li>
      ${st.usage != null && st.quota ? `<li>このアプリの使用量: ${mb(st.usage)}（ブラウザが示す上限の目安: ${mb(st.quota)}）</li>` : ""}
    </ul>`;
}

export async function initBackupView() {
  showView("view-backup");
  await renderStorageProtection();
  await renderRestoreJournals();
  await renderReminder();
  await renderHistory();
  await renderFolderStatus();
}
