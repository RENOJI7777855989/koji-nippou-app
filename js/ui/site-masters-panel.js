/* ==========================================================
   現場の編集画面の「棟・工種の一覧（この現場だけ）」（2026-11-01。データは js/siteMasters.js）
   変更はその場で現場に保存する（現場フォームの［保存］とは別。フォームの保存は棟・工種の項目に触れない）。
   過去の日報の工種は、自動では一覧に入れず、利用者が選んで登録する。
   ========================================================== */

import { getSite } from "../sites.js";
import { listReportsBySite } from "../reports.js";
import { listMaster, addMasterItem, renameMasterItem, setMasterItemActive, moveMasterItem, tradeCandidatesFromReports, MASTER_COMPLETED_MESSAGE } from "../siteMasters.js";
import { escapeHtml } from "../utils.js";
import { siteUsesBuildings, setSiteUseBuildings } from "../billing/vendorNames.js";
import { showMessage } from "./common.js";

const section = document.getElementById("siteMastersSection");
const noteEl = document.getElementById("siteMastersNote");
let site = null;
let candidates = [];

/** 現場の編集画面を開いたときに呼ぶ（新しい現場では null。保存した後に登録できる） */
export async function renderSiteMasters(siteId) {
  if (!siteId) {
    site = null;
    section.hidden = false;
    noteEl.hidden = false;
    noteEl.textContent = "棟・工種の一覧は、現場を保存した後に登録できます（現場情報の編集、または日報の作業行から）。";
    section.querySelectorAll(".site-master").forEach((el) => { el.hidden = true; });
    return;
  }
  site = await getSite(siteId);
  candidates = tradeCandidatesFromReports(site, await listReportsBySite(siteId));
  section.hidden = false;
  section.querySelectorAll(".site-master").forEach((el) => { el.hidden = false; });
  noteEl.hidden = !site.completedAt;
  noteEl.textContent = site.completedAt ? MASTER_COMPLETED_MESSAGE : "";
  draw();
}

function draw() {
  const locked = !!site?.completedAt;
  for (const box of section.querySelectorAll(".site-master")) {
    const kind = box.dataset.kind;
    const items = listMaster(site, kind, { includeInactive: true });
    box.querySelector(".master-list").innerHTML = items.length
      ? items.map((x, i) => `<li data-id="${escapeHtml(x.id)}" class="${x.active === false ? "is-inactive" : ""}">
          <span class="master-name">${escapeHtml(x.name)}</span>${x.active === false ? ` <span class="master-state">（使用停止）</span>` : ""}
          ${locked ? "" : `<span class="master-ops">
            <button type="button" class="secondary-btn" data-op="rename">名前を変更</button>
            <button type="button" class="secondary-btn" data-op="${x.active === false ? "resume" : "stop"}">${x.active === false ? "使用を再開" : "使用停止"}</button>
            <button type="button" class="secondary-btn" data-op="up" aria-label="上へ"${i === 0 ? " disabled" : ""}>▲</button>
            <button type="button" class="secondary-btn" data-op="down" aria-label="下へ"${i === items.length - 1 ? " disabled" : ""}>▼</button>
          </span>`}
        </li>`).join("")
      : `<li class="empty-message">まだ登録されていません。</li>`;
    box.querySelector(".master-add-row").hidden = locked;
  }
  // 棟の使用設定（2026-11-16）。未設定の現場は、棟の一覧に棟があれば「使う」
  const use = siteUsesBuildings(site);
  const cb = section.querySelector(".use-buildings-cb");
  cb.checked = use;
  cb.disabled = locked;
  section.querySelector(".use-buildings-note").textContent = use
    ? "日報の作業行で棟を選びます。棟を選んでいない作業行は、照合・業者ごとのPDFで「棟未設定」になります。"
    : "棟の無い現場（道路・河川・外構など）として扱います。日報の作業行に棟の欄を出さず、照合・業者ごとのPDFも棟で分けません（保存済みの日報の棟は消しません）。";
  section.querySelector('.site-master[data-kind="buildings"] .master-list').hidden = !use && !listMaster(site, "buildings", { includeInactive: true }).length;
  const cand = section.querySelector(".trade-candidates");
  cand.hidden = locked || candidates.length === 0;
  cand.querySelector(".cand-list").innerHTML = candidates.map((c, i) => `<label class="cand-item"><input type="checkbox" value="${i}"> ${escapeHtml(c.name)}${c.variants.length > 1 ? `<span class="dash-sub">（同じ工種として扱う書き方: ${c.variants.map(escapeHtml).join("・")}）</span>` : ""} <span class="dash-sub">日報の${c.rows}行</span></label>`).join("");
}

async function run(fn, okText) {
  try {
    const r = await fn();
    site = r?.site || (await getSite(site.id));
    if (okText) showMessage(okText);
  } catch (err) {
    showMessage(err.message, true);
  }
  candidates = tradeCandidatesFromReports(site, await listReportsBySite(site.id));
  draw();
}

section.addEventListener("change", async (e) => {
  const cb = e.target.closest(".use-buildings-cb");
  if (!cb || !site) return;
  await run(() => setSiteUseBuildings(site.id, cb.checked).then((s) => ({ site: s })), cb.checked ? "この現場で棟を使用します。" : "この現場は棟を使用しない設定にしました（保存済みの日報の棟は消していません）。");
});

section.addEventListener("click", async (e) => {
  if (!site) return;
  const box = e.target.closest(".site-master");
  if (!box) return;
  const kind = box.dataset.kind;
  const label = kind === "buildings" ? "棟" : "工種";
  if (e.target.closest(".master-add")) {
    const input = box.querySelector(".master-new");
    const name = input.value.trim();
    if (!name) { showMessage(`${label}の名前を入力してください。`, true); return; }
    await run(() => addMasterItem(site.id, kind, name), `${label}「${name}」を登録しました。`);
    input.value = "";
    return;
  }
  if (e.target.closest(".cand-add")) {
    const picked = [...box.querySelectorAll(".cand-item input:checked")].map((cb) => candidates[Number(cb.value)]).filter(Boolean);
    if (!picked.length) { showMessage("登録する工種を選んでください。", true); return; }
    const done = [];
    for (const c of picked) {
      try { await addMasterItem(site.id, "trades", c.name); done.push(c.name); } catch (err) { showMessage(err.message, true); }
    }
    await run(async () => null, done.length ? `工種を${done.length}件登録しました（${done.join("・")}）。` : "");
    return;
  }
  const btn = e.target.closest("button[data-op]");
  if (!btn) return;
  const id = btn.closest("li")?.dataset.id;
  const item = listMaster(site, kind, { includeInactive: true }).find((x) => x.id === id);
  if (!item) return;
  const op = btn.dataset.op;
  if (op === "rename") {
    const name = prompt(`${label}の新しい名前（保存済みの日報の${label}の名前は変わりません）`, item.name);
    if (name == null || name.trim() === item.name) return;
    await run(() => renameMasterItem(site.id, kind, id, name), `${label}の名前を「${name.trim()}」に変えました。`);
  } else if (op === "stop") {
    if (!confirm(`${label}「${item.name}」を使用停止にしますか？\n（削除はしません。保存済みの日報はそのまま表示・出力できます。日報の新しい行の選択肢には出なくなります）`)) return;
    await run(() => setMasterItemActive(site.id, kind, id, false), `${label}「${item.name}」を使用停止にしました。`);
  } else if (op === "resume") {
    await run(() => setMasterItemActive(site.id, kind, id, true), `${label}「${item.name}」の使用を再開しました。`);
  } else if (op === "up" || op === "down") {
    await run(() => moveMasterItem(site.id, kind, id, op === "up" ? -1 : 1), "");
  }
});
