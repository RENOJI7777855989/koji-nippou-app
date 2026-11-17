/* ==========================================================
   業者ごとの月の帳票（A4横。2026-11-16。DOM・DB に触れない純粋関数 → 印刷用HTML）
   ・請求人工PDF（業者ごと・月。A4 縦）、業者別稼働PDF（業者ごと・月。A4 横）、請求人工と実稼働の照合表PDF（A4 横）の3つ。
     請求人工PDF には稼働人数を、業者別稼働PDF には請求人工を載せない（別々の帳票）。
   ・元のデータは billingReconcile.js の monthLineItems / buildReconciliation（日報の業者の行を読むだけ。何も保存しない）。
   ・PDF は既存の方式（board-pdf.js の buildSheetsPdfFile。紙面 .sheet を1ページずつ画像にする）。印刷も同じHTML。
   ・ページ: どのページにも帳票名・工事名・表の見出し・「n／総ページ数」。合計の行は、その表の最後の行と同じページに置く
     （合計の行だけが次のページに離れない）。
   ・未入力は「未入力」と表示し、合計に入れない（0にしない）。
   ========================================================== */

import { escapeHtml } from "../utils.js";
import { centsText } from "./dailyBillingSheet.js";
import { monthLineItems, signedText, NO_BUILDING } from "./billingReconcile.js";
import { siteUsesBuildings } from "./vendorNames.js";
import { sealSvg } from "../report-output/directorSeal.js";

/** 用紙。capacity は1ページに入る高さ（業者の行の高さを1とした単位）。請求人工PDFは A4 縦（2026-11-17。利用者の指定。行数が多い月は2ページ以上） */
export const VENDOR_SHEET_PAPER = { label: "A4横", widthMm: 297, heightMm: 210, marginMm: 10, capacity: 19 };
export const BILLING_SHEET_PAPER = { label: "A4縦", widthMm: 210, heightMm: 297, marginMm: 10, capacity: 30 };
export const BILLING_SHEET_TITLE = "請求人工 月間明細";
export const ACTIVITY_SHEET_TITLE = "業者別稼働 月間明細";
export const RECONCILE_SHEET_TITLE = "請求人工・実稼働 照合表";
/** 1ページに入る高さ（業者の行の高さを1とした単位） */
export const PAGE_CAPACITY = 19;
const U = { title: 1, head: 1.1, row: 1, total: 1.2, note: 0.62 };

const WEEK = "日月火水木金土";
const md = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return iso || ""; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return `${Number(m[2])}/${Number(m[3])}（${WEEK[d.getDay()]}）`; };
export const monthText = (month) => { const [y, m] = String(month || "").split("-").map(Number); return y && m ? `${y}年${m}月` : ""; };
const stampLabel = (d) => { const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const na = (t) => `<span class="na">${escapeHtml(t)}</span>`;
const txt = (s, limit, empty = "") => (!s ? (empty ? na(empty) : "") : s.length > limit ? `<span class="long">${escapeHtml(s)}</span>` : escapeHtml(s));

/** ファイル名に使えない文字を除く */
const safe = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
export const vendorSheetFileName = (vendorName, month, kind) => `${safe(vendorName) || "業者"}_${monthText(month)}_${kind}.pdf`;

/**
 * 表の並び（blocks）をページに割り付ける。block = { title, cols: [{label, w?, cls?}], rows: [{cells, cls?}], total?: {cells} }
 * @returns {{block: object, title: string, cont: boolean, rows: object[], total: object|null}[][]} ページごとの表の断片
 */
export function paginateBlocks(blocks, notesCount = 0, capacity = PAGE_CAPACITY) {
  const pages = [[]];
  let used = 0;
  const newPage = () => { pages.push([]); used = 0; };
  const cur = () => pages[pages.length - 1];
  for (const block of blocks) {
    const rows = block.rows.length ? block.rows : [{ cells: [`<span class="na">${escapeHtml(block.empty || "記録がありません。")}</span>`], span: true }];
    const startNeed = U.title + U.head + U.row + (rows.length === 1 && block.total ? U.total : 0);
    if (used > 0 && used + startNeed > capacity) newPage();
    let frag = { block, title: block.title, cont: false, rows: [], total: null };
    cur().push(frag);
    used += U.title + U.head;
    rows.forEach((row, i) => {
      const last = i === rows.length - 1;
      const need = U.row + (last && block.total ? U.total : 0);
      if (used + need > capacity && frag.rows.length) {
        newPage();
        frag = { block, title: block.title, cont: true, rows: [], total: null };
        cur().push(frag);
        used += U.title + U.head;
      }
      frag.rows.push(row);
      used += U.row;
    });
    if (block.total) { frag.total = block.total; used += U.total; }
  }
  if (notesCount && used + notesCount * U.note > capacity) newPage();
  return pages;
}

function tableHtml(frag) {
  const b = frag.block;
  const cols = b.cols.map((c) => `<col${c.w ? ` style="width:${c.w}mm"` : ""}>`).join("");
  const head = b.cols.map((c) => `<th>${c.label}</th>`).join("");
  const body = frag.rows.map((r) => r.span
    ? `<tr><td colspan="${b.cols.length}" class="none">${r.cells[0]}</td></tr>`
    : `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map((h, i) => `<td${b.cols[i]?.cls ? ` class="${b.cols[i].cls}"` : ""}>${h}</td>`).join("")}</tr>`).join("");
  const total = frag.total ? `<tr class="total">${frag.total.cells.map((h, i) => `<td${frag.total.spans?.[i] ? ` colspan="${frag.total.spans[i]}"` : ""}${frag.total.cls?.[i] ? ` class="${frag.total.cls[i]}"` : ""}>${h}</td>`).join("")}</tr>` : "";
  return `<h2 class="bt">${escapeHtml(frag.title)}${frag.cont ? "（続き）" : ""}</h2><table class="list"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table>`;
}

/**
 * 帳票の印刷用HTML（A4横。1ページ＝1つの .sheet）
 * @param {{title: string, info: {label: string, html: string, w?: number}[], blocks: object[], notes: string[], generatedAt: Date, docTitle: string}} p
 */
export function renderVendorSheetsHtml({ title, info, blocks, notes = [], generatedAt = new Date(), docTitle, paper = VENDOR_SHEET_PAPER, sealBox = null }) {
  const P = paper;
  const landscape = P.widthMm > P.heightMm;
  const pages = paginateBlocks(blocks, notes.length, P.capacity || PAGE_CAPACITY);
  const n = pages.length;
  // 見出しの欄: 横は1行、縦は2つずつの行に分ける（幅が足りないため）
  const perRow = landscape ? info.length : 2;
  const infoRows = []; for (let i = 0; i < info.length; i += perRow) infoRows.push(info.slice(i, i + perRow));
  const infoCols = infoRows[0].map((c) => `<col style="width:${c.lw || 18}mm"><col${c.w && landscape ? ` style="width:${c.w}mm"` : c.pw ? ` style="width:${c.pw}mm"` : ""}>`).join("");
  const infoRow = infoRows.map((row) => `<tr>${row.map((c) => `<th>${escapeHtml(c.label)}</th><td>${c.html}</td>`).join("")}</tr>`).join("");
  const sheets = pages.map((frags, pi) => {
    const last = pi === n - 1;
    return `<section class="sheet">
      <header class="hd"><h1>${escapeHtml(title)}</h1><div class="page">${pi + 1}／${n}ページ</div></header>
      ${sealBox ? `<div class="info-wrap"><table class="info"><colgroup>${infoCols}</colgroup>${infoRow}</table>${pi === 0 ? sealBoxHtml(sealBox) : `<div class="sealbox sealbox-blank"></div>`}</div>` : `<table class="info"><colgroup>${infoCols}</colgroup>${infoRow}</table>`}
      ${frags.map(tableHtml).join("")}
      ${last ? (notes.length ? `<ul class="notes">${notes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "") : `<p class="cont">次のページへ続きます</p>`}
      <footer class="ft"><span>作成 ${escapeHtml(stampLabel(generatedAt))}（保存済みの日報から作成）</span><span>${pi + 1}／${n}</span></footer>
    </section>`;
  }).join("");
  const W = P.widthMm - P.marginMm * 2, H = P.heightMm - P.marginMm * 2;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle || title)}</title>
<style>
@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: ${P.marginMm}mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #111; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "YuGothic", Meiryo, "Noto Sans JP", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: ${W}mm; height: ${H}mm; overflow: hidden; position: relative; background: #fff; page-break-after: always; break-after: page; display: flex; flex-direction: column; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.hd { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 0.6mm solid #111; padding-bottom: 1.5mm; }
.hd h1 { margin: 0; font-size: 16pt; letter-spacing: 0.08em; }
.hd .page { font-size: 10pt; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.info { margin: 2mm 0 1mm; font-size: 9.5pt; }
.info th, .info td { border: 0.25mm solid #555; padding: 0.8mm 1.6mm; height: 8mm; text-align: left; vertical-align: middle; overflow: hidden; }
.info th { background: #eee; font-weight: bold; white-space: nowrap; }
.info td { white-space: nowrap; text-overflow: ellipsis; }
.info-wrap { display: flex; gap: 2mm; align-items: stretch; margin: 2mm 0 1mm; }
.info-wrap .info { margin: 0; flex: 1 1 auto; }
.sealbox { flex: 0 0 22mm; border: 0.25mm solid #555; display: flex; flex-direction: column; }
.sealbox-blank { border-color: transparent; }
.sealbox .sl { background: #eee; font-size: 8.5pt; font-weight: bold; text-align: center; border-bottom: 0.25mm solid #555; height: 4.6mm; line-height: 4.6mm; letter-spacing: 0.3em; }
.sealbox .sv { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; }
.sealbox .sd { font-size: 6pt; color: #555; text-align: center; height: 3mm; line-height: 3mm; }
.bt { margin: 1.6mm 0 0.8mm; font-size: 10.5pt; height: 5.6mm; line-height: 5.6mm; }
.list { font-size: 10pt; }
.list th, .list td { border: 0.25mm solid #444; padding: 0 1.6mm; height: 7.6mm; vertical-align: middle; overflow: hidden; line-height: 1.15; }
.list thead th { background: #e4e8ee; font-size: 9pt; height: 8.4mm; text-align: center; line-height: 1.1; }
.list td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.list td.c { text-align: center; white-space: nowrap; }
.list td.nw { white-space: nowrap; }
.list .long { display: block; font-size: 7.6pt; line-height: 1.1; max-height: 2.2em; overflow: hidden; }
.list .na { color: #777; font-size: 8.5pt; }
.list .bad { color: #a33; font-weight: bold; }
.list .sub { color: #555; font-size: 7.5pt; }
.list td.none { text-align: center; color: #555; }
.list tr.total td { background: #f1f1f1; font-weight: bold; border-top: 0.7mm double #111; height: 9mm; font-size: 11pt; }
.list tr.st-diff td.state, .list tr.st-missing td.state, .list tr.st-nameReview td.state, .list tr.st-noBuilding td.state, .list tr.st-unbilled td.state { color: #a33; font-weight: bold; }
.notes { margin: 2mm 0 0; padding-left: 4.5mm; font-size: 8pt; line-height: 1.35; color: #222; }
.cont { margin: 1.5mm 0 0; font-size: 8.5pt; color: #555; text-align: right; }
.ft { margin-top: auto; display: flex; justify-content: space-between; font-size: 8pt; color: #555; border-top: 0.2mm solid #999; padding-top: 1mm; }
@media screen { body { background: #ccc; padding: 6mm; } .sheet { margin: 0 auto 6mm; box-shadow: 0 0 2mm rgba(0,0,0,.3); } }
@media print { body { background: #fff; padding: 0; } .sheet { margin: 0; box-shadow: none; } }
</style></head><body>${sheets}</body></html>`;
}

/* ---------- 共通: 見出しの欄 ---------- */
function infoCells(site, month, vendorName) {
  const cells = [
    { label: "工事名", html: escapeHtml(site?.name || "（工事名なし）") },
    { label: "工事番号", html: (site?.constructionNumber || "").trim() ? escapeHtml(site.constructionNumber.trim()) : na("未登録"), w: 30, pw: 44 },
    { label: "対象年月", html: escapeHtml(monthText(month)), w: 26 }
  ];
  if (vendorName != null) cells.push({ label: "業者名", html: escapeHtml(vendorName), w: 62, lw: 16, pw: 44 });
  return cells;
}
const namesNote = (names, display) => (names.length > 1 || (names[0] && names[0] !== display) ? `日報上の業者名の表記: ${names.join("・")}（同じ業者として確認済みの名前をまとめています）。` : "");

/** 小計（棟・職種ごと）を作る */
function subtotals(items, keyOf, labelOf, valueOf) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it);
    const e = m.get(k) || { key: k, label: labelOf(it), value: 0, days: new Set(), rows: 0, blank: 0 };
    const v = valueOf(it);
    if (v != null) { e.value += v; e.days.add(it.date); e.rows++; } else e.blank++;
    if (k) e.label = labelOf(it);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) || String(a.label).localeCompare(String(b.label), "ja"));
}

/** 業者の一覧（その月に請求人工か稼働がある業者） */
export function monthVendors({ site, reports, month, today }) {
  const items = monthLineItems({ site, reports, month, today });
  const m = new Map();
  for (const it of items) {
    const e = m.get(it.vendorId) || { vendorId: it.vendorId, vendorName: it.vendorName, names: new Set(), billingRows: 0, workRows: 0 };
    e.names.add(it.rawName);
    if (it.billing.state !== "blank") e.billingRows++;
    if (it.workers > 0) e.workRows++;
    m.set(it.vendorId, e);
  }
  return [...m.values()].map((e) => ({ ...e, names: [...e.names] })).sort((a, b) => a.vendorName.localeCompare(b.vendorName, "ja"));
}

/* ---------- 請求人工PDF（業者ごと・月）---------- */
/** 所長の欄（1ページ目の見出しの欄の右）。seal が無ければ空欄（手書き・押印用） */
function sealBoxHtml(box) {
  const s = box.seal;
  const d = s?.stampedAt ? new Date(s.stampedAt) : null;
  const dt = d && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : "";
  return `<div class="sealbox"><div class="sl">所長</div><div class="sv">${s?.name ? sealSvg(s.name, 11) : ""}</div><div class="sd">${escapeHtml(dt)}</div></div>`;
}

export function buildVendorBillingSheet({ site, reports, month, today, vendorId, generatedAt = new Date(), seal = null }) {
  const useB = siteUsesBuildings(site);
  const all = monthLineItems({ site, reports, month, today }).filter((it) => it.vendorId === vendorId);
  // 請求人工が入力された行と、稼働したのに請求人工が未入力・要確認の行（稼働人数は載せない）
  const items = all.filter((it) => it.billing.state !== "blank" || it.workers > 0);
  const vendorName = all[0]?.vendorName || "";
  const names = [...new Set(all.map((it) => it.rawName))];
  const cents = (it) => (it.billing.state === "ok" ? it.billing.cents : null);
  const total = items.reduce((s, it) => s + (cents(it) || 0), 0);
  const entered = items.filter((it) => it.billing.state === "ok").length;
  const blank = items.filter((it) => it.billing.state === "blank").length;
  const invalid = items.filter((it) => it.billing.state === "invalid").length;
  const cell = (it) => it.billing.state === "ok" ? `${escapeHtml(centsText(it.billing.cents))}<span class="sub"> 人工</span>` : it.billing.state === "blank" ? na("未入力") : `<span class="bad">要確認（${escapeHtml(it.billing.raw)}）</span>`;
  // A4 縦（幅 190mm）に合わせた列幅。備考は短い文言にして2行まで
  const cols = [{ label: "日付", w: 25, cls: "nw" }, { label: "日の状態", w: 22, cls: "c" }, ...(useB ? [{ label: "棟", w: 26 }] : []), { label: "職種" }, { label: "請求人工", w: 30, cls: "num" }, { label: "備考", w: 41 }];
  const rows = items.map((it) => ({ cells: [escapeHtml(md(it.date)), escapeHtml(it.work ? "通常作業" : it.dayStatusLabel), ...(useB ? [txt(it.buildingLabel, 8)] : []), txt(it.trade, useB ? 12 : 18), cell(it), it.billing.state === "blank" ? `<span class="long">請求人工が未入力です（合計に含めていません）</span>` : it.billing.state === "invalid" ? `<span class="long">値を確認してください（合計に含めていません）</span>` : ""] }));
  const span = useB ? 4 : 3;
  const blocks = [{ title: "日付別の請求人工", cols, rows, empty: "この月の請求人工の記録はありません。", total: { cells: [`月間請求人工 合計（入力済み ${entered}件）`, `${escapeHtml(centsText(total))}<span class="sub"> 人工</span>`, ""], spans: [span], cls: ["", "num", ""] } }];
  const sub = (keyOf, labelOf, title, label) => {
    const list = subtotals(items, keyOf, labelOf, cents);
    return { title, cols: [{ label }, { label: "請求人工", w: 36, cls: "num" }, { label: "入力日数", w: 28, cls: "num" }], rows: list.map((e) => ({ cells: [txt(e.label, 24), e.rows ? `${escapeHtml(centsText(e.value))}<span class="sub"> 人工</span>${e.blank ? `<span class="sub">（未入力 ${e.blank}件）</span>` : ""}` : na(`未入力（${e.blank}件）`), `${e.days.size}日`] })) };
  };
  if (useB) blocks.push(sub((it) => it.buildingKey, (it) => it.buildingLabel, "棟別の小計", "棟"));
  blocks.push(sub((it) => it.trade, (it) => it.trade, "職種別の小計", "職種"));
  const notes = [
    "請求人工は、日報（朝礼入力・請求人工入力を含む）の請求人工欄に入力された値だけです。稼働人数・作業時間からは計算していません。",
    `入力済み ${entered}件${blank ? `・未入力 ${blank}件` : ""}${invalid ? `・要確認 ${invalid}件` : ""}${blank + invalid ? "（未入力・要確認は合計に含めていません。0人工として扱っていません）" : ""}。`,
    namesNote(names, vendorName)
  ].filter(Boolean);
  const html = renderVendorSheetsHtml({ title: BILLING_SHEET_TITLE, info: infoCells(site, month, vendorName), blocks, notes, generatedAt, docTitle: vendorSheetFileName(vendorName, month, "請求人工").replace(/\.pdf$/, ""), paper: BILLING_SHEET_PAPER, sealBox: { seal } });
  return { vendorName, names, items, total: centsText(total), totalCents: total, entered, blank, invalid, html, fileName: vendorSheetFileName(vendorName, month, "請求人工"), paper: BILLING_SHEET_PAPER };
}

/* ---------- 業者別稼働PDF（業者ごと・月）---------- */
export function buildVendorActivitySheet({ site, reports, month, today, vendorId, generatedAt = new Date() }) {
  const useB = siteUsesBuildings(site);
  const all = monthLineItems({ site, reports, month, today }).filter((it) => it.vendorId === vendorId);
  const items = all.filter((it) => it.workers > 0); // 稼働した行だけ（請求人工は載せない）
  const vendorName = all[0]?.vendorName || "";
  const names = [...new Set(all.map((it) => it.rawName))];
  const workers = items.reduce((s, it) => s + it.workers, 0);
  const days = new Set(items.map((it) => it.date)).size;
  const cols = [{ label: "日付", w: 26, cls: "nw" }, ...(useB ? [{ label: "棟", w: 30 }] : []), { label: "職種", w: 44 }, { label: "稼働人数", w: 26, cls: "num" }, { label: "作業内容" }];
  const rows = items.map((it) => ({ cells: [escapeHtml(md(it.date)), ...(useB ? [txt(it.buildingLabel, 9)] : []), txt(it.trade, 13), `${it.workers}<span class="sub"> 人</span>`, txt(it.workContent, 46, "（作業内容なし）")] }));
  const span = useB ? 3 : 2;
  const blocks = [{ title: "日付別の実稼働人数", cols, rows, empty: "この月の稼働はありません。", total: { cells: [`月間 延べ稼働人数（稼働日数 ${days}日）`, `${workers}<span class="sub"> 人</span>`, `月間 実稼働人日 ${workers} 人日`], spans: [span], cls: ["", "num", ""] } }];
  const sub = (keyOf, labelOf, title, label) => {
    const list = subtotals(items, keyOf, labelOf, (it) => it.workers);
    return { title, cols: [{ label }, { label: "延べ稼働人数", w: 34, cls: "num" }, { label: "実稼働人日", w: 34, cls: "num" }, { label: "稼働日数", w: 28, cls: "num" }], rows: list.map((e) => ({ cells: [txt(e.label, 30), `${e.value}<span class="sub"> 人</span>`, `${e.value}<span class="sub"> 人日</span>`, `${e.days.size}日`] })) };
  };
  if (useB) blocks.push(sub((it) => it.buildingKey, (it) => it.buildingLabel, "棟別の稼働", "棟"));
  blocks.push(sub((it) => it.trade, (it) => it.trade, "職種別の稼働人数", "職種"));
  const notes = [
    "実稼働は業者管理の業者別稼働と同じ決まりです（通常作業の日報だけ。現場作業なし・休工日・雨天作業不可日・事務作業日、工期開始日より前の日報は数えません）。",
    "実稼働人日＝延べ稼働人数×1（1人＝1人日。03-2 の稼動人数表・業者別稼働の実績人工と同じ）。作業時間からは計算していません。請求人工はこの帳票に載せていません。",
    namesNote(names, vendorName)
  ].filter(Boolean);
  const html = renderVendorSheetsHtml({ title: ACTIVITY_SHEET_TITLE, info: infoCells(site, month, vendorName), blocks, notes, generatedAt, docTitle: vendorSheetFileName(vendorName, month, "業者別稼働").replace(/\.pdf$/, "") });
  return { vendorName, names, items, workers, manDays: workers, days, html, fileName: vendorSheetFileName(vendorName, month, "業者別稼働"), paper: VENDOR_SHEET_PAPER };
}

/* ---------- 照合表PDF ---------- */
const VIEW_TITLES = { vendor: "業者別（全棟の合計）", building: "棟別（全業者）", vendorBuilding: "業者・棟別" };

export function buildReconcileSheetHtml({ site, reconciliation: rc, generatedAt = new Date() }) {
  const showV = rc.view !== "building", showB = rc.view !== "vendor", showT = rc.byTrade;
  const cols = [
    ...(showV ? [{ label: "業者名" }] : []),
    ...(showB ? [{ label: "棟", w: showV ? 30 : null }] : []),
    ...(showT ? [{ label: "職種", w: 34 }] : []),
    { label: "稼働日数", w: 20, cls: "num" }, { label: "延べ<br>稼働人数", w: 22, cls: "num" }, { label: "実稼働<br>人日", w: 22, cls: "num" },
    { label: "請求人工", w: 24, cls: "num" }, { label: "差異<br><small>（請求−実稼働）</small>", w: 26, cls: "num" }, { label: "照合状態", w: 30, cls: "c state" }
  ];
  const stateText = (r) => `${escapeHtml(r.stateLabel)}${r.missingRows + r.invalidRows ? `<br><span class="sub">未入力 ${r.missingRows + r.invalidRows}件</span>` : ""}`;
  const rows = rc.rows.map((r) => ({ cls: `st-${r.state}`, cells: [
    ...(showV ? [txt(r.vendorName, showB || showT ? 18 : 30)] : []),
    ...(showB ? [txt(r.buildingLabel || NO_BUILDING, 10)] : []),
    ...(showT ? [txt(r.trade, 11)] : []),
    `${r.workDays}日`, `${r.workers}人`, `${r.manDays}`, r.billing == null ? na("未入力") : escapeHtml(r.billing), escapeHtml(signedText(r.diffCents, r.billing)), stateText(r)
  ] }));
  const span = (showV ? 1 : 0) + (showB ? 1 : 0) + (showT ? 1 : 0) + 1;
  const t = rc.totals;
  const blocks = [{ title: `照合表（${VIEW_TITLES[rc.view]}${showT ? "・職種別" : ""}）`, cols, rows, empty: "この月の稼働・請求人工の記録はありません。", total: { cells: ["合計", `${t.workers}人`, `${t.manDays}`, escapeHtml(t.billing), escapeHtml(signedText(t.diffCents)), ""], spans: [span], cls: ["", "num", "num", "num", "num", ""] } }];
  // 差異・未入力のある日の明細（一致以外の単位の、差異か未入力のある日）
  const gapRows = [];
  for (const r of rc.rows) {
    if (r.state === "match") continue;
    for (const d of r.days) if (d.hasGap) gapRows.push({ r, d });
  }
  blocks.push({
    title: "差異・未入力のある日",
    cols: [...(showV ? [{ label: "業者名" }] : []), ...(showB ? [{ label: "棟", w: 30 }] : []), ...(showT ? [{ label: "職種", w: 30 }] : []), { label: "日付", w: 26, cls: "nw" }, { label: "日の状態", w: 24, cls: "c" }, { label: "実稼働人日", w: 24, cls: "num" }, { label: "請求人工", w: 24, cls: "num" }, { label: "差異", w: 20, cls: "num" }, { label: "備考", w: 50 }],
    rows: gapRows.map(({ r, d }) => ({ cells: [
      ...(showV ? [txt(r.vendorName, 18)] : []), ...(showB ? [txt(r.buildingLabel || NO_BUILDING, 9)] : []), ...(showT ? [txt(r.trade, 10)] : []),
      escapeHtml(md(d.date)), escapeHtml(d.work ? "通常作業" : d.dayStatusLabel), `${d.manDays}`, d.billing == null ? na("未入力") : escapeHtml(d.billing), escapeHtml(signedText(d.diffCents, d.billing)),
      escapeHtml([d.missingRows ? `請求人工 未入力 ${d.missingRows}件` : "", d.invalidRows ? `請求人工 要確認 ${d.invalidRows}件` : "", !d.work && d.billingRows ? "稼働に数えない日の請求人工" : ""].filter(Boolean).join("・"))
    ] })),
    empty: "差異・未入力のある日はありません。"
  });
  const notes = [
    "実稼働人日＝通常作業の日報の稼働人数（実績人数）の合計×1（1人＝1人日。業者別稼働・03-2 と同じ決まり。工期開始日より前は数えません）。請求人工＝請求人工欄に入力された値だけ（未入力・要確認は合計に含めず、0にしていません）。",
    "差異＝請求人工−実稼働人日（請求人工が未入力の行は「—」。合計の差異は、未入力の業者・日の実稼働も含めた値です）。照合のために日報・請求人工は変更していません。業者名確認待ち＝表記の違う似た業者名が未確認（業者管理の［業者名の確認］で確認してください）。"
  ];
  return renderVendorSheetsHtml({ title: RECONCILE_SHEET_TITLE, info: infoCells(site, rc.month, null), blocks, notes, generatedAt, docTitle: `${RECONCILE_SHEET_TITLE}_${safe(site?.name)}_${monthText(rc.month)}` });
}
export const reconcileFileName = (siteName, month) => `請求人工実稼働照合表_${safe(siteName) || "現場"}_${monthText(month)}.pdf`;
