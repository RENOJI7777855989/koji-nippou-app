/* ==========================================================
   未完了の復元の知らせ（重要な知らせ。通常の一時的なメッセージ（showMessage・3秒で消える）とは別）
   バックアップからの復元が決着していない（書き込み済み・確認待ち／復旧が必要／復旧失敗）あいだは、
   画面の上部に固定して出し続ける（時間では消さない。下までスクロールしても見える）。
   ・「小さくする」は表示を1行にまとめるだけで、復元の記録・退避は変えない（消すこともしない）
   ・表示を消すのは、実際の記録を読み直して、決着していない記録が無くなったときだけ
   ・自動では確認も復旧もしない（「未完了の復元を確認する」でバックアップ管理を開く）
   ========================================================== */

import { listRestoreJournals, RESTORE_JOURNAL_STATE_LABELS } from "../backup.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";

const COMPACT_KEY = "restorePendingBannerCompact"; // 小さくしたか（この端末の表示だけ。記録は変えない）

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function isCompact() { try { return sessionStorage.getItem(COMPACT_KEY) === "1"; } catch { return false; } }
function setCompact(v) { try { if (v) sessionStorage.setItem(COMPACT_KEY, "1"); else sessionStorage.removeItem(COMPACT_KEY); } catch { /* 保存できなくても動く */ } }

let refreshing = null;

/** 実際の記録を読み直して、知らせを出す・消す */
export function refreshRestorePendingBanner() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const el = document.getElementById("restorePendingBanner");
    if (!el) return;
    let pending = [];
    try { pending = await listRestoreJournals({ onlyUnresolved: true }); } catch { pending = []; }
    if (!pending.length) {
      el.hidden = true;
      el.innerHTML = "";
      document.body.classList.remove("has-restore-banner");
      setCompact(false);
      return;
    }
    const compact = isCompact();
    el.hidden = false;
    el.classList.toggle("is-compact", compact);
    document.body.classList.add("has-restore-banner");
    el.innerHTML = `<div class="restore-pending-head">
        <strong>⚠ バックアップからの復元が完了していません（${pending.length}件）</strong>
        <span class="restore-pending-buttons">
          <button type="button" data-banner-action="open">未完了の復元を確認する</button>
          <button type="button" class="secondary-btn" data-banner-action="toggle">${compact ? "詳しく表示" : "小さくする"}</button>
        </span>
      </div>
      ${compact ? "" : `<p class="restore-pending-note">自動では元に戻しません。確認・復旧（復元前の状態に戻す）は、バックアップ管理の「未完了の復元」で選んでください。この表示は、すべて決着するまで消えません。</p>
      <ul class="restore-pending-list">${pending.map((j) => `<li><strong>${escapeHtml(RESTORE_JOURNAL_STATE_LABELS[j.state] || j.state)}</strong>　${escapeHtml(j.fileName || "")}（${escapeHtml(formatDateTime(j.createdAt))}・上書き ${j.overwritten || 0}件・追加 ${j.added || 0}件）</li>`).join("")}</ul>`}`;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function initRestorePendingBanner() {
  const el = document.getElementById("restorePendingBanner");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-banner-action]");
    if (!btn) return;
    if (btn.dataset.bannerAction === "open") navigate("/backup");
    if (btn.dataset.bannerAction === "toggle") { setCompact(!isCompact()); refreshRestorePendingBanner(); }
  });
  // 画面を移るとき・アプリに戻ったとき（別のタブで決着した場合など）に読み直す
  window.addEventListener("hashchange", () => refreshRestorePendingBanner());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshRestorePendingBanner(); });
  refreshRestorePendingBanner();
}
