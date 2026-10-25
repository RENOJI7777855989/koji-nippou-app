/* ==========================================================
   稼働人数の内訳（DB・DOM非依存の純粋関数。2026-10-25）
   日報の業者の行（業者名・工種・実績人数・作業内容）から、その日と累計（工事開始から表示日まで）の稼働人数を
   「業者×工種」の単位で数え、工種ごとの合計と全体の合計を出す。現場ダッシュボード（職種別の人数・業者別稼働の累計）と
   03-2（1日分のExcel・PDF）の稼動人数表は、どちらもこの結果を使う（別々に数えない）。
   ・工種は表記ゆれ（全角半角・空白・末尾の「工事」「工」「員」「作業」・とび＝鳶）をそろえて比べる（normalizeTrade。03-2と同じ）。
     表示名は、その工種が初めて出てきた日報に書かれた名前。
   ・同じ工種でも業者が違えば別の行（例: 足場＝協栄興業・西原建設）。同じ業者でも工種が違えば別の行。
   ・業者名が同じ行は同じ業者として数える（業者名のほかに業者を見分ける項目は日報に無いため、推測で分けない）。
   ・棟: 日報に棟の項目は無い。作業内容に書かれた「RJ号棟」などを、その行の参考として拾う（人数を棟ごとに分けることはしない。
     1行に複数の棟が書かれていても、人数は行ごとに1回だけ数える）。
   ・人数は日報の実績人数（actualWorkerCount）だけ。数字でない・0以下・未入力は0人（推測で補わない）。
     工種が未入力の行の人数も全体の合計には入れる（工種の行には出せない）。業者名が未入力の行は「（業者名未入力）」。
   ・請求人工（billingManDays）は使わない。
   ========================================================== */

import { normalizeTrade } from "../report-output/tradeAttendance.js";

export const NO_VENDOR_LABEL = "（業者名未入力）";
export const NO_TRADE_LABEL = "（工種未入力）";

/** 実績人数（数字で0より大きいときだけ。それ以外は0人） */
export function workersOf(c) {
  const s = String(c?.actualWorkerCount ?? "").trim();
  if (!s) return 0;
  const n = Number(s.normalize("NFKC"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 作業内容に書かれた棟（「RJ号棟」「ＲＫ 号棟」→「RJ号棟」「RK号棟」）。見つからなければ空 */
export function buildingsInText(text) {
  const s = String(text || "").normalize("NFKC");
  const out = [];
  for (const m of s.matchAll(/([A-Za-z]{1,3}|\d{1,3})\s*号\s*棟/g)) {
    const b = `${m[1].toUpperCase()}号棟`;
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

/**
 * @param {object} p
 * @param {{companyName?:string, name?:string, occupation?:string, actualWorkerCount?:any, workContent?:string}[]} p.todayCompanies その日の業者の行（作業しない日は空で渡す）
 * @param {{date:string, companies:object[]}[]} p.historyReports 工事開始から表示日までの通常作業の日報（その日を含む）
 * @returns {{
 *   rows: {vendor:string, tradeKey:string, trade:string, today:number, cumulative:number, buildingsToday:string[]}[],
 *   trades: {tradeKey:string, label:string, today:number, cumulative:number, vendorsToday:{vendor:string, today:number, buildings:string[]}[]}[],
 *   totals: {today:number, cumulative:number},
 *   noTrade: {today:number, cumulative:number}
 * }}
 */
export function attendanceBreakdown({ todayCompanies = [], historyReports = [] }) {
  const labelOf = new Map(); // 工種のキー → 初めて出てきた名前
  const rowMap = new Map(); // 業者\0工種のキー → 行
  const rowOf = (c) => {
    const vendor = String(c?.companyName ?? c?.name ?? "").trim() || NO_VENDOR_LABEL; // 帳票のモデルは name
    const raw = String(c?.occupation ?? "").trim();
    const tradeKey = normalizeTrade(raw);
    if (tradeKey && !labelOf.has(tradeKey)) labelOf.set(tradeKey, raw);
    const k = `${vendor}\u0000${tradeKey}`;
    if (!rowMap.has(k)) rowMap.set(k, { vendor, tradeKey, trade: "", today: 0, cumulative: 0, buildingsToday: [] });
    return rowMap.get(k);
  };
  const ordered = [...historyReports].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const r of ordered) for (const c of r.companies || []) { const n = workersOf(c); const row = rowOf(c); row.cumulative += n; }
  for (const c of todayCompanies || []) {
    const n = workersOf(c);
    const row = rowOf(c);
    row.today += n;
    if (n) for (const b of buildingsInText(c.workContent)) if (!row.buildingsToday.includes(b)) row.buildingsToday.push(b);
  }
  const rows = [...rowMap.values()].filter((r) => r.today || r.cumulative);
  for (const r of rows) r.trade = r.tradeKey ? labelOf.get(r.tradeKey) : NO_TRADE_LABEL;
  const tradeMap = new Map();
  for (const r of rows) {
    if (!r.tradeKey) continue;
    if (!tradeMap.has(r.tradeKey)) tradeMap.set(r.tradeKey, { tradeKey: r.tradeKey, label: r.trade, today: 0, cumulative: 0, vendorsToday: [] });
    const t = tradeMap.get(r.tradeKey);
    t.today += r.today;
    t.cumulative += r.cumulative;
    if (r.today) t.vendorsToday.push({ vendor: r.vendor, today: r.today, buildings: r.buildingsToday });
  }
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  const noTradeRows = rows.filter((r) => !r.tradeKey);
  return {
    rows,
    trades: [...tradeMap.values()],
    totals: { today: sum(rows, "today"), cumulative: sum(rows, "cumulative") },
    noTrade: { today: sum(noTradeRows, "today"), cumulative: sum(noTradeRows, "cumulative") }
  };
}
