/* ==========================================================
   保存データの保護（navigator.storage.persist。2026-10-17）
   ・このアプリのデータは端末のブラウザの保存領域（IndexedDB）にだけある。Safari（特にタブで開いている場合）は、
     しばらく使わない・容量が足りないなどのときに、サイトの保存データを削除することがある。
   ・起動時に一度だけ「保存データを残す」ようブラウザに求める（navigator.storage.persist）。許可されるかはブラウザが決め、
     保証はない。許可されたかどうかは navigator.storage.persisted() の結果だけを表示し、推測で「保護済み」と出さない。
   ・データを移したり消したりはしない（求めるだけ）。使えないブラウザでは何もしない。
   ・許可されても、端末の故障・初期化・サイトデータの削除・機種変更では消えるため、定期的なバックアップは必要。
   ========================================================== */

let lastResult = null;

/** ホーム画面に追加したアプリ（スタンドアロン表示）で開いているか */
export function isStandalone() {
  try { return window.matchMedia?.("(display-mode: standalone)")?.matches === true || window.navigator.standalone === true; } catch { return false; }
}

/**
 * 保存データを残すようブラウザに求める（起動時に1回）。結果は storageProtectionStatus で読む。
 * @returns {Promise<{supported: boolean, persisted: boolean|null, requested: boolean, error: string}>}
 */
export async function requestPersistentStorage() {
  const s = navigator.storage;
  if (!s || typeof s.persisted !== "function") { lastResult = { supported: false, persisted: null, requested: false, error: "" }; return lastResult; }
  try {
    let persisted = await s.persisted();
    let requested = false;
    if (!persisted && typeof s.persist === "function") { requested = true; persisted = await s.persist(); }
    lastResult = { supported: true, persisted: persisted === true, requested, error: "" };
  } catch (err) {
    lastResult = { supported: true, persisted: null, requested: false, error: String(err?.message || err) };
  }
  return lastResult;
}

/** いまの状態（毎回ブラウザに問い合わせる。容量は分かる場合だけ） */
export async function storageProtectionStatus() {
  const s = navigator.storage;
  const out = { supported: !!(s && typeof s.persisted === "function"), persisted: null, standalone: isStandalone(), usage: null, quota: null, requested: !!lastResult?.requested };
  try { if (out.supported) out.persisted = (await s.persisted()) === true; } catch { out.persisted = null; }
  try { if (s && typeof s.estimate === "function") { const e = await s.estimate(); out.usage = e.usage ?? null; out.quota = e.quota ?? null; } } catch { /* 分からなければ出さない */ }
  return out;
}
