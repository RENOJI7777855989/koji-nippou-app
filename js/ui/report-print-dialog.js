/* ==========================================================
   印刷・PDF出力の確認ダイアログ（日報1件／まとめて出力で共用）
   印刷用HTMLをプレビューし、ブラウザの印刷画面を開く。ブラウザは
   「実際に紙に印刷したか」「PDFを保存したか」をアプリに知らせない
   ため、印刷は利用者が「紙に印刷できた」を押したときだけ記録する。
   PDF出力は、印刷画面（PDFに保存）を開いた時点を出力日時として記録する。
   ========================================================== */

const dialog = document.getElementById("reportPrintDialog");
const titleEl = document.getElementById("reportPrintTitle");
const noteEl = document.getElementById("reportPrintNote");
const frame = document.getElementById("reportPrintFrame");
const openBtn = document.getElementById("reportPrintOpenBtn");
const recordArea = document.getElementById("reportPrintRecordArea");
const printedBtn = document.getElementById("reportPrintDoneBtn");
const notPrintedBtn = document.getElementById("reportPrintNotDoneBtn");
const closeBtn = document.getElementById("reportPrintCloseBtn");

let current = null;

/**
 * @param {object} opts
 * @param {string} opts.html 印刷用HTML
 * @param {"print"|"reprint"|"pdf"} opts.mode
 * @param {string} opts.title
 * @param {string} [opts.note] 補足（使った様式など）
 * @param {() => Promise<void>} [opts.onPrinted] 「紙に印刷できた」を押したとき
 * @param {() => Promise<void>} [opts.onPdfOpened] PDF用に印刷画面を開いたとき
 */
export function openReportPrintDialog(opts) {
  current = opts;
  titleEl.textContent = opts.title;
  const isPdf = opts.mode === "pdf";
  noteEl.textContent = [
    isPdf
      ? "「印刷画面を開く」を押し、印刷先で「PDFに保存」を選んでください。用紙サイズ・向きは帳票の設定（会社指定様式ならその様式の設定）に従います。"
      : "「印刷画面を開く」で印刷してください。印刷後、紙に印刷できたかを下のボタンで記録します（ブラウザからは印刷できたかどうかが分からないため）。",
    opts.note || ""
  ].filter(Boolean).join(" ");
  openBtn.textContent = isPdf ? "印刷画面を開く（PDFに保存）" : opts.mode === "reprint" ? "印刷画面を開く（再印刷）" : "印刷画面を開く";
  recordArea.hidden = true;
  frame.srcdoc = opts.html;
  dialog.showModal();
}

openBtn.addEventListener("click", async () => {
  if (!frame.contentWindow || !current) return;
  frame.contentWindow.focus();
  frame.contentWindow.print();
  if (current.mode === "pdf") {
    if (current.onPdfOpened) await current.onPdfOpened();
  } else {
    recordArea.hidden = false;
  }
});

printedBtn.addEventListener("click", async () => {
  if (current?.onPrinted) await current.onPrinted();
  recordArea.hidden = true;
  dialog.close();
});

notPrintedBtn.addEventListener("click", () => {
  recordArea.hidden = true;
});

closeBtn.addEventListener("click", () => dialog.close());

dialog.addEventListener("close", () => {
  frame.removeAttribute("srcdoc");
  current = null;
});
