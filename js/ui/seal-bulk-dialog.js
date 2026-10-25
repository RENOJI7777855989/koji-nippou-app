/* ==========================================================
   日報カレンダーの「所長印を一括押印」（2026-10-25）
   ①選ぶ: 月ごとに保存済みの日報を並べ、チェックで選ぶ（月の未押印をまとめて選ぶ・選択の解除。月をまたいで選べる）。
      印の名前・押印済みの扱い（既定は押印済みを除外）・印の見本。
   ②確認: 押す日報の件数と日付、対象外（押印済み・確定済み）の件数と日付、印の見本。［押印する］で初めて書き込む。
   ③結果: 押印した・対象外・失敗の件数と日付。［元に戻す］で直前の一括押印を押印前に戻せる。
   書き込みは js/directorSealBulk.js（日報の directorSeal だけ。他の項目・写真・職長サインには触れない）。
   ========================================================== */

import { listReportsBySite } from "../reports.js";
import { applyBulkSeal, planBulkSeal, getLastBulkSeal, undoBulkSeal, defaultSealName } from "../directorSealBulk.js";
import { normalizeSealName, sealPngDataUrl } from "../report-output/directorSeal.js";
import { DAY_STATUSES, dayStatusOf } from "../dashboard/dailyFlow.js";
import { escapeHtml } from "../utils.js";
import { showMessage } from "./common.js";

const dialog = document.getElementById("sealBulkDialog");
const body = document.getElementById("sealBulkBody");
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const md = (iso) => { const d = new Date(`${iso}T00:00:00`); return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`; };
const dayLabel = (r) => DAY_STATUSES.find((s) => s.value === dayStatusOf(r))?.label || "";

let st = null; // { site, reports, month, selected:Set, name, overwrite, step, plan, expected, result, last, onDone }

const monthsOf = () => [...new Set(st.reports.map((r) => r.date.slice(0, 7)))].sort();

async function load() {
  st.reports = (await listReportsBySite(st.site.id)).filter((r) => !r.isDeleted && r.date).sort((a, b) => (a.date === b.date ? String(a.createdAt).localeCompare(String(b.createdAt)) : a.date.localeCompare(b.date)));
  st.last = await getLastBulkSeal(st.site.id);
}

function sealPreview(size = 64) {
  const name = normalizeSealName(st.name);
  return name ? `<img class="seal-bulk-preview" src="${sealPngDataUrl(name, 240)}" width="${size}" height="${size}" alt="所長印（${escapeHtml(name)}）">` : `<span class="seal-bulk-preview-empty">印の名前を入力してください</span>`;
}

function render() {
  if (st.step === "confirm") return renderConfirm();
  if (st.step === "result") return renderResult();
  const months = monthsOf();
  if (!months.includes(st.month)) st.month = months[months.length - 1] || st.month;
  const [y, m] = (st.month || "").split("-").map(Number);
  const rows = st.reports.filter((r) => r.date.slice(0, 7) === st.month);
  const lastHtml = st.last && !st.last.undoneAt
    ? `<p class="seal-bulk-last">前回の一括押印: ${new Date(st.last.at).toLocaleString("ja-JP")}・${escapeHtml(st.last.name)}・${st.last.items.length}件 <button type="button" class="secondary-btn" data-sb="undo">前回の一括押印を元に戻す</button></p>` : "";
  body.innerHTML = `
    <p class="hint">保存済みの日報を選んで、会社様式（03-2）の印刷・PDFの所長欄に電子印をまとめて押します。日報の内容・写真・職長サインは変わりません。押す前に確認画面が出ます。</p>
    <div class="seal-bulk-setting">
      <div>${sealPreview()}</div>
      <label>印の名前（4文字まで）<input type="text" id="sealBulkName" maxlength="8" autocomplete="off" value="${escapeHtml(st.name)}" placeholder="例）山田"></label>
      <fieldset class="seal-bulk-mode"><legend>押印済みの日報</legend>
        <label><input type="radio" name="sealBulkMode" value="skip"${st.overwrite ? "" : " checked"}> 対象外にする（押印済みはそのまま）</label>
        <label><input type="radio" name="sealBulkMode" value="overwrite"${st.overwrite ? " checked" : ""}> 押し直す（名前を上書き・位置はそのまま）</label>
      </fieldset>
    </div>
    ${lastHtml}
    <div class="seal-bulk-month">
      <button type="button" class="secondary-btn" data-sb="month" data-shift="-1" ${months.indexOf(st.month) <= 0 ? "disabled" : ""} aria-label="前の月">◀</button>
      <b>${y ? `${y}年${m}月` : "日報がありません"}</b>
      <button type="button" class="secondary-btn" data-sb="month" data-shift="1" ${months.indexOf(st.month) >= months.length - 1 ? "disabled" : ""} aria-label="次の月">▶</button>
    </div>
    <div class="seal-bulk-tools">
      <button type="button" class="secondary-btn" data-sb="selectMonth">この月の未押印をすべて選択</button>
      <button type="button" class="secondary-btn" data-sb="clearMonth">この月の選択を解除</button>
    </div>
    <ul class="seal-bulk-list">${rows.map((r) => {
      const sealed = r.directorSeal?.name;
      const locked = !!r.finalizedAt;
      return `<li><label class="${locked ? "is-locked" : ""}"><input type="checkbox" data-sb-id="${r.id}"${st.selected.has(r.id) ? " checked" : ""}${locked ? " disabled" : ""}>
        <span class="seal-bulk-date">${md(r.date)}</span><span class="seal-bulk-day">${escapeHtml(dayLabel(r))}</span>
        <span class="seal-bulk-state${sealed ? " is-sealed" : ""}">${locked ? "確定済み（押印できません）" : sealed ? `押印済み：${escapeHtml(r.directorSeal.name)}` : "未押印"}</span></label></li>`;
    }).join("") || "<li class=\"empty-message\">この月の日報はありません</li>"}</ul>
    <p class="seal-bulk-count">選択中 <b>${st.selected.size}</b>件${st.selected.size ? `（${[...st.selected].map((id) => st.reports.find((r) => r.id === id)?.date).filter(Boolean).sort().map((d) => md(d)).join("・")}）` : ""}</p>
    <div class="chorei-actions"><button type="button" class="secondary-btn" data-sb="close">閉じる</button><button type="button" data-sb="toConfirm"${st.selected.size ? "" : " disabled"}>確認へ（${st.selected.size}件）</button></div>`;
}

function renderConfirm() {
  const p = st.plan;
  const list = (arr) => arr.map((x) => md(x.report?.date ?? x.date)).join("・");
  const overwrites = p.targets.filter((t) => t.kind === "overwrite");
  body.innerHTML = `
    <div class="seal-bulk-setting"><div>${sealPreview(80)}</div><p>この印を、次の日報の所長欄に押します。</p></div>
    <dl class="seal-bulk-summary">
      <dt>押印する</dt><dd><b>${p.targets.length}件</b>${p.targets.length ? `（${list(p.targets)}）` : ""}</dd>
      ${overwrites.length ? `<dt>うち押し直し</dt><dd>${overwrites.length}件（${list(overwrites)}）</dd>` : ""}
      <dt>対象外</dt><dd>${p.skipped.length}件${p.skipped.length ? `（${p.skipped.map((s) => `${md(s.date)} ${escapeHtml(s.reason)}`).join("・")}）` : ""}</dd>
    </dl>
    <p class="hint">押した後は、印刷・PDF・まとめて印刷の所長欄に印が出ます（Excel出力には入りません）。結果の画面で［元に戻す］ができます。</p>
    <div class="chorei-actions"><button type="button" class="secondary-btn" data-sb="back">戻る</button><button type="button" data-sb="apply"${p.targets.length ? "" : " disabled"}>押印する（${p.targets.length}件）</button></div>`;
}

function renderResult() {
  const r = st.result;
  const fmt = (arr, reason) => arr.map((x) => `<li>${md(x.date)}${reason && x.reason ? `　${escapeHtml(x.reason)}` : ""}</li>`).join("");
  body.innerHTML = `
    <p class="seal-bulk-result-head">押印した <b>${r.done.length}</b>件・対象外 <b>${r.skipped.length}</b>件・失敗 <b class="${r.failed.length ? "warn" : ""}">${r.failed.length}</b>件</p>
    ${r.done.length ? `<h4>押印した日報</h4><ul class="seal-bulk-res">${fmt(r.done)}</ul>` : ""}
    ${r.skipped.length ? `<h4>対象外</h4><ul class="seal-bulk-res">${fmt(r.skipped, true)}</ul>` : ""}
    ${r.failed.length ? `<h4>失敗（押印していません）</h4><ul class="seal-bulk-res is-failed">${fmt(r.failed, true)}</ul>` : ""}
    ${r.undo ? `<p class="hint">元に戻しました: ${r.undo.restored.length}件${r.undo.skipped.length ? `（戻さなかった日報: ${r.undo.skipped.map((s) => `${md(s.date)} ${escapeHtml(s.reason)}`).join("・")}）` : ""}</p>` : ""}
    <div class="chorei-actions">${r.batchId && !r.undo ? `<button type="button" class="secondary-btn" data-sb="undoThis">元に戻す</button>` : ""}<button type="button" data-sb="close">閉じる</button></div>`;
}

dialog?.addEventListener("input", (e) => {
  if (e.target.id === "sealBulkName") { st.name = e.target.value; const pv = body.querySelector(".seal-bulk-setting > div"); if (pv) pv.innerHTML = sealPreview(); }
});
dialog?.addEventListener("change", (e) => {
  if (e.target.name === "sealBulkMode") { st.overwrite = e.target.value === "overwrite"; return; }
  const id = e.target.dataset?.sbId;
  if (!id) return;
  if (e.target.checked) st.selected.add(id); else st.selected.delete(id);
  render();
});
dialog?.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sb]");
  if (!b) return;
  const act = b.dataset.sb;
  if (act === "close") { dialog.close(); return; }
  if (act === "month") { const ms = monthsOf(); st.month = ms[Math.max(0, Math.min(ms.length - 1, ms.indexOf(st.month) + Number(b.dataset.shift)))]; render(); return; }
  if (act === "selectMonth") { st.reports.filter((r) => r.date.slice(0, 7) === st.month && !r.finalizedAt && !r.directorSeal?.name).forEach((r) => st.selected.add(r.id)); render(); return; }
  if (act === "clearMonth") { st.reports.filter((r) => r.date.slice(0, 7) === st.month).forEach((r) => st.selected.delete(r.id)); render(); return; }
  if (act === "toConfirm") {
    const name = normalizeSealName(st.name);
    if (!name) { showMessage("印の名前を入力してください。", true); body.querySelector("#sealBulkName")?.focus(); return; }
    st.name = name;
    await load(); // 確認画面は最新の日報で作る
    st.plan = planBulkSeal(st.reports, [...st.selected], { overwrite: st.overwrite });
    st.expected = Object.fromEntries(st.plan.targets.map((t) => [t.report.id, t.report.updatedAt]));
    st.step = "confirm"; render(); return;
  }
  if (act === "back") { st.step = "select"; render(); return; }
  if (act === "apply") {
    b.disabled = true;
    try {
      st.result = await applyBulkSeal({ siteId: st.site.id, reportIds: [...st.selected], name: st.name, overwrite: st.overwrite, expected: st.expected });
      try { localStorage.setItem("kojiNippou.directorSealName", st.name); } catch { /* 保存できない端末でも動く */ }
      if (st.result.done.length) st.selected.clear();
    } catch (err) { showMessage(err.message, true); b.disabled = false; return; }
    st.step = "result"; render(); await st.onDone?.(); return;
  }
  if (act === "undoThis" || act === "undo") {
    if (!confirm("直前の一括押印を元に戻しますか？（押印の後に印を変えた日報はそのままにします）")) return;
    try {
      const undo = await undoBulkSeal(st.site.id);
      if (act === "undoThis") { st.result = { ...st.result, undo }; st.step = "result"; }
      else { showMessage(`前回の一括押印を元に戻しました（${undo.restored.length}件）`); await load(); }
    } catch (err) { showMessage(err.message, true); return; }
    render(); await st.onDone?.(); return;
  }
});

/**
 * 一括押印の画面を開く
 * @param {{site: object, month?: string, onDone?: () => Promise<void>}} opts onDone: 押印・元に戻した後（カレンダーの再表示）
 */
export async function openSealBulkDialog({ site, month, onDone }) {
  st = { site, reports: [], month: month || "", selected: new Set(), name: await defaultSealName(site.id), overwrite: false, step: "select", plan: null, expected: null, result: null, last: null, onDone };
  await load();
  if (!st.month || !monthsOf().includes(st.month)) st.month = monthsOf().slice(-1)[0] || month || "";
  render();
  dialog.showModal();
}
