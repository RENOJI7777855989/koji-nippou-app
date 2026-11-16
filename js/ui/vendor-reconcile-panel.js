/* ==========================================================
   業者管理の［照合・PDF］［業者名の確認］タブ（2026-11-16）
   ・照合・PDF: 請求人工と実稼働人日の照合表（業者別／棟別／業者・棟別、職種別にも）と日付ごとの明細、
     業者ごとの請求人工PDF・業者別稼働PDF（1業者／全業者をまとめて）、照合表のPDF。
     計算は js/billing/billingReconcile.js、帳票は js/billing/vendorMonthSheets.js。日報・請求人工は書き換えない。
   ・業者名の確認: 表記の違う似た業者名の候補（自動ではまとめない）、利用者が確認した「同じ業者」「別の業者」の記録と解除
     （js/billing/vendorNames.js。現場の記録 site.vendorDirectory に保存）。内部の業者IDは画面に出さない。
   ========================================================== */

import { escapeHtml } from "../utils.js";
import { navigate } from "../router.js";
import { showMessage } from "./common.js";
import { hasPermission } from "../auth.js";
import { buildReconciliation, RECONCILE_VIEWS, RECONCILE_STATES, signedText, NO_BUILDING } from "../billing/billingReconcile.js";
import { collectVendorNames, vendorNameCandidates, pendingNameSet, mergeVendorNames, unmergeVendorName, setVendorDisplayName, markVendorsDistinct, clearVendorsDistinct, siteUsesBuildings } from "../billing/vendorNames.js";
import { monthVendors, buildVendorBillingSheet, buildVendorActivitySheet, buildReconcileSheetHtml, reconcileFileName, VENDOR_SHEET_PAPER, BILLING_SHEET_TITLE, ACTIVITY_SHEET_TITLE, RECONCILE_SHEET_TITLE, monthText } from "../billing/vendorMonthSheets.js";
import { openBoardPdfDialog } from "./board-pdf.js";
import { openReportPrintDialog } from "./report-print-dialog.js";

const md = (iso) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** 照合・名前の確認に使う値（画面を描くたびに日報・現場から作る） */
function namesData(state) {
  const names = collectVendorNames({ site: state.site, reports: state.reports, ky: state.ky || [], quoteBatches: state.quoteBatches || [] });
  const cand = vendorNameCandidates({ site: state.site, names });
  return { names, cand, pending: pendingNameSet(cand) };
}

/* ---------------- 照合・PDF ---------------- */
export function reconcileHtml(state) {
  const rcState = state.rc || (state.rc = { view: "vendor", byTrade: false, openKey: null, pdfVendor: "" });
  const { cand, pending } = namesData(state);
  const rc = buildReconciliation({ site: state.site, reports: state.reports, month: state.month, today: todayIso(), view: rcState.view, byTrade: rcState.byTrade, pendingNames: pending });
  const useB = rc.usesBuildings;
  const showV = rc.view !== "building", showB = rc.view !== "vendor", showT = rc.byTrade;
  const pendingPairs = cand.pending.filter((p) => p.affectsReports);
  const views = useB
    ? `<div class="vm-rc-views" role="group" aria-label="照合の単位">${RECONCILE_VIEWS.map((v) => `<button type="button" class="${v.value === rc.view ? "" : "secondary-btn "}vm-rc-view" data-rc-view="${v.value}" aria-pressed="${v.value === rc.view}">${v.label}</button>`).join("")}</div>`
    : `<p class="empty-message">この現場は棟を使わない設定です（業者ごとに照合します。棟を使う現場にするときは、現場情報の編集の「棟・工種の一覧」で設定します）。</p>`;
  const counts = Object.entries(RECONCILE_STATES).filter(([k]) => rc.counts[k]).map(([k, l]) => `<span class="vm-rc-count st-${k}">${l} ${rc.counts[k]}</span>`).join("");
  const colCount = (showV ? 1 : 0) + (showB ? 1 : 0) + (showT ? 1 : 0) + 6;
  const head = `${showV ? "<th>業者</th>" : ""}${showB ? "<th>棟</th>" : ""}${showT ? "<th>職種</th>" : ""}<th class="num">稼働日数</th><th class="num">延べ稼働人数</th><th class="num">実稼働人日</th><th class="num">請求人工</th><th class="num">差異<br><small>（請求−実稼働）</small></th><th>照合状態</th>`;
  const body = rc.rows.map((r) => {
    const open = rcState.openKey === r.key;
    const label = [showV ? r.vendorName : "", showB ? r.buildingLabel || NO_BUILDING : "", showT ? r.trade : ""].filter(Boolean).join("／");
    const names = showV && r.rawNames.length > 1 ? `<br><small class="dash-sub">日報の表記: ${escapeHtml(r.rawNames.join("・"))}</small>` : "";
    const first = `<button type="button" class="link-btn vm-rc-row" data-rc-key="${escapeHtml(r.key)}" aria-expanded="${open}">${escapeHtml(showV ? r.vendorName : showB ? r.buildingLabel || NO_BUILDING : r.trade)} ${open ? "▲" : "▼"}</button>${names}`;
    const cells = [];
    if (showV) cells.push(`<td>${first}</td>`);
    if (showB) cells.push(`<td>${showV ? escapeHtml(r.buildingLabel || NO_BUILDING) : first}</td>`);
    if (showT) cells.push(`<td>${escapeHtml(r.trade)}</td>`);
    const detail = open ? `<tr class="vm-rc-detail"><td colspan="${colCount}">${dayDetailHtml(r, label)}</td></tr>` : "";
    return `<tr class="vm-rc-unit st-${r.state}" data-rc-unit="${escapeHtml(r.key)}">${cells.join("")}<td class="num">${r.workDays}日</td><td class="num">${r.workers}人</td><td class="num"><b>${r.manDays}</b></td><td class="num"><b>${r.billing == null ? "未入力" : escapeHtml(r.billing)}</b></td><td class="num vm-rc-diff">${escapeHtml(signedText(r.diffCents, r.billing))}</td><td class="vm-rc-state">${escapeHtml(r.stateLabel)}${r.missingRows + r.invalidRows ? `<br><small>未入力 ${r.missingRows + r.invalidRows}件</small>` : ""}</td></tr>${detail}`;
  }).join("");
  const t = rc.totals;
  const table = rc.rows.length
    ? `<div class="dash-table-wrap"><table class="dash-table vm-table vm-rc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>
        <tfoot><tr><th colspan="${colCount - 6 || 1}">合計</th><td class="num">—</td><td class="num">${t.workers}人</td><td class="num"><b>${t.manDays}</b></td><td class="num"><b>${escapeHtml(t.billing)}</b></td><td class="num">${escapeHtml(signedText(t.diffCents))}</td><td></td></tr></tfoot></table></div>`
    : `<p class="empty-message">${monthText(state.month)}の稼働・請求人工の記録はありません。</p>`;
  return `<p class="vm-lead">${monthText(state.month)}（${md(rc.cutoff)}までの日報）の、請求人工（請求人工欄に入力された値）と実稼働人日（通常作業の日報の稼働人数。1人＝1人日）の照合です。差異があっても日報・請求人工は変更しません。行を押すと日付ごとの明細を表示します。</p>
    ${pendingPairs.length ? `<p class="billing-warn vm-rc-pending">業者名確認待ちがあります（${pendingPairs.map((p) => `${escapeHtml(p.a)} と ${escapeHtml(p.b)}`).join("、")}）。同じ業者かどうか確認するまで、この業者は照合しません。<button type="button" class="secondary-btn vm-goto-names">業者名の確認へ</button></p>` : ""}
    ${views}
    <label class="vm-rc-bytrade"><input type="checkbox" class="vm-rc-trade"${rc.byTrade ? " checked" : ""}> 職種別に分ける</label>
    <p class="vm-rc-counts">${counts}</p>
    ${table}
    <p class="empty-message">照合状態: 一致＝請求人工の合計と実稼働人日が同じ／差異あり＝違う（差異＝請求人工−実稼働人日。請求人工が未入力の行は「—」。合計の差異は未入力の業者の実稼働も含みます）／未入力あり＝稼働した日の請求人工に未入力（または決まりに合わない値）がある（未入力は0にしていません）／未照合＝この月の請求人工が1件も入力されていない／棟未設定＝棟が選ばれていない作業行／業者名確認待ち＝表記の違う似た業者名が未確認。実稼働人日は業者別稼働の実績人工と同じ決まりです（現場作業なし・休工日・雨天作業不可日・事務作業日、工期開始日より前は数えません）。</p>
    ${pdfSectionHtml(state)}`;
}

function dayDetailHtml(r, label) {
  if (!r.days.length) return `<span class="empty-message">記録はありません。</span>`;
  return `<p class="vm-rc-detail-title">${escapeHtml(label)} の日付ごとの明細</p>
    <table class="dash-table vm-table vm-rc-days"><thead><tr><th>日付</th><th>日の状態</th><th class="num">実稼働人日</th><th class="num">請求人工</th><th class="num">差異</th><th>備考</th></tr></thead>
    <tbody>${r.days.map((d) => `<tr class="${d.hasGap ? "vm-rc-gap" : ""}"><td><button type="button" class="link-btn vm-rc-report" data-report-id="${escapeHtml(d.reportIds[0])}" data-cids="${escapeHtml(d.companyIds.join(","))}">${md(d.date)}</button>${d.reportIds.length > 1 ? `<br><small>日報 ${d.reportIds.length}件を合算</small>` : ""}</td><td>${escapeHtml(d.work ? "通常作業" : d.dayStatusLabel)}</td><td class="num">${d.manDays}</td><td class="num">${d.billing == null ? "未入力" : escapeHtml(d.billing)}</td><td class="num">${escapeHtml(signedText(d.diffCents, d.billing))}</td><td>${escapeHtml([d.missingRows ? `請求人工 未入力 ${d.missingRows}件` : "", d.invalidRows ? `請求人工 要確認 ${d.invalidRows}件` : "", !d.work && d.billingRows ? "稼働に数えない日の請求人工" : ""].filter(Boolean).join("・"))}</td></tr>`).join("")}</tbody></table>
    <p class="empty-message">日付を押すと、その日の日報を開きます（直すときは日報で修正してください）。</p>`;
}

function pdfSectionHtml(state) {
  const vendors = monthVendors({ site: state.site, reports: state.reports, month: state.month, today: todayIso() });
  const sel = state.rc.pdfVendor && vendors.some((v) => v.vendorId === state.rc.pdfVendor) ? state.rc.pdfVendor : "";
  return `<section class="vm-pdf">
    <h3>PDF出力（${monthText(state.month)}）</h3>
    <label class="vm-pdf-vendor">業者 <select class="vm-pdf-vendor-select" aria-label="PDFを作る業者"><option value="">全業者（業者ごとに別のファイル）</option>${vendors.map((v) => `<option value="${escapeHtml(v.vendorId)}"${v.vendorId === sel ? " selected" : ""}>${escapeHtml(v.vendorName)}</option>`).join("")}</select></label>
    <div class="vm-pdf-actions">
      <button type="button" class="vm-pdf-btn" data-pdf="billing">📄 請求人工PDF（業者別）</button>
      <button type="button" class="vm-pdf-btn" data-pdf="activity">📄 業者別稼働PDF（業者別）</button>
      <button type="button" class="secondary-btn vm-pdf-btn" data-pdf="reconcile">📄 照合表をPDF出力（表示中の単位）</button>
    </div>
    <p class="empty-message">請求人工PDFと業者別稼働PDFは別々のファイルです（請求人工PDFに稼働人数、業者別稼働PDFに請求人工は載せません）。全業者のときは業者ごとに1ファイルずつ作り、［共有］でまとめて渡すか、［ZIPで保存］で保存します。A4横です。</p>
  </section>`;
}

async function makePdf(kind, state) {
  const today = todayIso();
  const base = { site: state.site, reports: state.reports, month: state.month, today };
  if (kind === "reconcile") {
    const { pending } = namesData(state);
    const rc = buildReconciliation({ ...base, view: state.rc.view, byTrade: state.rc.byTrade, pendingNames: pending });
    const html = buildReconcileSheetHtml({ site: state.site, reconciliation: rc });
    const fileName = reconcileFileName(state.site.name, state.month);
    await openBoardPdfDialog({ html, fileName, paper: VENDOR_SHEET_PAPER, heading: `${RECONCILE_SHEET_TITLE}のPDF（A4横）`, source: "保存済みの日報から作った照合表です（日報・請求人工は変更していません）。PDFの文字は画像のため、選択・検索はできません。",
      onPrint: () => openReportPrintDialog({ html, mode: "print", title: `${RECONCILE_SHEET_TITLE}（${monthText(state.month)}）A4横`, note: "03-2の日報とは別の帳票で、日報の印刷記録には残りません。" }) });
    return;
  }
  const vendors = monthVendors(base).filter((v) => (kind === "billing" ? v.billingRows > 0 || v.workRows > 0 : v.workRows > 0));
  const targets = state.rc.pdfVendor ? vendors.filter((v) => v.vendorId === state.rc.pdfVendor) : vendors;
  if (!targets.length) { showMessage(kind === "billing" ? `${monthText(state.month)}の請求人工の記録がある業者はありません。` : `${monthText(state.month)}に稼働した業者はありません。`, true); return; }
  const build = kind === "billing" ? buildVendorBillingSheet : buildVendorActivitySheet;
  const items = targets.map((v) => { const s = build({ ...base, vendorId: v.vendorId }); return { html: s.html, fileName: s.fileName }; });
  const title = kind === "billing" ? BILLING_SHEET_TITLE : ACTIVITY_SHEET_TITLE;
  const kindName = kind === "billing" ? "請求人工" : "業者別稼働";
  await openBoardPdfDialog({
    items,
    zipName: `${kindName}_${monthText(state.month)}_${items.length}社.zip`,
    paper: VENDOR_SHEET_PAPER,
    heading: `${title}のPDF（A4横・${items.length}業者）`,
    source: kind === "billing"
      ? "保存済みの日報の請求人工欄の値だけです（稼働人数は載せません。未入力は「未入力」と表示し、合計に含めません）。PDFの文字は画像のため、選択・検索はできません。"
      : "保存済みの日報の稼働人数（実績人数）です（請求人工は載せません。1人＝1人日）。PDFの文字は画像のため、選択・検索はできません。",
    onPrint: items.length === 1 ? () => openReportPrintDialog({ html: items[0].html, mode: "print", title: `${title}（${monthText(state.month)}）A4横`, note: "03-2の日報とは別の帳票で、日報の印刷記録には残りません。" }) : null
  });
}

/* ---------------- 業者名の確認 ---------------- */
const infoText = (x) => !x ? "" : [
  x.reportRows ? `日報 ${x.reportRows}行・${x.reportDays}日（${md(x.firstDate)}〜${md(x.lastDate)}）` : "日報には無い名前",
  x.trades?.length ? `職種: ${x.trades.join("・")}` : "",
  x.ky ? `KY ${x.ky}件` : "",
  x.billingStatus ? `請求状況 ${x.billingStatus}か月` : "",
  x.quotes ? `業者見積 ${x.quotes}件` : ""
].filter(Boolean).join("／");

export function namesHtml(state) {
  const { names, cand } = namesData(state);
  const canEdit = hasPermission("editReports") && !state.site.completedAt;
  const dis = canEdit ? "" : " disabled";
  const levelLabel = { high: "表記違いの可能性が高い", medium: "名前の一部が同じ", low: "名前の先頭が同じ" };
  const pendingHtml = cand.pending.length
    ? cand.pending.map((p, i) => `<div class="vm-name-pair" data-pair="${i}">
        <p class="vm-name-level lv-${p.level}">${levelLabel[p.level]}${p.affectsReports ? "" : "（どちらかが日報に無い名前のため、集計には影響しません）"}</p>
        <ul class="vm-name-list"><li><b>${escapeHtml(p.a)}</b><br><small>${escapeHtml(infoText(p.aInfo))}</small></li><li><b>${escapeHtml(p.b)}</b><br><small>${escapeHtml(infoText(p.bInfo))}</small></li></ul>
        <p class="empty-message">${escapeHtml(p.reason)}。似ているだけでは同じ業者と決めません（営業所・別の会社の可能性もあります）。</p>
        <div class="vm-name-actions">
          <label>表示名 <select class="vm-merge-disp" aria-label="まとめたときの表示名"${dis}><option>${escapeHtml(p.a)}</option><option>${escapeHtml(p.b)}</option></select></label>
          <button type="button" class="vm-merge-pair" data-a="${escapeHtml(p.a)}" data-b="${escapeHtml(p.b)}"${dis}>同じ業者にまとめる</button>
          <button type="button" class="secondary-btn vm-distinct-pair" data-a="${escapeHtml(p.a)}" data-b="${escapeHtml(p.b)}"${dis}>別の業者</button>
        </div></div>`).join("")
    : `<p class="empty-message">確認待ちの業者名はありません。</p>`;
  const groupsHtml = cand.groups.length
    ? cand.groups.map((g) => `<div class="vm-name-group" data-group="${escapeHtml(g.id)}">
        <label>表示名 <select class="vm-group-disp" data-group-id="${escapeHtml(g.id)}" aria-label="表示名"${dis}>${g.names.map((n) => `<option${n === g.displayName ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></label>
        <ul class="vm-name-list">${g.info.map((x) => `<li><b>${escapeHtml(x.name)}</b><br><small>${escapeHtml(infoText(x))}</small> <button type="button" class="secondary-btn vm-unmerge" data-name="${escapeHtml(x.name)}"${dis}>まとめから外す</button></li>`).join("")}</ul>
      </div>`).join("")
    : `<p class="empty-message">まとめた業者はありません。</p>`;
  const distinctHtml = cand.decidedDistinct.length
    ? `<ul class="vm-name-list">${cand.decidedDistinct.map((d) => `<li>${escapeHtml(d.a)} と ${escapeHtml(d.b)}（別の業者）<button type="button" class="secondary-btn vm-undistinct" data-a="${escapeHtml(d.a)}" data-b="${escapeHtml(d.b)}"${dis}>記録を取り消す</button></li>`).join("")}</ul>`
    : `<p class="empty-message">ありません。</p>`;
  const listHtml = names.length
    ? `<div class="dash-table-wrap"><table class="dash-table vm-table vm-names-table"><thead><tr><th>選ぶ</th><th>業者名（日報などの表記のまま）</th><th>使われている所</th></tr></thead>
        <tbody>${names.map((x) => `<tr><td><input type="checkbox" class="vm-name-pick" value="${escapeHtml(x.name)}" aria-label="${escapeHtml(x.name)}を選ぶ"${dis}></td><td>${escapeHtml(x.name)}</td><td><small>${escapeHtml(infoText(x))}</small></td></tr>`).join("")}</tbody></table></div>
       <button type="button" class="vm-merge-picked"${dis}>選んだ名前を同じ業者にまとめる</button>`
    : `<p class="empty-message">この現場の業者名はまだありません。</p>`;
  return `<p class="vm-lead">表記の違う似た業者名（例: 株式会社○○／（株）○○／○○）の候補です。<b>自動ではまとめません。</b>同じ業者と確認した名前だけを、照合・業者ごとのPDFで1つの業者として数えます。日報に書かれた業者名はそのまま残ります（書き換えません）。業者管理の業者別稼働・請求人工管理の表、ダッシュボード、03-2 は従来どおり業者名ごとです。</p>
    ${state.site.completedAt ? `<p class="billing-warn">工事完了の現場のため、確認結果は変更できません。</p>` : ""}
    <h3>確認待ちの候補（${cand.pending.length}組）</h3>${pendingHtml}
    <h3>同じ業者としてまとめた名前</h3>${groupsHtml}
    <h3>別の業者と確認した組</h3>${distinctHtml}
    <h3>この現場の業者名の一覧（${names.length}件）</h3>
    <p class="empty-message">候補に出ない表記違い（漢字とカタカナなど）は、ここで2つ以上選んでまとめられます。</p>${listHtml}`;
}

/* ---------------- 操作 ---------------- */
/** @returns {Promise<boolean>} 処理したか */
export async function handlePanelClick(e, state, { render, reload }) {
  const rv = e.target.closest(".vm-rc-view");
  if (rv) { state.rc.view = rv.dataset.rcView; state.rc.openKey = null; render(); return true; }
  const row = e.target.closest(".vm-rc-row");
  if (row) { state.rc.openKey = state.rc.openKey === row.dataset.rcKey ? null : row.dataset.rcKey; render(); return true; }
  const rep = e.target.closest(".vm-rc-report");
  if (rep) { navigate(`/sites/${state.site.id}/report/${rep.dataset.reportId}?from=vendors${rep.dataset.cids ? `&hl=${encodeURIComponent(rep.dataset.cids)}` : ""}`); return true; }
  if (e.target.closest(".vm-goto-names")) { state.tab = "names"; render(); window.scrollTo(0, 0); return true; }
  const pdf = e.target.closest(".vm-pdf-btn");
  if (pdf) {
    pdf.disabled = true;
    try { await makePdf(pdf.dataset.pdf, state); } catch (err) { showMessage(err.message, true); } finally { pdf.disabled = false; }
    return true;
  }
  const act = async (fn, msg) => {
    try { await fn(); await reload(); if (msg) showMessage(msg); } catch (err) { showMessage(err.message, true); }
    return true;
  };
  const mp = e.target.closest(".vm-merge-pair");
  if (mp) {
    const disp = mp.closest(".vm-name-pair")?.querySelector(".vm-merge-disp")?.value || mp.dataset.a;
    if (!confirm(`「${mp.dataset.a}」と「${mp.dataset.b}」を同じ業者としてまとめます（表示名: ${disp}）。\n日報の業者名は変わりません。照合・業者ごとのPDFで1つの業者として数えます。あとで解除できます。`)) return true;
    return act(() => mergeVendorNames(state.site.id, [mp.dataset.a, mp.dataset.b], disp), `「${disp}」としてまとめました。`);
  }
  const dp = e.target.closest(".vm-distinct-pair");
  if (dp) return act(() => markVendorsDistinct(state.site.id, dp.dataset.a, dp.dataset.b), `「${dp.dataset.a}」と「${dp.dataset.b}」を別の業者として記録しました。`);
  const um = e.target.closest(".vm-unmerge");
  if (um) {
    if (!confirm(`「${um.dataset.name}」をまとめから外します（単独の業者に戻ります。日報は変わりません）。`)) return true;
    return act(() => unmergeVendorName(state.site.id, um.dataset.name), `「${um.dataset.name}」をまとめから外しました。`);
  }
  const ud = e.target.closest(".vm-undistinct");
  if (ud) return act(() => clearVendorsDistinct(state.site.id, ud.dataset.a, ud.dataset.b), "記録を取り消しました（また確認待ちの候補に出ます）。");
  if (e.target.closest(".vm-merge-picked")) {
    const picked = [...document.querySelectorAll(".vm-name-pick:checked")].map((x) => x.value);
    if (picked.length < 2) { showMessage("同じ業者にまとめる名前を2つ以上選んでください。", true); return true; }
    if (!confirm(`次の名前を同じ業者としてまとめます（表示名: ${picked[0]}。あとで変えられます）。\n${picked.join("\n")}\n日報の業者名は変わりません。`)) return true;
    return act(() => mergeVendorNames(state.site.id, picked, picked[0]), `「${picked[0]}」としてまとめました。`);
  }
  return false;
}

export async function handlePanelChange(e, state, { render, reload }) {
  const tr = e.target.closest(".vm-rc-trade");
  if (tr) { state.rc.byTrade = tr.checked; state.rc.openKey = null; render(); return true; }
  const pv = e.target.closest(".vm-pdf-vendor-select");
  if (pv) { state.rc.pdfVendor = pv.value; return true; }
  const gd = e.target.closest(".vm-group-disp");
  if (gd) {
    try { await setVendorDisplayName(state.site.id, gd.dataset.groupId, gd.value); await reload(); showMessage(`表示名を「${gd.value}」にしました。`); } catch (err) { showMessage(err.message, true); }
    return true;
  }
  return false;
}

export { siteUsesBuildings };
