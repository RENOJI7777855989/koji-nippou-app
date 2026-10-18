/* ==========================================================
   印刷・PDF出力の確認ダイアログ（日報1件／まとめて出力／台帳／今日の現場シートで共用）
   印刷用HTMLをプレビューし、ブラウザの印刷画面を開く。ブラウザは
   「実際に紙に印刷したか」「PDFを保存したか」をアプリに知らせない
   ため、印刷は利用者が「紙に印刷できた」を押したときだけ記録する。
   PDF出力は、印刷画面（PDFに保存）を開いた時点を出力日時として記録する。

   印刷画面が開いたかどうかを見張り、開いた形跡が無ければ案内を出す（何も起きない
   状態にしない）。iPadのホーム画面アプリ等で印刷画面が開かない場合のために、
   「印刷画面を開く」の隣に「共有メニューから印刷」（使えない環境では「印刷用ファイルを保存」）を常に表示する。
   共通の処理は js/printSupport.js。
   ========================================================== */

import {
  printFrame,
  canSharePrintFile,
  sharePrintHtml,
  downloadPrintHtml,
  PRINT_NOT_OPENED_MESSAGE,
  PRINT_NOT_OPENED_MESSAGE_NO_SHARE
} from "../printSupport.js";
import { buildCompanyOnePagePdf, isCompanySheetHtml } from "./company-pdf.js";
import { canSharePdf } from "./board-pdf.js";

const dialog = document.getElementById("reportPrintDialog");
const titleEl = document.getElementById("reportPrintTitle");
const noteEl = document.getElementById("reportPrintNote");
const frame = document.getElementById("reportPrintFrame");
const openBtn = document.getElementById("reportPrintOpenBtn");
const statusEl = document.getElementById("reportPrintStatus");
const shareBtn = document.getElementById("reportPrintShareBtn");
const saveBtn = document.getElementById("reportPrintSaveBtn");
const recordArea = document.getElementById("reportPrintRecordArea");
const printedBtn = document.getElementById("reportPrintDoneBtn");
const notPrintedBtn = document.getElementById("reportPrintNotDoneBtn");
const closeBtn = document.getElementById("reportPrintCloseBtn");
const onePageArea = document.getElementById("reportOnePageArea");
const onePageBtn = document.getElementById("reportOnePageBtn");
const onePageShareBtn = document.getElementById("reportOnePageShareBtn");
const onePageSaveBtn = document.getElementById("reportOnePageSaveBtn");
let onePageFile = null; // 作った1ページのPDF（このダイアログを開いている間だけ）

let current = null;
let frameLoaded = null; // 開くたびに、新しい内容の読み込み完了を待つ

function watchFrameLoad() {
  frameLoaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    frame.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function setStatus(text, warn = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.classList.toggle("is-warn", !!warn);
  if (text) statusEl.scrollIntoView({ block: "nearest" }); // iPadで画面の外に出て見落とさないように
}

/** 印刷（または共有からの印刷）を試みた後の処理。PDFは出力日時を記録、印刷は「紙に印刷できたか」を聞く。
 *  opts は操作した時点のもの（記録の途中でダイアログが閉じられても、PDF出力の記録は抜けない） */
async function afterPrintAttempt(opts) {
  if (!opts) return;
  if (opts.mode === "pdf") {
    if (opts.onPdfOpened) await opts.onPdfOpened();
  } else if (current === opts) {
    recordArea.hidden = false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.html 印刷用HTML
 * @param {"print"|"reprint"|"pdf"} opts.mode
 * @param {string} opts.title
 * @param {string} [opts.note] 補足（使った様式など）
 * @param {() => Promise<void>} [opts.onPrinted] 「紙に印刷できた」を押したとき
 * @param {() => Promise<void>} [opts.onPdfOpened] PDF用に印刷画面を開いたとき
 * @param {string} [opts.onePagePdfName] 会社指定様式のとき、1日報1ページのPDFのファイル名（拡張子なし）。
 *   指定があり、印刷用HTMLが会社指定様式の紙面なら「1ページのPDFを作成（A3）」を出す（台帳の印刷には指定しない）
 */
export function openReportPrintDialog(opts) {
  current = opts;
  titleEl.textContent = opts.title;
  const isPdf = opts.mode === "pdf";
  noteEl.textContent = [
    isPdf
      ? "「印刷画面を開く」を押し、印刷先で「PDFに保存」を選んでください。用紙サイズ・向きは帳票の設定（会社指定様式ならその様式の設定）に従います。"
      : "「印刷画面を開く」で印刷してください。印刷後、紙に印刷できたかを下のボタンで記録します（ブラウザからは印刷できたかどうかが分からないため）。",
    opts.note || "",
    // 会社様式の印刷のレイアウトの版（iPad で新しい版が読み込まれているかを確かめるため。印刷用HTMLの meta から読む）
    (/<meta name="print-layout-version" content="([^"]+)">/.exec(opts.html || "") || [])[1] ? `（印刷レイアウト ${(/<meta name="print-layout-version" content="([^"]+)">/.exec(opts.html) || [])[1]}）` : ""
  ].filter(Boolean).join(" ");
  openBtn.textContent = isPdf ? "印刷画面を開く（PDFに保存）" : opts.mode === "reprint" ? "印刷画面を開く（再印刷）" : "印刷画面を開く";
  const share = canSharePrintFile();
  shareBtn.hidden = !share;
  saveBtn.hidden = share;
  recordArea.hidden = true;
  onePageFile = null;
  onePageArea.hidden = !(opts.onePagePdfName && isCompanySheetHtml(opts.html));
  onePageBtn.disabled = false;
  onePageShareBtn.hidden = true;
  onePageSaveBtn.hidden = true;
  setStatus("");
  watchFrameLoad();
  frame.srcdoc = opts.html;
  dialog.showModal();
}

openBtn.addEventListener("click", async () => {
  if (!current) return;
  const opts = current;
  setStatus("");
  openBtn.disabled = true;
  try {
    await frameLoaded;
    // print() を命令した直後に記録・記録欄の表示をする（従来と同じ時点。形跡を見張る待ち時間の前）
    const result = await printFrame(frame, { onInvoked: () => afterPrintAttempt(opts) });
    if (current !== opts) return; // 待っている間に閉じられた
    if (!result.opened) setStatus(shareBtn.hidden ? PRINT_NOT_OPENED_MESSAGE_NO_SHARE : PRINT_NOT_OPENED_MESSAGE, true);
  } finally {
    openBtn.disabled = false;
  }
});

// 共有メニューへは、ボタンを押した直後に渡す必要がある（間に待ちを挟まない）
shareBtn.addEventListener("click", async () => {
  if (!current) return;
  const opts = current;
  const r = await sharePrintHtml(opts.html, opts.title);
  if (current !== opts) return;
  if (r === "shared") {
    setStatus("共有メニューを閉じました。「プリント」から印刷・PDF保存した場合は、下のボタンで記録してください。");
    await afterPrintAttempt(opts);
  } else if (r === "cancelled") {
    setStatus("共有メニューが閉じられました。もう一度「共有メニューから印刷」を押すと、やり直せます。");
  } else if (r === "unsupported") {
    downloadPrintHtml(opts.html, opts.title);
    setStatus("この環境では共有メニューを使えないため、印刷用ファイルを保存しました。開いたファイルから印刷してください。");
  } else {
    setStatus("共有メニューを開けませんでした。「印刷用ファイルを保存」で保存したファイルから印刷してください。", true);
    saveBtn.hidden = false;
  }
});

saveBtn.addEventListener("click", () => {
  if (!current) return;
  downloadPrintHtml(current.html, current.title);
  setStatus("印刷用ファイルを保存しました。保存したファイルを開き、そこから印刷してください。");
});

printedBtn.addEventListener("click", async () => {
  if (current?.onPrinted) await current.onPrinted();
  recordArea.hidden = true;
  dialog.close();
});

notPrintedBtn.addEventListener("click", () => {
  recordArea.hidden = true;
});

// 1日報1ページのPDF（会社指定様式）。作成と共有は別のボタン（共有はボタンを押した直後に呼ぶ必要があるため）
onePageBtn.addEventListener("click", async () => {
  if (!current) return;
  const opts = current;
  onePageBtn.disabled = true;
  onePageShareBtn.hidden = true;
  onePageSaveBtn.hidden = true;
  setStatus("1ページのPDFを作成しています…（数秒かかります）");
  try {
    const { file, pages } = await buildCompanyOnePagePdf(opts.html, opts.onePagePdfName);
    if (current !== opts) return;
    onePageFile = file;
    const sharable = canSharePdf(file);
    onePageShareBtn.hidden = !sharable;
    onePageSaveBtn.hidden = false;
    onePageSaveBtn.classList.toggle("secondary-btn", sharable);
    setStatus(`作成しました: ${file.name}（A3・${pages}ページ（日報1件＝1ページ）、${Math.max(1, Math.round(file.size / 1024))}KB）。${sharable ? "［PDFを共有］→「プリント」で印刷、または「ファイルに保存」してください。" : "［PDFを保存］で保存し、保存したPDFから印刷してください。"}`);
  } catch (err) {
    if (current === opts) setStatus(`1ページのPDFを作成できませんでした: ${err.message}`, true);
  } finally {
    onePageBtn.disabled = false;
  }
});

onePageShareBtn.addEventListener("click", async () => {
  if (!current || !onePageFile) return;
  const opts = current;
  try {
    // ボタンを押した直後に呼ぶ（間に待ちを挟むと共有が許可されない）
    await navigator.share({ files: [onePageFile], title: onePageFile.name.replace(/\.pdf$/, "") });
    if (current !== opts) return;
    setStatus(opts.mode === "pdf" ? `共有しました: ${onePageFile.name}` : "共有メニューを閉じました。「プリント」から印刷した場合は、下のボタンで記録してください。");
    await afterPrintAttempt(opts);
  } catch (err) {
    if (err?.name === "AbortError") return; // 利用者が共有メニューを閉じた
    setStatus(`共有できませんでした（${err?.name || "エラー"}）。［PDFを保存］で保存してから印刷してください。`, true);
    onePageSaveBtn.hidden = false;
  }
});

onePageSaveBtn.addEventListener("click", async () => {
  if (!current || !onePageFile) return;
  const opts = current;
  const url = URL.createObjectURL(onePageFile);
  const a = document.createElement("a");
  a.href = url;
  a.download = onePageFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setStatus(`保存しました: ${onePageFile.name}。保存したPDFを開いて印刷できます。`);
  await afterPrintAttempt(opts);
});

closeBtn.addEventListener("click", () => dialog.close());

dialog.addEventListener("close", () => {
  frame.removeAttribute("srcdoc");
  setStatus("");
  current = null;
  onePageFile = null;
});
