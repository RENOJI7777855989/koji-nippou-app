/* ==========================================================
   提出内訳Excelの取込画面
   完成した会社様式の内訳書（例: 七里 提出金額.xlsx）を解析し、階層つき明細と
   既存の積算項目との照合結果を表示する。「完全一致」以外は人間が確認する。
   確認結果は取込レコード（submissionImports）に保存され、再取込では
   変更のない行の確認結果を引き継ぐ。割当への反映は明示のボタンのみ。
   ========================================================== */

import { getSite } from "../sites.js";
import { listEstimateItemsBySite } from "../estimate/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite } from "../auth.js";
import { SUBMISSION_GROUP_KIND_LABELS } from "../submission/submissionPlans.js";
import { proposeIdenticalPairings, findRegistrationCandidates } from "../submission-import/importMatcher.js";
import { listMasterItems } from "../vendorQuote/masterItems.js";
import { resolveToMaster } from "../vendorQuote/itemMasterMatch.js";
import {
  analyzeImportFile,
  createImport,
  getActiveImport,
  setLineDecision,
  setImportGroupKind,
  applyImportToAssignments,
  resolvedItemIdOf,
  registerImportLinesAsEstimateItems,
  listRegisteredItemsBySite
} from "../submission-import/submissionImports.js";

const $ = (id) => document.getElementById(id);
const els = {
  siteName: $("subImpSiteName"),
  back: $("backToSubmissionFromImportBtn"),
  file: $("subImpFile"),
  analyze: $("subImpAnalyzeBtn"),
  status: $("subImpStatus"),
  summary: $("subImpSummary"),
  issues: $("subImpIssueList"),
  diff: $("subImpDiff"),
  groupBody: $("subImpGroupBody"),
  filter: $("subImpFilter"),
  pair: $("subImpPairBtn"),
  lineBody: $("subImpLineBody"),
  apply: $("subImpApplyBtn"),
  report: $("subImpApplyReport"),
  dialog: $("subImpItemDialog"),
  dialogLine: $("subImpItemDialogLine"),
  dialogSearch: $("subImpItemSearch"),
  dialogList: $("subImpItemList"),
  dialogCancel: $("subImpItemCancel"),
  selectAll: $("subImpSelectAll"),
  bulkRegister: $("subImpBulkRegisterBtn"),
  reg: $("subImpRegisterDialog"),
  regTitle: $("subImpRegTitle"),
  regLead: $("subImpRegLead"),
  regBody: $("subImpRegBody"),
  regConfirm: $("subImpRegConfirm"),
  regError: $("subImpRegError"),
  regSubmit: $("subImpRegSubmit"),
  regCancel: $("subImpRegCancel")
};

let state = { site: null, items: [], itemsById: new Map(), record: null, lastDiff: null, dialogLineKey: null, lastReport: null, registered: new Map(), masters: [], regKeys: [], regMode: "single" };

const fmt = (n) => (n == null ? "" : Number(n).toLocaleString("ja-JP"));
const STATUS_LABEL = { exact: "完全一致", candidate: "候補", review: "要確認", none: "不一致", note: "摘要のみ" };

const itemLabel = (item) => (item ? `${item.itemName}${item.spec ? `（${item.spec.replace(/\s+/g, " ")}）` : ""} ／ ${fmt(item.quantity)}${item.unit || ""} ${fmt(item.amount)}円` : "（積算項目が見つかりません）");

function lineState(line) {
  const itemId = resolvedItemIdOf(line);
  if (line.decision?.type === "registered") return "registered";
  if (line.decision?.type === "skipped") return "skipped";
  if (line.decision?.type === "accepted" || line.decision?.type === "manual") return "confirmed";
  if (line.flags.noteOnly) return "note";
  if (line.match.status === "exact") return "auto";
  return itemId ? "auto" : "todo";
}

function counts(record) {
  const c = { exact: 0, candidate: 0, review: 0, none: 0, note: 0, confirmed: 0, skipped: 0, todo: 0, ambiguous: 0, changed: 0, registered: 0 };
  for (const l of record.lines) {
    c[l.match.status]++;
    const s = lineState(l);
    if (s === "confirmed") c.confirmed++;
    if (s === "registered") c.registered++;
    if (s === "skipped") c.skipped++;
    if (s === "todo") c.todo++;
    if (l.flags.ambiguous) c.ambiguous++;
    if (l.changedFromPrevious || l.addedInThisImport) c.changed++;
  }
  return c;
}

function renderSummary() {
  const r = state.record;
  if (!r) {
    els.summary.innerHTML = "";
    els.issues.innerHTML = "";
    return;
  }
  const c = counts(r);
  const s = r.stats;
  els.summary.innerHTML = `
    <table>
      <tr><th>取込ファイル</th><td>${escapeHtml(r.sourceFileName)}（SHA-256 ${r.sourceFileSha256.slice(0, 12)}…）</td></tr>
      <tr><th>Excelの行数</th><td class="num">全${s.rowsTotal}行／データのある行${s.rowsNonEmpty}行（${r.checks.sectionRowsUnclassified === 0 ? "すべて分類済み" : `未分類${r.checks.sectionRowsUnclassified}行`}）</td></tr>
      <tr><th>自動認識した明細</th><td class="num">${s.lineCount}件（数値のある明細${s.detailWithNumbers}／摘要のみの行${s.noteOnlyCount}／表紙のみの区分${s.coverOnlyCount}）</td></tr>
      <tr><th>除外した行</th><td class="num">工事名${s.excluded.title}・見出し${s.excluded.header}・頁番号${s.excluded.pageMark}・会社名${s.excluded.company}・小計${s.excluded.subtotal}・表紙合計${s.excluded.coverSubtotal}・一覧行${s.excluded.listing}</td></tr>
      <tr><th>照合結果</th><td class="num">完全一致${c.exact}／候補${c.candidate}／要確認${c.review}／不一致${c.none}／照合対象外${c.note}</td></tr>
      <tr><th>人間の確認</th><td class="num">確認済み${c.confirmed}件／積算項目として登録済み${c.registered}件／割当しない${c.skipped}件／<strong>未確認（要対応）${c.todo}件</strong></td></tr>
      <tr><th>構造要確認</th><td class="num">${c.ambiguous}件（前の項目の追記行が混ざっている可能性を構造上否定できない行）</td></tr>
    </table>`;
  const issues = [];
  if (r.checks.subtotalMismatchCount > 0) issues.push(`<li class="issue-error">⛔ Excel上の小計と取込明細の合計が一致しない箇所が${r.checks.subtotalMismatchCount}件あります（取込の取りこぼし・誤認識の可能性）。</li>`);
  else issues.push(`<li class="issue-warn">✔ Excel上の小計と取込明細の合計は全階層で一致しました（検算のみで、金額の根拠には使いません）。</li>`);
  if (r.checks.coverCheck && !(r.checks.coverCheck.direct && r.checks.coverCheck.net && r.checks.coverCheck.cost)) issues.push(`<li class="issue-error">⛔ 表紙の合計（直接工事費・純工事費・工事原価）が明細の合計と一致しません。</li>`);
  for (const w of r.warnings || []) issues.push(`<li class="issue-warn">⚠ ${escapeHtml(w)}</li>`);
  if (c.todo > 0) issues.push(`<li class="issue-warn">⚠ 未確認の明細が${c.todo}件あります。「完全一致」以外は自動で割当になりません。</li>`);
  els.issues.innerHTML = issues.join("");
}

function renderDiff() {
  const d = state.lastDiff;
  if (!d || !state.record?.diffSummary) {
    els.diff.innerHTML = "";
    return;
  }
  const list = (arr, fn) => (arr.length ? `<ul>${arr.slice(0, 20).map((x) => `<li>${fn(x)}</li>`).join("")}${arr.length > 20 ? `<li>…ほか${arr.length - 20}件</li>` : ""}</ul>` : "");
  const label = (l) => escapeHtml(`${l.groupName} / ${l.workType} / ${l.subType} / ${l.name.replace(/\s+/g, " ")}`);
  els.diff.innerHTML = `<h3>前回の取込との差分</h3>
    <p class="app-subtitle">追加${d.added.length}件／削除${d.removed.length}件／変更${d.changed.length}件／変更なし${d.unchanged}件。変更のない行の確認結果は引き継ぎ、変更・追加された行はもう一度確認してください。</p>
    ${d.added.length ? `<p><strong>追加</strong></p>${list(d.added, label)}` : ""}
    ${d.removed.length ? `<p><strong>削除（今回のExcelに無い）</strong></p>${list(d.removed, label)}` : ""}
    ${d.changed.length ? `<p><strong>変更</strong></p>${list(d.changed, (c) => `${label(c.next)}: 金額 ${fmt(c.prev.amount)} → ${fmt(c.next.amount)}`)}` : ""}`;
}

function renderGroups() {
  const r = state.record;
  els.groupBody.innerHTML = r
    ? r.groups
        .map(
          (g) => `<tr data-symbol="${escapeHtml(g.symbol)}">
        <td>${escapeHtml(g.symbol)}</td><td>${escapeHtml(g.name)}</td>
        <td><select class="groupKind">${Object.entries(SUBMISSION_GROUP_KIND_LABELS).map(([k, v]) => `<option value="${k}" ${k === g.kind ? "selected" : ""}>${v}</option>`).join("")}</select></td>
        <td>${g.kindBasis === "position" ? "表紙の位置" : g.kindBasis === "name" ? "名称の語（積上／一般）" : g.kindBasis === "user" ? "手動で指定" : '<span class="status-badge status-warning">要確認</span>'}</td>
        <td>${g.hasPage ? "あり" : "なし（表紙の1行のみ）"}</td></tr>`
        )
        .join("")
    : "";
}

function matchesFilter(line, filter) {
  switch (filter) {
    case "todo": return lineState(line) === "todo";
    case "exact": case "candidate": case "review": case "none": case "note": return line.match.status === filter;
    case "ambiguous": return line.flags.ambiguous;
    case "changed": return line.changedFromPrevious || line.addedInThisImport;
    case "registered": return line.decision?.type === "registered";
    default: return true;
  }
}

/** 一括登録できる明細: 不一致で、似た既存項目・同一項目が無く、構造要確認でも摘要のみでもなく、未確認のもの */
function isBulkRegistrable(line) {
  if (line.match.status !== "none" || line.flags.ambiguous || line.flags.noteOnly || lineState(line) !== "todo") return false;
  const cand = findRegistrationCandidates(line, state.items);
  return cand.identical.length === 0 && cand.similar.length === 0;
}

function canRegister(line) {
  const st = lineState(line);
  if (st === "registered") return false;
  if (line.match.status === "exact" && st !== "skipped") return false;
  return true;
}

function renderLines() {
  const r = state.record;
  if (!r) {
    els.lineBody.innerHTML = "";
    return;
  }
  const rows = r.lines.filter((l) => matchesFilter(l, els.filter.value));
  els.lineBody.innerHTML = rows
    .map((l) => {
      const itemId = resolvedItemIdOf(l);
      const st = lineState(l);
      const candidates = (l.match.candidates || []).slice(0, 3);
      let target = "";
      if (st === "skipped") target = l.flags.noteOnly ? "（帳票表示専用として、積算項目には登録しない）" : "（割当しない）";
      else if (itemId) {
        const badge = st === "registered" ? "積算項目として登録済み" : st === "confirmed" ? (l.decision.type === "manual" ? "手動選択で確認済み" : "候補を採用済み") : "完全一致（自動）";
        target = `${escapeHtml(itemLabel(state.itemsById.get(itemId)))}${state.registered.has(itemId) ? " <span class=\"status-badge status-candidate\">Excel由来で登録済み</span>" : ""}<br><span class="status-badge ${st === "auto" ? "status-exact" : "status-candidate"}">${badge}</span>`;
      } else {
        const candList = candidates.map((c) => state.itemsById.get(c.itemId)).filter(Boolean).map((it) => `<br>候補: ${escapeHtml(itemLabel(it))}${state.registered.has(it.id) ? " <span class=\"status-badge status-candidate\">Excel由来で登録済み</span>" : ""}`).join("");
        target = `<span class="app-subtitle">${escapeHtml(l.match.reason)}</span>${candList}`;
      }
      const buttons = [];
      const todoLike = st === "todo" || st === "note";
      if (!l.flags.noteOnly) {
        if (l.match.status === "candidate" && st === "todo") buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="accept">候補を採用</button>`);
        for (const c of candidates.filter((x) => l.match.status === "review" && st === "todo")) {
          buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="pick" data-item-id="${escapeHtml(c.itemId)}" title="${escapeHtml(itemLabel(state.itemsById.get(c.itemId)))}">${escapeHtml((state.itemsById.get(c.itemId)?.itemName || "候補").slice(0, 10))}を採用</button>`);
        }
        buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="choose">項目を選ぶ…</button>`);
      }
      if (canRegister(l) && (todoLike || st === "skipped")) buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="register">${l.flags.noteOnly ? "判断して登録…" : "積算項目として登録…"}</button>`);
      if (st !== "skipped" && st !== "registered" && (!l.flags.noteOnly || st === "note")) buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="skip">${l.flags.noteOnly ? "登録しない（帳票表示専用）" : "割当しない"}</button>`);
      if (l.decision?.type && l.decision.type !== "none" && l.decision.type !== "registered") buttons.push(`<button type="button" class="secondary-btn subimp-btn" data-action="clear">確認を取消</button>`);
      const marks = [
        l.flags.ambiguous ? `<span class="status-badge status-warning" title="前の項目の追記行が混ざっている可能性を構造上否定できません">構造要確認</span>` : "",
        l.flags.coverOnly ? `<span class="status-badge status-note">表紙のみの区分</span>` : "",
        l.changedFromPrevious ? `<span class="status-badge status-warning">再取込で変更</span>` : "",
        l.addedInThisImport ? `<span class="status-badge status-warning">再取込で追加</span>` : ""
      ].join(" ");
      const bulk = isBulkRegistrable(l) ? `<input type="checkbox" class="bulkCheck" aria-label="登録候補として選択">` : "";
      return `<tr data-line-key="${escapeHtml(l.lineKey)}">
        <td>${bulk}</td>
        <td>${l.displayOrder}</td>
        <td>${escapeHtml([l.groupName, l.workType, l.subType].filter(Boolean).join(" ／ "))}</td>
        <td class="subimp-text">${escapeHtml(l.name.replace(/\r\n/g, "␍"))}${l.spec ? `\n<span class="app-subtitle">${escapeHtml(l.spec.replace(/\r\n/g, "␍"))}</span>` : ""}${l.note ? `\n備考: ${escapeHtml(l.note)}` : ""}<br>${marks}</td>
        <td class="num">${fmt(l.quantity)}</td><td>${escapeHtml(l.unit)}</td><td class="num">${fmt(l.unitPrice)}</td><td class="num">${fmt(l.amount)}</td>
        <td><span class="status-badge status-${l.match.status}">${STATUS_LABEL[l.match.status]}</span></td>
        <td class="subimp-text">${target}</td>
        <td>${buttons.join("")}</td></tr>`;
    })
    .join("");
  const proposals = currentProposals();
  els.pair.textContent = proposals.length ? `同一内容を出現順に対応付け（${proposals.length}件）` : "同一内容を出現順に対応付け";
  els.pair.disabled = proposals.length === 0;
  els.selectAll.checked = false;
}

/** 未確認のreview行のうち、同数の同一内容の積算項目がある行の「出現順の対応」提案（確定はしない） */
function currentProposals() {
  const r = state.record;
  if (!r) return [];
  const pending = r.lines.filter((l) => lineState(l) === "todo");
  // すでに他の行に採用・一致している積算項目は提案の対象から外す
  const usedItemIds = new Set(r.lines.map((l) => resolvedItemIdOf(l)).filter(Boolean));
  const freeItems = state.items.filter((i) => !usedItemIds.has(i.id));
  return proposeIdenticalPairings(pending, pending.map((l) => l.match), freeItems);
}

function renderApplyReport() {
  const rep = state.lastReport;
  if (!rep) {
    els.report.innerHTML = "";
    return;
  }
  const conflictRows = rep.conflicts
    .map((c) => `<tr><td><input type="checkbox" class="overwriteCheck" data-line-key="${escapeHtml(c.lineKey)}"></td><td>${escapeHtml(itemLabel(state.itemsById.get(c.itemId)))}</td><td>${escapeHtml(c.imported.group)} ／ ${escapeHtml(c.imported.workType)} ／ ${escapeHtml(c.imported.subType)}</td></tr>`)
    .join("");
  els.report.innerHTML = `
    <div class="submission-preview"><table>
      <tr><th>新規に割当</th><td class="num">${rep.created}件</td></tr>
      <tr><th>取込の内容で更新（取込由来の割当のみ）</th><td class="num">${rep.updated}件</td></tr>
      <tr><th>すでに同じ内容（変更なし・二重登録なし）</th><td class="num">${rep.unchanged}件</td></tr>
      <tr><th>手動割当と衝突（既存を維持）</th><td class="num">${rep.conflicts.length}件</td></tr>
      <tr><th>取込の内容で上書きした</th><td class="num">${rep.overwritten}件</td></tr>
      <tr><th>未確認のため割当していない明細</th><td class="num">${rep.skippedUnresolved}件</td></tr>
      <tr><th>摘要のみの行（割当対象外）</th><td class="num">${rep.skippedNoteOnly}件</td></tr>
      <tr><th>区分グループを新規追加</th><td class="num">${rep.groupsAdded}件</td></tr>
    </table></div>
    ${rep.conflicts.length ? `<p class="app-subtitle">次の項目は、すでに手動で割り当てられており取込の内容と異なるため、既存の割当を維持しました。取込の内容にしたい行にチェックして「選んだ行を取込の内容で上書き」を押してください。</p>
    <div class="table-scroll"><table class="estimate-table"><thead><tr><th></th><th>積算項目</th><th>取込の内容（区分／工種／種別）</th></tr></thead><tbody>${conflictRows}</tbody></table></div>
    <button type="button" id="subImpOverwriteBtn" class="secondary-btn">選んだ行を取込の内容で上書き</button>` : ""}`;
}

function renderAll() {
  renderSummary();
  renderDiff();
  renderGroups();
  renderLines();
  renderApplyReport();
  els.apply.disabled = !state.record;
}

async function refreshRecord() {
  state.record = await getActiveImport(state.site.id);
}

async function decide(lineKey, decision) {
  state.record = await setLineDecision(state.record.id, lineKey, decision);
  renderAll();
}

// ---- イベント ----

els.back.addEventListener("click", () => navigate(`/sites/${state.site.id}/submission`));

els.analyze.addEventListener("click", async () => {
  const file = els.file.files[0];
  if (!file) return showMessage("取り込むExcel（.xlsx）を選択してください。", true);
  els.analyze.disabled = true;
  els.status.textContent = "解析中…";
  try {
    const analysis = await analyzeImportFile(file);
    if (!analysis.parsed.ok) {
      els.status.textContent = "";
      return showMessage(`このExcelは取り込めません: ${analysis.parsed.errors.join(" ")}`, true);
    }
    state.items = await listEstimateItemsBySite(state.site.id);
    state.itemsById = new Map(state.items.map((i) => [i.id, i]));
    state.registered = await listRegisteredItemsBySite(state.site.id);
    const prev = await getActiveImport(state.site.id);
    const { record, diff, created, reason } = await createImport({ siteId: state.site.id, file, analysis, items: state.items });
    state.record = record;
    state.lastDiff = diff && (created || prev) ? diff : null;
    state.lastReport = null;
    els.status.textContent = reason;
    showMessage(created ? `取り込みました（明細${record.lines.length}件）。` : reason);
    renderAll();
  } catch (err) {
    els.status.textContent = "";
    showMessage(`取込に失敗しました: ${err.message}`, true);
  } finally {
    els.analyze.disabled = false;
  }
});

els.filter.addEventListener("change", renderLines);

els.groupBody.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("groupKind")) return;
  state.record = await setImportGroupKind(state.record.id, e.target.closest("tr").dataset.symbol, e.target.value);
  renderAll();
});

els.pair.addEventListener("click", async () => {
  const proposals = currentProposals();
  for (const p of proposals) state.record = await setLineDecision(state.record.id, p.lineKey, { type: "accepted", itemId: p.itemId });
  showMessage(`同一内容の${proposals.length}件を出現順に対応付けました（取消できます）。`);
  renderAll();
});

els.lineBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  const tr = e.target.closest("tr[data-line-key]");
  if (!btn || !tr) return;
  const lineKey = tr.dataset.lineKey;
  const line = state.record.lines.find((l) => l.lineKey === lineKey);
  switch (btn.dataset.action) {
    case "accept": return decide(lineKey, { type: "accepted", itemId: line.match.itemId });
    case "pick": return decide(lineKey, { type: "accepted", itemId: btn.dataset.itemId });
    case "skip": return decide(lineKey, { type: "skipped", itemId: null });
    case "clear": return decide(lineKey, { type: "none", itemId: null });
    case "register": return openRegisterDialog([lineKey], "single");
    case "choose":
      state.dialogLineKey = lineKey;
      els.dialogLine.textContent = `${line.name.replace(/\s+/g, " ")} ／ ${fmt(line.quantity)}${line.unit} ${fmt(line.amount)}円`;
      els.dialogSearch.value = "";
      renderDialogList();
      els.dialog.showModal();
  }
});

function renderDialogList() {
  const q = els.dialogSearch.value.trim().toLowerCase();
  const line = state.record.lines.find((l) => l.lineKey === state.dialogLineKey);
  const candidateIds = new Set((line?.match.candidates || []).map((c) => c.itemId));
  const items = state.items
    .filter((i) => !q || [i.category, i.itemName, i.spec].some((v) => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => Number(candidateIds.has(b.id)) - Number(candidateIds.has(a.id)))
    .slice(0, 100);
  els.dialogList.innerHTML = items.map((i) => `<li data-item-id="${escapeHtml(i.id)}">${candidateIds.has(i.id) ? '<span class="status-badge status-candidate">候補</span> ' : ""}${escapeHtml(itemLabel(i))}</li>`).join("") || "<li>該当する積算項目がありません。</li>";
}

els.dialogSearch.addEventListener("input", renderDialogList);
els.dialogCancel.addEventListener("click", () => els.dialog.close());
els.dialogList.addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-item-id]");
  if (!li) return;
  els.dialog.close();
  await decide(state.dialogLineKey, { type: "manual", itemId: li.dataset.itemId });
});

async function runApply(overwriteKeys = []) {
  els.apply.disabled = true;
  try {
    state.lastReport = await applyImportToAssignments({ siteId: state.site.id, importId: state.record.id, overwriteKeys });
    showMessage("割当に反映しました。");
    renderAll();
  } catch (err) {
    showMessage(`反映に失敗しました: ${err.message}`, true);
  } finally {
    els.apply.disabled = false;
  }
}

els.apply.addEventListener("click", () => {
  const c = counts(state.record);
  if (c.todo > 0 && !confirm(`未確認の明細が${c.todo}件あります。これらは割当されません（後から確認して再度反映できます）。反映しますか？`)) return;
  runApply();
});

els.report.addEventListener("click", (e) => {
  if (!e.target.closest("#subImpOverwriteBtn")) return;
  const keys = [...els.report.querySelectorAll(".overwriteCheck:checked")].map((cb) => cb.dataset.lineKey);
  if (keys.length === 0) return showMessage("上書きする行にチェックを入れてください。", true);
  if (!confirm(`${keys.length}件の手動割当を、取込の内容で上書きします。よろしいですか？`)) return;
  runApply(keys);
});

export async function initSubmissionImportView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site)) {
    showMessage("この現場を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  state = { site, items: await listEstimateItemsBySite(site.id), itemsById: new Map(), record: null, lastDiff: null, dialogLineKey: null, lastReport: null, registered: new Map(), masters: [], regKeys: [], regMode: "single" };
  state.itemsById = new Map(state.items.map((i) => [i.id, i]));
  state.registered = await listRegisteredItemsBySite(site.id);
  state.masters = await listMasterItems().catch(() => []);
  els.siteName.textContent = `：${site.name}`;
  els.file.value = "";
  els.status.textContent = "";
  els.filter.value = "all";
  showView("view-submission-import");
  await refreshRecord();
  renderAll();
}

// ================= 積算項目として登録（確認ダイアログ） =================

function sourceInfoOf(line) {
  const r = state.record;
  return `${r.sourceFileName}／シート「${r.sheetName || "-"}」／${line.source.pages.join("・")}頁目／${line.source.firstRow === line.source.lastRow ? `${line.source.lastRow}行目` : `${line.source.firstRow}〜${line.source.lastRow}行目`}`;
}

function neighborText(index, delta) {
  const l = state.record.lines[index + delta];
  if (!l) return "（なし）";
  return `${l.name.replace(/\s+/g, " ")}${l.spec ? `／${l.spec.replace(/\s+/g, " ")}` : ""}${l.flags.noteOnly ? "（摘要のみ）" : `／${fmt(l.quantity)}${l.unit} ${fmt(l.amount)}円`}`;
}

function masterHint(line) {
  if (!state.masters.length) return "共通工事項目マスターが未登録のため、参照なし（今回は関連付けしません）";
  const res = resolveToMaster({ itemName: line.name }, state.masters);
  if (!res.masterItem) return "共通工事項目マスター: 該当なし（関連付けしません）";
  return `共通工事項目マスター: ${res.masterItem.itemCode} ${res.masterItem.standardName}（${res.matchType === "exact" ? "完全一致" : `近似 ${Math.round((res.score ?? 0) * 100)}%`}。参考表示のみで、自動では関連付けしません）`;
}

function regBlockHtml(line, single) {
  const idx = state.record.lines.findIndex((l) => l.lineKey === line.lineKey);
  const cand = findRegistrationCandidates(line, state.items);
  const k = escapeHtml(line.lineKey);
  const registeredBadge = (item) => (state.registered.has(item.id) ? ' <span class="status-badge status-candidate">Excel由来で登録済み</span>' : "");
  let extra = "";
  if (line.flags.noteOnly) {
    extra += `<div class="subimp-reg-note"><strong>摘要のみの行（数量・単位・単価・金額がありません）</strong><br>
      判断材料: 前の明細＝${escapeHtml(neighborText(idx, -1))}<br>次の明細＝${escapeHtml(neighborText(idx, 1))}<br>
      この行の直前は${line.layout.blankBefore ? "空行" : "前の明細の続き（空行なし）"}／${line.layout.rowCount}行／${line.layout.firstPos}行目（頁内）。<br>
      独立した明細・前の明細の続き・帳票表示専用のどれかは、Excelの構造だけでは決められません。積算項目として必要な場合だけ登録してください。<br>
      <label class="checkbox-label"><input type="radio" name="noteChoice-${k}" value="register" class="regNoteChoice"> 積算項目として登録する（数値なしの摘要行として出力に載ります）</label>
      <label class="checkbox-label"><input type="radio" name="noteChoice-${k}" value="skip" class="regNoteChoice"> 登録しない（帳票表示専用として扱う。積算項目にはしない）</label>
      <label class="checkbox-label"><input type="radio" name="noteChoice-${k}" value="hold" class="regNoteChoice" checked> 保留（何もしない）</label></div>`;
  }
  if (line.flags.ambiguous) {
    extra += `<div class="subimp-reg-note"><strong>構造要確認</strong>: 名称・摘要の先頭に「前の項目の追記行」が混ざっている可能性を構造上否定できません（前の明細＝${escapeHtml(neighborText(idx, -1))}）。下の名称・摘要を見て、必要なら直してください。<br>
      <label class="checkbox-label"><input type="checkbox" class="regAckAmbiguous"> 名称・摘要に前の項目の追記行が混ざっていないことを確認しました</label></div>`;
  }
  if (cand.identical.length) {
    extra += `<div class="subimp-reg-note"><strong>完全に同じ内容の積算項目が${cand.identical.length}件あります</strong>（${escapeHtml(cand.identical.map((i) => itemLabel(i)).join(" / "))}）<br>
      <label class="checkbox-label"><input type="checkbox" class="regAckDuplicate"> 重複を承知で新規登録する</label></div>`;
  }
  let choice = "";
  if (cand.similar.length && !line.flags.noteOnly) {
    choice = `<div class="subimp-reg-note"><strong>既存候補があります</strong>（名称が似ている・数量と金額が同じ）。同じ項目かどうかは自動では決めません。選んでください。
      ${cand.similar.map((c) => `<label class="checkbox-label"><input type="radio" name="regChoice-${k}" value="existing:${escapeHtml(c.item.id)}" class="regChoice"> 既存項目を使用: ${escapeHtml(itemLabel(c.item))}${registeredBadge(c.item)}（名称の類似度${Math.round(c.nameSim * 100)}%${c.amountEq ? "・数量と金額が同じ" : ""}）</label>`).join("")}
      <label class="checkbox-label"><input type="radio" name="regChoice-${k}" value="new" class="regChoice"> 新規に積算項目として登録する</label></div>`;
  }
  const textFields = single
    ? `<label class="full-width">名称（登録する内容。必要なら直せます）<textarea class="regName">${escapeHtml(line.name.replace(/\r\n/g, "\n"))}</textarea></label>
       <label class="full-width">摘要<textarea class="regSpec">${escapeHtml(line.spec.replace(/\r\n/g, "\n"))}</textarea></label>`
    : "";
  return `<section class="subimp-reg-block" data-line-key="${k}">
    <h4>#${line.displayOrder} ${escapeHtml([line.groupSymbol + " " + line.groupName, line.workTypeSymbol && `${line.workTypeSymbol} ${line.workType}`, line.subTypeSymbol && `${line.subTypeSymbol} ${line.subType}`].filter(Boolean).join(" ／ "))}</h4>
    <table>
      <tr><th>名称</th><td>${escapeHtml(line.name.replace(/\r\n/g, "␍"))}</td></tr>
      <tr><th>摘要</th><td>${escapeHtml(line.spec.replace(/\r\n/g, "␍")) || "（なし）"}</td></tr>
      <tr><th>数量／単位</th><td>${fmt(line.quantity) || "（なし）"} ${escapeHtml(line.unit)}</td></tr>
      <tr><th>単価／金額</th><td>単価 ${fmt(line.unitPrice) || "（なし）"} ／ 金額 ${fmt(line.amount) || "（なし）"}（Excelの値をそのまま登録。数量×単価の再計算はしません）</td></tr>
      ${line.note ? `<tr><th>備考</th><td>${escapeHtml(line.note)}（割当時の備考として使います）</td></tr>` : ""}
      <tr><th>元のExcel</th><td>${escapeHtml(sourceInfoOf(line))}</td></tr>
      <tr><th>現在の照合状態</th><td><span class="status-badge status-${line.match.status}">${STATUS_LABEL[line.match.status]}</span> ${escapeHtml(line.match.reason)}</td></tr>
      <tr><th>共通工事項目</th><td>${escapeHtml(masterHint(line))}</td></tr>
    </table>
    ${textFields}${extra}${choice}
  </section>`;
}

function openRegisterDialog(lineKeys, mode) {
  state.regKeys = lineKeys;
  state.regMode = mode;
  const lines = lineKeys.map((k) => state.record.lines.find((l) => l.lineKey === k)).filter(Boolean);
  els.regTitle.textContent = mode === "bulk" ? `不一致の${lines.length}件を確認して積算項目に登録` : "積算項目として登録（内容の確認）";
  els.regLead.textContent = mode === "bulk"
    ? "Excelに有って積算項目に無い明細です。似た既存項目もありませんでした。内容を確認して、問題なければ登録してください。"
    : "登録すると、この現場の積算項目として追加されます（既存の積算項目は変更されません）。金額はExcelの値をそのまま使います。";
  els.regBody.innerHTML = lines.map((l) => regBlockHtml(l, mode === "single")).join("");
  els.regConfirm.checked = false;
  els.regError.textContent = "";
  els.reg.showModal();
}

async function submitRegister() {
  els.regError.textContent = "";
  if (!els.regConfirm.checked) return (els.regError.textContent = "「上の内容を確認しました」にチェックを入れてください。");
  const entries = [];
  const skipKeys = [];
  for (const block of els.regBody.querySelectorAll(".subimp-reg-block")) {
    const lineKey = block.dataset.lineKey;
    const line = state.record.lines.find((l) => l.lineKey === lineKey);
    if (line.flags.noteOnly) {
      const choice = block.querySelector(".regNoteChoice:checked")?.value;
      if (choice === "skip") skipKeys.push(lineKey);
      if (choice !== "register") continue;
    }
    const choiceEl = block.querySelector(".regChoice");
    let mode = "new", existingItemId = null;
    if (choiceEl) {
      const picked = block.querySelector(".regChoice:checked")?.value;
      if (!picked) return (els.regError.textContent = `#${line.displayOrder}: 既存候補があります。「既存項目を使用」か「新規に登録」を選んでください。`);
      if (picked.startsWith("existing:")) { mode = "existing"; existingItemId = picked.slice(9); }
    }
    entries.push({
      lineKey,
      mode,
      existingItemId,
      name: block.querySelector(".regName") ? block.querySelector(".regName").value : line.name,
      spec: block.querySelector(".regSpec") ? block.querySelector(".regSpec").value : line.spec,
      confirmed: true,
      acknowledgeDuplicate: !!block.querySelector(".regAckDuplicate")?.checked,
      acknowledgeAmbiguous: !!block.querySelector(".regAckAmbiguous")?.checked,
      acknowledgeNoteOnly: line.flags.noteOnly
    });
  }
  if (entries.length === 0 && skipKeys.length === 0) return (els.regError.textContent = "登録する明細がありません（摘要のみの行は「登録する」を選んでください）。");
  els.regSubmit.disabled = true;
  try {
    for (const key of skipKeys) state.record = await setLineDecision(state.record.id, key, { type: "skipped", itemId: null });
    let result = { registered: [], usedExisting: [], skipped: [] };
    if (entries.length) result = await registerImportLinesAsEstimateItems({ siteId: state.site.id, importId: state.record.id, entries });
    if (result.skipped.length) {
      els.regError.textContent = result.skipped.map((s) => `#${state.record.lines.find((l) => l.lineKey === s.lineKey)?.displayOrder}: ${s.message}`).join(" ／ ");
    }
    await reloadAfterRegistration();
    if (!result.skipped.length) els.reg.close();
    showMessage(`積算項目として登録${result.registered.length}件／既存項目を使用${result.usedExisting.length}件${skipKeys.length ? `／登録しない${skipKeys.length}件` : ""}${result.skipped.length ? `／登録できなかった${result.skipped.length}件` : ""}`, result.skipped.length > 0);
  } catch (err) {
    els.regError.textContent = `登録に失敗しました: ${err.message}`;
  } finally {
    els.regSubmit.disabled = false;
  }
}

async function reloadAfterRegistration() {
  state.items = await listEstimateItemsBySite(state.site.id);
  state.itemsById = new Map(state.items.map((i) => [i.id, i]));
  state.registered = await listRegisteredItemsBySite(state.site.id);
  await refreshRecord();
  renderAll();
}

els.regSubmit.addEventListener("click", submitRegister);
els.regCancel.addEventListener("click", () => els.reg.close());

els.selectAll.addEventListener("change", () => {
  els.lineBody.querySelectorAll(".bulkCheck").forEach((cb) => (cb.checked = els.selectAll.checked));
});

els.bulkRegister.addEventListener("click", () => {
  const keys = [...els.lineBody.querySelectorAll("tr")].filter((tr) => tr.querySelector(".bulkCheck")?.checked).map((tr) => tr.dataset.lineKey);
  if (keys.length === 0) return showMessage("登録する不一致の明細にチェックを入れてください（候補がある行・構造要確認・摘要のみは、行ごとに登録します）。", true);
  openRegisterDialog(keys, "bulk");
});
