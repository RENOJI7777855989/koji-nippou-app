/* ==========================================================
   朝礼入力（現場ダッシュボードの「🗣 朝礼入力」）
   朝礼で各業者から聞いた「今日の実績人数」を、業者の行ごとに続けて入力する画面。
   ・保存先は既存の日報の実績人数（companies[].actualWorkerCount）だけ。朝礼専用の人数データは作らない。
     作業人数（合計）workerCountTotal も日報画面と同じく実績人数の合計にそろえる。
   ・対象は表示している日の通常作業の日報の業者の行（業者＋工種は日報の行のまま。業者名から工種を決めない）。
     予定人数（plannedWorkerCount）・請求人工（billingManDays）・ほかの項目は書き換えない。
   ・空欄＝未入力、0＝0人（未入力を0人にしない）。
   ・日報が無い日は日報を作らない（日報の作成画面へ案内するだけ）。作業しない日・確定済みの日報は入力できない。
   ・03-2・現場掲示・業者別稼働・人工（1人＝1人工）は、日報の実績人数をそのまま使う既存の仕組みで反映される。
   ・請求人工（2026-11-15。利用者の指定）: 業者の行ごとに、今日の人数とは別に請求人工も入れられる。保存先は既存の日報の
     請求人工（companies[].billingManDays。以前の版の manDays も請求人工として読む）だけで、項目は増やさない（業者管理の
     請求人工入力・月間請求人工と同じ値）。人数から請求人工を決めない・人数に足さない。空欄＝未入力（0にしない）、
     値の決まりは日報画面・請求人工入力と同じ parseBillingInput（0以上・小数2桁まで）。値を変えた行だけ書き換える。
     請求人工はこの入力画面にだけ出し、現場掲示・A3・PDF（ダッシュボードの印刷）には出さない（印刷用HTMLは別に作る。従来どおり）。
   ・［📄 業者別稼働・請求人工 PDF出力］（2026-11-15）: 保存済みの日報を読み直して、業者の行ごとの稼働人数・請求人工の一覧を
     A4横のPDFにする（billing/dailyBillingSheet.js・board-pdf.js。プレビュー・共有・保存・印刷）。入力欄に保存していない
     変更があれば、PDFは作らずに「先に保存してください」と出す（入力中の値でPDFを作らない）。
   ========================================================== */

import { getReport, updateReport } from "../reports.js";
import { dayStatusOf, labelOf, DAY_STATUSES } from "../dashboard/dailyFlow.js";
import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { showMessage } from "./common.js";
import { parseBillingInput } from "../billing/billingValue.js";
import { getSite } from "../sites.js";
import { buildDailyBillingSheet, buildDailyBillingSheetHtml, DAILY_BILLING_PAPER, DAILY_BILLING_TITLE } from "../billing/dailyBillingSheet.js";
import { openBoardPdfDialog } from "./board-pdf.js";
import { openReportPrintDialog } from "./report-print-dialog.js";
import { printFileName } from "../printSupport.js";

const dialog = document.getElementById("choreiDialog");
const titleEl = document.getElementById("choreiTitle");
const bodyEl = document.getElementById("choreiBody");
const progressEl = document.getElementById("choreiProgress");
const saveBtn = document.getElementById("choreiSaveBtn");
const pdfBtn = document.getElementById("choreiPdfBtn");

let current = { siteId: "", date: "", reportId: "", onSaved: null };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dayTitle = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${m}月${d}日（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`; };
/** 業者の行の識別（companyId。無い古い行は並び順） */
const rowKey = (c, i) => c.companyId || `#${i}`;
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/** 0以上の整数か空欄。それ以外は null（入力の誤り） */
function readCount(input) {
  const raw = input.value.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)); // 全角数字も読む
  if (raw === "") return { value: "" };
  return /^\d+$/.test(raw) ? { value: String(Number(raw)) } : null;
}

const billingOf = (c) => String(c?.billingManDays ?? c?.manDays ?? ""); // 以前の版の manDays も請求人工として読む
const round2 = (n) => Math.round(n * 100) / 100;

function updateProgress() {
  const rows = [...bodyEl.querySelectorAll(".chorei-row")];
  let filled = 0, billed = 0, sumCount = 0, sumBilling = 0;
  for (const row of rows) {
    const r = readCount(row.querySelector(".chorei-count"));
    const state = !r ? "error" : r.value === "" ? "blank" : "done";
    row.dataset.state = state;
    row.querySelector(".chorei-state").textContent = state === "error" ? "0以上の整数" : state === "blank" ? "人数 未入力" : `${r.value}人`;
    if (state === "done") { filled++; sumCount += Number(r.value); }
    // 請求人工（人数とは別。人数から決めない）
    const b = parseBillingInput(row.querySelector(".chorei-billing").value);
    const bState = !b ? "error" : b.value === "" ? "blank" : "done";
    row.dataset.billingState = bState;
    row.querySelector(".chorei-bstate").textContent = bState === "error" ? "請求人工の誤り" : bState === "blank" ? "請求 未入力" : `請求 ${b.value}人工`;
    if (bState === "done") { billed++; sumBilling += Number(b.value); }
  }
  progressEl.innerHTML = rows.length
    ? `<span class="chorei-total">合計: 今日の人数 <b>${sumCount}</b>人・請求人工 <b>${round2(sumBilling)}</b>人工</span><br>人数 入力済み ${filled}／${rows.length}行・請求人工 入力済み ${billed}／${rows.length}行（空欄は未入力のまま保存します。0は「0」と入力。請求人工は小数2桁まで）`
    : "";
}

/**
 * @param {{site: object, date: string, reportId: string|null, onSaved?: () => Promise<void>|void}} p
 *   reportId はダッシュボードで表示している日の日報（同じ日に複数あれば最後に更新したもの）
 */
export async function openChoreiDialog({ site, date, reportId, sameDayCount = 1, onSaved }) {
  current = { siteId: site.id, date, reportId: reportId || "", onSaved };
  titleEl.textContent = `${dayTitle(date)}の朝礼入力（今日の人数・請求人工）`;
  saveBtn.hidden = true;
  if (pdfBtn) pdfBtn.hidden = true;
  progressEl.textContent = "";
  const report = reportId ? await getReport(reportId) : null;
  const goForm = (label) => `<button type="button" class="chorei-go" data-chorei-go="${report ? "edit" : "new"}">${label}</button>`;
  if (!report || report.isDeleted) {
    bodyEl.innerHTML = `<p class="chorei-note">この日の日報がまだありません。朝礼入力は日報の業者の行に人数を入れるため、先に日報を作成して業者（業者名・工種）を登録してください（自動では日報を作りません）。</p>${site.completedAt ? "" : goForm("この日の日報を作成する")}`;
  } else if (dayStatusOf(report) !== "work") {
    bodyEl.innerHTML = `<p class="chorei-note">この日の日報は「${escapeHtml(labelOf(DAY_STATUSES, dayStatusOf(report)))}」です。作業しない日のため、朝礼の実績人数は入力できません（現場作業員の稼働人数に数えない日です）。日の状態を変える場合は日報を開いてください。</p>${goForm("日報を開く")}`;
  } else if (report.finalizedAt || site.completedAt) {
    bodyEl.innerHTML = `<p class="chorei-note">工事完了により確定済みのため、人数は変更できません。</p>`;
  } else {
    const rows = (report.companies || []).map((c, i) => ({ c, key: rowKey(c, i) })).filter(({ c }) => (c.companyName || "").trim() || (c.occupation || "").trim());
    if (!rows.length) {
      bodyEl.innerHTML = `<p class="chorei-note">この日の日報に業者が登録されていません。日報を開いて、業者名・工種を登録してください（業者名から工種を自動では決めません）。</p>${goForm("日報を開いて業者を登録する")}`;
    } else {
      bodyEl.innerHTML = `${sameDayCount > 1 ? `<p class="chorei-note">この日の日報が${sameDayCount}件あります。最後に更新した日報（ダッシュボードに表示している日報）に入力します。</p>` : ""}
        <ol class="chorei-list">${rows.map(({ c, key }, i) => `
          <li class="chorei-row" data-key="${escapeHtml(key)}">
            <div class="chorei-who"><span class="chorei-vendor">${escapeHtml(c.companyName || "（業者名なし）")}</span><span class="chorei-trade">${escapeHtml(c.occupation || "工種なし")}</span></div>
            <div class="chorei-plan">予定 ${isBlank(c.plannedWorkerCount) ? "未入力" : `${escapeHtml(c.plannedWorkerCount)}人`}</div>
            <label class="chorei-input">今日の人数<input type="text" class="chorei-count" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="4" enterkeyhint="next" aria-label="${escapeHtml(`${c.companyName || ""} ${c.occupation || ""} の今日の実績人数`)}" value="${isBlank(c.actualWorkerCount) ? "" : escapeHtml(c.actualWorkerCount)}" data-orig="${isBlank(c.actualWorkerCount) ? "" : escapeHtml(String(c.actualWorkerCount).trim())}">人</label>
            <label class="chorei-input chorei-input-billing">請求人工<input type="text" class="chorei-billing" inputmode="decimal" autocomplete="off" maxlength="7" enterkeyhint="${i === rows.length - 1 ? "done" : "next"}" aria-label="${escapeHtml(`${c.companyName || ""} ${c.occupation || ""} の請求人工`)}" value="${escapeHtml(billingOf(c))}" data-orig="${escapeHtml(billingOf(c))}">人工</label>
            <span class="chorei-state"></span>
            <span class="chorei-bstate"></span>
            <button type="button" class="secondary-btn chorei-next" data-next="${i}">${i === rows.length - 1 ? "最後" : "次へ"}</button>
          </li>`).join("")}</ol>`;
      saveBtn.hidden = false;
      saveBtn.disabled = false;
      if (pdfBtn) { pdfBtn.hidden = false; pdfBtn.disabled = false; }
      updateProgress();
    }
  }
  dialog.showModal();
  bodyEl.querySelector(".chorei-row[data-state=blank] .chorei-count, .chorei-count")?.focus();
}

// 入力の順: 1行目の人数 → 1行目の請求人工 → 2行目の人数 → …
const allInputs = () => [...bodyEl.querySelectorAll(".chorei-count, .chorei-billing")];
const focusNext = (index) => {
  const inputs = allInputs();
  const next = inputs[index + 1];
  if (next) { next.focus(); next.select?.(); next.scrollIntoView({ block: "center" }); } else saveBtn.focus();
};

bodyEl?.addEventListener("input", updateProgress);
// 欄に移ったら中身を選択する（既に入っている人数をそのまま打ち直せる）
// select() はその欄へ入力の場所を移すので、少し後で実行する選択は「その欄にまだ入力の場所があり、まだ何も打っていない」ときだけ
// （すばやく次の欄へ移ったときに、前の欄へ入力の場所が戻って数字が前の欄に入る・消えるのを防ぐ）
bodyEl?.addEventListener("focusin", (e) => {
  const input = e.target;
  if (!input.classList.contains("chorei-count") && !input.classList.contains("chorei-billing")) return;
  const valueAtFocus = input.value;
  setTimeout(() => { if (document.activeElement === input && input.value === valueAtFocus) input.select(); }, 0);
});
bodyEl?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.target.classList.contains("chorei-count") || e.target.classList.contains("chorei-billing"))) return;
  e.preventDefault();
  focusNext(allInputs().indexOf(e.target));
});
bodyEl?.addEventListener("click", (e) => {
  const next = e.target.closest(".chorei-next");
  // ［次へ］はその行の請求人工の欄の次（＝次の行の人数）へ
  if (next) { focusNext(allInputs().indexOf(next.closest(".chorei-row").querySelector(".chorei-billing"))); return; }
  const go = e.target.closest("[data-chorei-go]");
  if (go) {
    dialog.close();
    navigate(go.dataset.choreiGo === "edit" ? `/sites/${current.siteId}/report/${current.reportId}` : `/sites/${current.siteId}/report/new?date=${current.date}`);
  }
});

saveBtn?.addEventListener("click", async () => {
  const edits = new Map();
  for (const row of bodyEl.querySelectorAll(".chorei-row")) {
    const input = row.querySelector(".chorei-count");
    const r = readCount(input);
    if (!r) { showMessage("実績人数は0以上の整数で入力してください（分からない業者は空欄のまま＝未入力）。", true); input.focus(); return; }
    const bInput = row.querySelector(".chorei-billing");
    const orig = bInput.dataset.orig ?? "";
    // 請求人工: 読み込んだときから変えていなければ、その値に触れない（以前の版の値・決まりに合わない古い値も自動では直さない）
    let billing = null;
    if (bInput.value.trim() !== orig) {
      const b = parseBillingInput(bInput.value);
      if (!b) { showMessage("請求人工は0以上の数で、小数は2桁まで（例 2・2.5）。分からない業者は空欄のまま＝未入力。", true); bInput.focus(); return; }
      billing = b.value;
    }
    edits.set(row.dataset.key, { count: r.value, billing });
  }
  saveBtn.disabled = true;
  try {
    // 保存の直前に日報を読み直し、実績人数と（変えた行の）請求人工だけを書き換える（予定人数・ほかの項目・ほかの行はそのまま）
    const fresh = await getReport(current.reportId);
    if (!fresh || fresh.isDeleted) throw new Error("日報が見つかりません（削除された可能性があります）。");
    if (dayStatusOf(fresh) !== "work") throw new Error("この日報は通常作業ではなくなったため、保存しませんでした。");
    let changed = 0;
    let countChanged = false;
    let missing = 0;
    const found = new Set();
    const companies = (fresh.companies || []).map((c, i) => {
      const key = rowKey(c, i);
      if (!edits.has(key)) return c;
      found.add(key);
      const { count, billing } = edits.get(key);
      const next = { ...c };
      let rowChanged = false;
      if (String(c.actualWorkerCount ?? "") !== count) { next.actualWorkerCount = count; rowChanged = true; countChanged = true; }
      if (billing !== null && billingOf(c) !== billing) { next.billingManDays = billing; rowChanged = true; }
      if (!rowChanged) return c;
      changed++;
      return next;
    });
    for (const k of edits.keys()) if (!found.has(k)) missing++;
    if (changed) {
      // 作業人数（合計）は日報画面と同じく、実績人数の入力がある行の合計（請求人工は足さない）
      const total = companies.reduce((s, c) => s + (isBlank(c.actualWorkerCount) ? 0 : Number(c.actualWorkerCount) || 0), 0);
      await updateReport(fresh.id, countChanged ? { companies, workerCountTotal: String(total) } : { companies });
    }
    dialog.close();
    showMessage(changed ? `朝礼の人数・請求人工を保存しました（${changed}行）。${missing ? `ほかの画面で削除された業者の行${missing}件は保存していません。` : ""}` : "変更はありませんでした。");
    if (current.onSaved) await current.onSaved();
  } catch (err) {
    showMessage(err.message, true);
    saveBtn.disabled = false;
  }
});

document.getElementById("choreiCloseBtn")?.addEventListener("click", () => dialog.close());

/** 入力欄に、保存していない変更があるか（読み込んだときの値 data-orig と比べる） */
export function choreiHasUnsavedChanges() {
  return [...bodyEl.querySelectorAll(".chorei-count, .chorei-billing")].some((el) => el.value.trim() !== (el.dataset.orig ?? ""));
}

// 業者別稼働・請求人工のPDF（A4横）。保存済みの日報だけから作る
pdfBtn?.addEventListener("click", async () => {
  if (choreiHasUnsavedChanges()) {
    showMessage("保存していない変更があります。先に［保存］を押してください（PDFは保存済みの日報から作ります）。", true);
    return;
  }
  pdfBtn.disabled = true;
  try {
    const [report, site] = await Promise.all([getReport(current.reportId), getSite(current.siteId)]);
    if (!report || report.isDeleted) throw new Error("日報が見つかりません（削除された可能性があります）。");
    const model = buildDailyBillingSheet({ site, report });
    const html = buildDailyBillingSheetHtml(model);
    const fileName = printFileName(`業者別稼働請求人工_${site?.name || "現場"}_${report.date}`, "pdf");
    await openBoardPdfDialog({
      html,
      fileName,
      paper: DAILY_BILLING_PAPER,
      heading: `${DAILY_BILLING_TITLE}のPDF（A4横）`,
      source: "保存済みの日報の、業者の行ごとの稼働人数（実績人数）と請求人工です。未入力は「未入力」と表示し、合計に含めません。PDFの文字は画像のため、選択・検索はできません。",
      onPrint: () => openReportPrintDialog({
        html,
        mode: "print",
        title: `${DAILY_BILLING_TITLE}（${report.date}）A4横・${model.pages.length}ページ`,
        note: "03-2の日報とは別の帳票で、日報の印刷記録には残りません。"
      })
    });
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    pdfBtn.disabled = false;
  }
});
