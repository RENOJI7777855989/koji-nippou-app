/* ==========================================================
   印刷の共通処理（印刷ダイアログ・帳票出力画面・見積比較で共用）
   データ（IndexedDB）には一切触れない。印刷用HTMLを扱うだけ。

   ■ 背景（印刷ボタンを押しても何も起きない問題）
     従来はプレビューの枠（iframe）に print() を命令するだけで、印刷画面が
     開いたかどうかを見ていなかった。iPadのホーム画面アプリ等でこの命令が
     効かない場合、エラーも出ず「何も起きない」ように見えていた。

   ■ 方式（2段構え）
     ① 通常の印刷: 枠に print() を命令し、印刷画面が開いた形跡を見張る
        （print() が印刷画面を閉じるまで戻らない／beforeprint・afterprint の合図）。
        形跡が無ければ「開けなかった可能性」として案内を出す。
        Safariは印刷画面を開いても合図を送らないことがあるため、失敗とは断定しない。
     ② 共有メニューから印刷: 印刷用HTMLを1つのファイルにして共有メニュー
        （Web Share API）へ渡す。iPadでは共有メニューの「プリント」から印刷・PDF保存できる
        （iPadのSafariのタブでは利用者が確認済み。ホーム画面アプリでは未確認）。
        共有メニューが使えない環境では、ファイルとして保存する。
     印刷用HTMLは画像をすべて data: で埋め込んでいるので、ファイルにしても表示が欠けない。
   ========================================================== */

const QUICK_RETURN_MS = 300; // これより速く print() が戻り、合図も無ければ「開いた形跡なし」
const WATCH_MS = 1500;

/** 枠（iframe）の読み込みを待つ（srcdoc を入れた直後に印刷すると白紙になるのを防ぐ） */
export function waitFrameLoaded(frame, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const doc = frame.contentDocument;
    if (doc && doc.readyState === "complete" && doc.body && doc.body.childElementCount > 0) { resolve(true); return; }
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { frame.removeEventListener("load", done); resolve(false); }, timeoutMs);
    frame.addEventListener("load", done, { once: true });
  });
}

/**
 * 枠（iframe）の中身を印刷する。印刷画面が開いた形跡があったかを返す。
 * @param {HTMLIFrameElement} frame
 * @param {{onInvoked?: () => (void|Promise<void>)}} [options] onInvoked: print() を命令した直後に呼ぶ
 *   （PDF出力日時の記録など。形跡を見張る待ち時間の前に済ませ、途中で画面を閉じても抜けないようにする）
 * @returns {Promise<{opened: boolean, error?: string}>}
 *   opened=false は「開けなかった可能性がある」（Safariでは開いても合図が無いことがある）
 */
export async function printFrame(frame, { onInvoked } = {}) {
  const win = frame?.contentWindow;
  if (!win) return { opened: false, error: "印刷対象がありません" };
  let signaled = false;
  const onSignal = () => { signaled = true; };
  try {
    win.addEventListener("beforeprint", onSignal);
    win.addEventListener("afterprint", onSignal);
  } catch { /* 合図が取れない環境でも印刷は試みる */ }
  const t0 = performance.now();
  let error = "";
  try {
    win.focus();
    win.print();
  } catch (err) {
    error = err?.message || "印刷の命令に失敗しました";
  }
  const elapsed = performance.now() - t0;
  if (!error && onInvoked) await onInvoked();
  // print() が印刷画面を閉じるまで戻らなかった＝印刷画面が開いていた
  if (!error && elapsed >= QUICK_RETURN_MS) signaled = true;
  if (!signaled && !error) await new Promise((r) => setTimeout(r, WATCH_MS));
  try {
    win.removeEventListener("beforeprint", onSignal);
    win.removeEventListener("afterprint", onSignal);
  } catch { /* 枠が閉じられていても問題ない */ }
  return { opened: signaled && !error, error: error || undefined };
}

const HTML_TYPE = "text/html";

/** ファイル名に使えない文字を除く */
export function printFileName(title, ext = "html") {
  const base = String(title || "印刷").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "印刷";
  return `${base}.${ext}`;
}

/** 共有メニューへファイルを渡せる環境か */
export function canSharePrintFile() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    return navigator.canShare({ files: [new File(["<p></p>"], "check.html", { type: HTML_TYPE })] });
  } catch {
    return false;
  }
}

/**
 * 印刷用HTMLを共有メニューへ渡す（利用者がボタンを押した直後に呼ぶこと。
 * 間に時間のかかる処理を挟むと、ブラウザが共有を許可しない）。
 * @returns {Promise<"shared"|"cancelled"|"unsupported"|"failed">}
 */
export async function sharePrintHtml(html, title) {
  if (!canSharePrintFile()) return "unsupported";
  const file = new File([html], printFileName(title), { type: HTML_TYPE });
  try {
    await navigator.share({ files: [file], title: String(title || "印刷") });
    return "shared";
  } catch (err) {
    return err?.name === "AbortError" ? "cancelled" : "failed";
  }
}

/** 印刷用HTMLをファイルとして保存する（共有メニューが使えない環境向け） */
export function downloadPrintHtml(html, title) {
  const url = URL.createObjectURL(new Blob([html], { type: `${HTML_TYPE};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = printFileName(title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 「開けなかった」とは断定しない（Safariは印刷画面を開いても合図を送らないことがある）
export const PRINT_NOT_OPENED_MESSAGE = "印刷画面を開けなかった可能性があります。印刷画面が表示されない場合は、共有メニューから印刷してください（「共有メニューから印刷」を押し、「プリント」を選びます）。";
export const PRINT_NOT_OPENED_MESSAGE_NO_SHARE = "印刷画面を開けなかった可能性があります。印刷画面が表示されない場合は、「印刷用ファイルを保存」でファイルを保存し、開いたファイルから印刷してください。";
