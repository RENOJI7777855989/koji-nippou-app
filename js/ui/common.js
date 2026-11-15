/* ==========================================================
   画面共通のUI部品（ビュー切り替え・メッセージ表示）
   ========================================================== */

export function showView(viewId) {
  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.id !== viewId;
  });
}

const messageEl = document.getElementById("message");
let messageTimer = null;

/** duration: 表示する時間（ミリ秒。省略時は3秒）。帳票の出力後の注意など、長い文を読ませたいときだけ長くする（2026-11-01） */
export function showMessage(text, isError = false, duration = 3000) {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    messageEl.textContent = "";
    messageEl.classList.remove("error");
  }, duration);
}
