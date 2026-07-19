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

export function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    messageEl.textContent = "";
    messageEl.classList.remove("error");
  }, 3000);
}
