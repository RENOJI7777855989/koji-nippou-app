/* ==========================================================
   PWA登録（Service Worker登録・オフライン通知バー・更新通知）
   HTTPS環境またはlocalhostでのみService Workerは登録可能
   （ブラウザのセキュアコンテキスト要件）。それ以外の環境では
   静かに何もしない（アプリ本体の動作には影響しない）。
   ========================================================== */

const offlineBanner = document.getElementById("offlineBanner");

function updateOfflineBanner() {
  if (offlineBanner) offlineBanner.hidden = navigator.onLine;
}

window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner();

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            // 入力中のデータを失わせないよう自動リロードはせず、通知のみ行う
            import("./ui/common.js").then(({ showMessage }) => {
              showMessage("新しいバージョンがあります。ページを再読み込みしてください。");
            });
          }
        });
      });
    } catch (err) {
      console.error("Service Workerの登録に失敗しました", err);
    }
  });
}
