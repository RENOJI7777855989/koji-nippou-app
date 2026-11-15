/* ==========================================================
   業者別稼働・請求人工一覧（A4横。2026-11-15）
   朝礼入力（chorei-dialog.js）で入れた、1日分の日報の業者の行ごとの「稼働人数」と「請求人工」を一覧の帳票にする。
   DOM・DB に触れない純粋関数（モデル → 印刷用HTML）。PDF は現場掲示のPDFと同じ方式（board-pdf.js）で、この印刷用HTMLの
   紙面（.sheet）を1ページずつ画像にして作る。印刷も同じHTMLを使う。
   ・データは保存済みの日報（companies[]）を読むだけ。新しい項目は作らない・何も書き込まない。
     業者名 companyName・職種 occupation・棟 buildingName・稼働人数 actualWorkerCount・請求人工 billingManDays。
   ・請求人工の読み方（朝礼入力・日報画面と同じ）: billingManDays が有れば（空欄 "" を含む）それだけを使う。
     billingManDays が無い（undefined・null）ときだけ、以前の版の manDays を読む。両方を足すことはない。
   ・1行＝日報の業者の行1行（同じ業者でも職種・棟が違えば別の行。まとめない）。並びは日報の行の順（朝礼入力と同じ）。
   ・稼働人数と請求人工は別々に合計する（足したり、片方から片方を決めたりしない）。
     未入力は「未入力」と表示して合計に入れない（0にしない）。決まりに合わない古い値は「要確認」と表示して合計に入れない。
     請求人工の合計は 0.01 人工単位の整数で足す（小数の誤差を出さない）。
   ・ページ: 1ページの行数を決めて分け、どのページにも工事名・帳票名・表の見出し・「n／総ページ数」を出す。
     合計の行と注記は最後のページに置き、最後のページには業者の行を少なくとも1行残す（合計だけが次のページに離れない）。
   ========================================================== */

import { escapeHtml } from "../utils.js";
import { parseBillingInput } from "./billingValue.js";
import { dayStatusOf, labelOf, DAY_STATUSES } from "../dashboard/dailyFlow.js";

export const DAILY_BILLING_TITLE = "業者別稼働・請求人工一覧";
/** 用紙: A4 横・余白 10mm（PDF の画像の置き方と印刷の @page で同じ値を使う） */
export const DAILY_BILLING_PAPER = { label: "A4横", widthMm: 297, heightMm: 210, marginMm: 10 };
/** 1ページの業者の行の数（最後以外のページ）と、最後のページ（合計の行・注記の分を空ける） */
export const ROWS_PER_PAGE = 18;
export const ROWS_ON_LAST_PAGE = 15;

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/** 請求人工の元の値（billingManDays が有ればそれ。無いときだけ manDays） */
export function billingRawOf(c) {
  if (c?.billingManDays !== undefined && c?.billingManDays !== null) return String(c.billingManDays);
  if (c?.manDays !== undefined && c?.manDays !== null) return String(c.manDays);
  return "";
}

function readCount(v) {
  if (isBlank(v)) return { state: "blank", value: null };
  const s = String(v).trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(s)) return { state: "invalid", value: null, raw: String(v) };
  return { state: "ok", value: Number(s) };
}

function readBilling(c) {
  const raw = billingRawOf(c);
  if (isBlank(raw)) return { state: "blank", value: null, cents: 0 };
  const b = parseBillingInput(raw);
  if (!b) return { state: "invalid", value: null, raw, cents: 0 };
  return { state: "ok", value: b.value, cents: Math.round(Number(b.value) * 100) };
}

const centsText = (cents) => {
  const s = (cents / 100).toFixed(2);
  return s.replace(/\.?0+$/, "") || "0";
};

/** 1日分の日報 → 帳票のモデル（ページ分けを含む） */
export function buildDailyBillingSheet({ site, report, generatedAt = new Date() }) {
  const companies = (report?.companies || []).filter((c) => (c.companyName || "").trim() || (c.occupation || "").trim());
  const rows = companies.map((c, i) => ({
    no: i + 1,
    companyId: c.companyId || "",
    vendor: (c.companyName || "").trim(),
    trade: (c.occupation || "").trim(),
    building: (c.buildingName || "").trim(),
    count: readCount(c.actualWorkerCount),
    billing: readBilling(c)
  }));
  const n = (pred) => rows.filter(pred).length;
  const totals = {
    rows: rows.length,
    count: rows.reduce((s, r) => s + (r.count.state === "ok" ? r.count.value : 0), 0),
    countEntered: n((r) => r.count.state === "ok"),
    countBlank: n((r) => r.count.state === "blank"),
    countInvalid: n((r) => r.count.state === "invalid"),
    billingCents: rows.reduce((s, r) => s + r.billing.cents, 0),
    billingEntered: n((r) => r.billing.state === "ok"),
    billingBlank: n((r) => r.billing.state === "blank"),
    billingInvalid: n((r) => r.billing.state === "invalid")
  };
  totals.billing = centsText(totals.billingCents);

  // ページ分け: 残りが最後のページに収まるならそこで終わり、収まらなければ1ページ分を取る
  const pages = [];
  let rest = rows.slice();
  while (rest.length > ROWS_ON_LAST_PAGE) {
    // 最後のページに少なくとも1行残す（このページで全部取ると、合計の行だけが次のページになる）
    const take = Math.min(ROWS_PER_PAGE, rest.length - 1);
    pages.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  pages.push(rest);

  const status = dayStatusOf(report || {});
  return {
    title: DAILY_BILLING_TITLE,
    header: {
      siteName: site?.name || "",
      constructionNumber: (site?.constructionNumber || "").trim(),
      date: report?.date || "",
      weather: report?.weather || "",
      dayStatus: status,
      dayStatusLabel: status === "work" ? "" : labelOf(DAY_STATUSES, status),
      generatedAt
    },
    hasBuilding: rows.some((r) => r.building),
    rows,
    totals,
    pages
  };
}

const WEEK = "日月火水木金土";
export function dateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日（${WEEK[d.getDay()]}）`;
}
const stampLabel = (d) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const countCell = (c) => c.state === "ok" ? `${c.value}<span class="u">人</span>` : c.state === "blank" ? `<span class="na">未入力</span>` : `<span class="na bad">要確認（${escapeHtml(c.raw)}）</span>`;
const billingCell = (b) => b.state === "ok" ? `${escapeHtml(b.value)}<span class="u">人工</span>` : b.state === "blank" ? `<span class="na">未入力</span>` : `<span class="na bad">要確認（${escapeHtml(b.raw)}）</span>`;
// 長い名前は文字を小さくして2行まで（罫線・隣の欄に重ねない）
const textCell = (s, limit, empty) => {
  if (!s) return `<span class="na">${empty}</span>`;
  return s.length > limit ? `<span class="long">${escapeHtml(s)}</span>` : escapeHtml(s);
};

/** 帳票のモデル → 印刷用HTML（A4横。1ページ＝1つの .sheet） */
export function buildDailyBillingSheetHtml(model) {
  const { header: h, totals: t, hasBuilding } = model;
  const P = DAILY_BILLING_PAPER;
  const pageCount = model.pages.length;
  const cols = hasBuilding
    ? `<col style="width:13mm"><col style="width:34mm"><col><col style="width:52mm"><col style="width:34mm"><col style="width:38mm">`
    : `<col style="width:13mm"><col><col style="width:62mm"><col style="width:36mm"><col style="width:40mm">`;
  const head = `<tr><th>No.</th>${hasBuilding ? "<th>棟</th>" : ""}<th>業者名</th><th>職種</th><th>稼働人数</th><th>請求人工</th></tr>`;
  const notes = [
    "稼働人数＝朝礼入力・日報の実績人数、請求人工＝朝礼入力・日報の請求人工。2つは別の値で、合計もそれぞれ別に計算しています（請求人工を稼働人数に足していません）。",
    `稼働人数: 入力済み ${t.countEntered}／${t.rows}行${t.countBlank ? `・未入力 ${t.countBlank}行` : ""}${t.countInvalid ? `・要確認 ${t.countInvalid}行` : ""}${t.countBlank + t.countInvalid ? "（合計に含めていません）" : ""}`,
    `請求人工: 入力済み ${t.billingEntered}／${t.rows}行${t.billingBlank ? `・未入力 ${t.billingBlank}行` : ""}${t.billingInvalid ? `・要確認 ${t.billingInvalid}行` : ""}${t.billingBlank + t.billingInvalid ? "（合計に含めていません。未入力を0人工として扱っていません）" : ""}`
  ];
  const sheets = model.pages.map((rows, pi) => {
    const last = pi === pageCount - 1;
    const body = rows.map((r) => `<tr>
        <td class="no">${r.no}</td>${hasBuilding ? `<td>${textCell(r.building, 10, "（棟未設定）")}</td>` : ""}
        <td>${textCell(r.vendor, hasBuilding ? 20 : 26, "（業者名なし）")}</td><td>${textCell(r.trade, hasBuilding ? 14 : 16, "（職種未入力）")}</td>
        <td class="num">${countCell(r.count)}</td><td class="num">${billingCell(r.billing)}</td></tr>`).join("");
    const empty = !model.rows.length ? `<tr><td colspan="${hasBuilding ? 6 : 5}" class="none">この日の日報に業者の行がありません。</td></tr>` : "";
    const total = last ? `<tr class="total"><td colspan="${hasBuilding ? 4 : 3}">合計（${t.rows}行）</td><td class="num">${t.count}<span class="u">人</span></td><td class="num">${escapeHtml(t.billing)}<span class="u">人工</span></td></tr>` : "";
    return `<section class="sheet">
      <header class="hd">
        <h1>${escapeHtml(model.title)}</h1>
        <div class="page">${pi + 1}／${pageCount}ページ</div>
      </header>
      <table class="info"><colgroup><col style="width:18mm"><col><col style="width:20mm"><col style="width:36mm"><col style="width:18mm"><col style="width:${h.dayStatusLabel ? 64 : 48}mm"><col style="width:16mm"><col style="width:26mm"></colgroup><tr>
        <th>工事名</th><td class="site">${escapeHtml(h.siteName || "（工事名なし）")}</td>
        <th>工事番号</th><td>${h.constructionNumber ? escapeHtml(h.constructionNumber) : '<span class="na">未登録</span>'}</td>
        <th>対象日</th><td class="date">${escapeHtml(dateLabel(h.date))}${h.dayStatusLabel ? `<span class="ds">${escapeHtml(h.dayStatusLabel)}</span>` : ""}</td>
        <th>天気</th><td>${h.weather ? escapeHtml(h.weather) : '<span class="na">未入力</span>'}</td>
      </tr></table>
      <table class="list"><colgroup>${cols}</colgroup><thead>${head}</thead><tbody>${body}${empty}${total}</tbody></table>
      ${last ? `<ul class="notes">${notes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<p class="cont">次のページへ続きます（合計は最後のページ）</p>`}
      <footer class="ft"><span>作成 ${escapeHtml(stampLabel(h.generatedAt))}（保存済みの日報から作成）</span><span>${pi + 1}／${pageCount}</span></footer>
    </section>`;
  }).join("");
  const W = P.widthMm - P.marginMm * 2, H = P.heightMm - P.marginMm * 2;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${model.title}_${h.siteName}_${h.date}`)}</title>
<style>
@page { size: A4 landscape; margin: ${P.marginMm}mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #111; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "YuGothic", Meiryo, "Noto Sans JP", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: ${W}mm; height: ${H}mm; overflow: hidden; position: relative; background: #fff; page-break-after: always; break-after: page; display: flex; flex-direction: column; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.hd { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 0.6mm solid #111; padding-bottom: 1.5mm; }
.hd h1 { margin: 0; font-size: 17pt; letter-spacing: 0.08em; }
.hd .page { font-size: 10pt; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.info { margin: 2.5mm 0 3mm; font-size: 9.5pt; }
.info th, .info td { border: 0.25mm solid #555; padding: 1mm 1.6mm; height: 8mm; text-align: left; vertical-align: middle; overflow: hidden; }
.info th { background: #eee; font-weight: bold; white-space: nowrap; }
.info td.date { white-space: nowrap; }
.info .ds { margin-left: 2mm; padding: 0 1.2mm; border: 0.25mm solid #a33; color: #a33; font-size: 8.5pt; }
.list { font-size: 11pt; }
.list th, .list td { border: 0.25mm solid #444; padding: 0 2mm; height: 7.6mm; vertical-align: middle; overflow: hidden; line-height: 1.15; }
.list thead th { background: #e4e8ee; font-size: 10pt; height: 8.4mm; text-align: center; }
.list td.no { text-align: center; }
.list td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.list .u { font-size: 8.5pt; margin-left: 0.8mm; color: #333; }
.list .long { display: block; font-size: 8.3pt; line-height: 1.1; max-height: 2.2em; overflow: hidden; }
.list .na { color: #777; font-size: 9pt; }
.list .na.bad { color: #a33; }
.list td.none { text-align: center; color: #555; height: 14mm; }
.list tr.total td { background: #f1f1f1; font-weight: bold; border-top: 0.7mm double #111; height: 9mm; font-size: 12pt; }
.list tr.total td:first-child { text-align: center; letter-spacing: 0.1em; }
.notes { margin: 2.5mm 0 0; padding-left: 4.5mm; font-size: 8.3pt; line-height: 1.4; color: #222; }
.cont { margin: 2mm 0 0; font-size: 8.5pt; color: #555; text-align: right; }
.ft { margin-top: auto; display: flex; justify-content: space-between; font-size: 8pt; color: #555; border-top: 0.2mm solid #999; padding-top: 1mm; }
@media screen { body { background: #ccc; padding: 6mm; } .sheet { margin: 0 auto 6mm; box-shadow: 0 0 2mm rgba(0,0,0,.3); } }
@media print { body { background: #fff; padding: 0; } .sheet { margin: 0; box-shadow: none; } }
</style></head><body>${sheets}</body></html>`;
}
