/* ==========================================================
   稼動人数（業種別の人数・累計）の書き込み（DB・DOM非依存の純粋関数）
   03-2「安全衛生作業打合日誌」の右側「稼動人数」表へ、日報の業者ごとの
   業種（occupation）と実績人数（actualWorkerCount）を業種別に集計して書く。

   ・業種の当てはめ: 日報の業種と様式の業種名を、表記ゆれ（全角／半角カナ、空白、末尾の
     「工事」「工」「員」「作業」、「とび」＝「鳶」）を吸収して比べ、一致した行に書く。
     一致しない業種（例: 植栽工事・美装・多能工）は、様式の空き行（業種名の無い行）に
     業種名と人数を書く。別の業種の行へは押し込まない。空き行が足りなければ書かずに警告する。
     空き行の割り当ては現場の日報全体で固定（初めて出てきた日付の順）なので、台帳の頁が
     変わっても同じ業種は同じ行になる（台帳の累計の数式が前頁の同じ行を参照するため）。
   ・人数・累計: その日の人数（O列）と、工事開始からその日までの累計（P列）。
     計（51行目）は社員を含む全体、延労働時間（52行目）は計×8時間（様式の台帳シートの数式
     「O52=O51*8」と同じ。アプリの既存の決まり「1人＝8時間」）。
   ・台帳シートは累計・計・延労働時間が様式の数式なので、その日の人数だけを書く（cumulative: false）。
     空き行の業種名も、2頁目以降は「前の頁の業種名を映す数式」なので、台帳の最初の頁にだけ書く
     （freeLabelWrites。renderLedgerWorkbook.js が先頭シートの1頁目に書く）。
   ・2026-10-25: 人数は現場ダッシュボードと同じ集計（js/dashboard/attendanceBreakdown.js）から書く。
     1日分（Excel・PDF）は、空き行をまず「その日に稼働した業種」に割り当て、残りを累計のある業種に初めて出てきた順で割り当てる
     （assignTradeRowsForDay。以前は現場全体で初めて出てきた順だけで割り当てていたため、空き行6行を前の業種が使い切ると、
     その日に稼働した業種（例: 洗浄）の行が無く、人数が計にしか入らなかった）。台帳は、頁をまたいで同じ業種を同じ行に
     置く必要があるので従来どおり（assignTradeRows）。計・延労働時間には、工種が未入力の行の人数も入れる（ダッシュボードの合計と同じ）。
   ========================================================== */

import { attendanceBreakdown } from "../dashboard/attendanceBreakdown.js";

/** 空き行の業種名の書き込み（台帳の最初の頁用。行は頁の中の位置） */
export function freeLabelWrites(cfg, assignment) {
  return [...assignment.byTrade.values()].filter((s) => s.free).map((s) => ({ cell: `${cfg.labelColumn}${s.row}`, value: s.label }));
}

/** 業種名の比較用（全角半角・空白・末尾の「工事」「工」「員」「作業」をそろえる） */
export function normalizeTrade(text) {
  let s = String(text || "").normalize("NFKC").replace(/[\s　]+/g, "");
  s = s.replace(/(工事|作業|工|員)$/, "");
  s = s.replace(/^とび$/, "鳶");
  return s;
}

/**
 * 現場の日報全体（日付順）の業種から、行の割り当てを作る。
 * @param {{rows: {row:number,label:string}[], freeRows: number[]}} cfg
 * @param {{date:string, companies:{occupation:string}[]}[]} reports 現場の日報（削除済みを除く）
 * @returns {{byTrade: Map<string,{row:number,label:string,free:boolean}>, overflow: string[]}}
 */
export function assignTradeRows(cfg, reports) {
  const byTrade = new Map();
  const overflow = [];
  const fixed = new Map(cfg.rows.map((r) => [normalizeTrade(r.label), r]));
  const free = [...(cfg.freeRows || [])];
  const ordered = [...reports].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  for (const r of ordered) {
    for (const c of r.companies || []) {
      const label = String(c.occupation || "").trim();
      const key = normalizeTrade(label);
      if (!key || byTrade.has(key)) continue;
      const hit = fixed.get(key);
      if (hit) byTrade.set(key, { row: hit.row, label: hit.label, free: false });
      else if (free.length) byTrade.set(key, { row: free.shift(), label, free: true });
      else if (!overflow.includes(label)) overflow.push(label);
    }
  }
  return { byTrade, overflow };
}

/**
 * 1日分の出力用の行の割り当て。様式に業種名のある行はその行、無い業種は空き行へ。空き行は、その日に稼働した業種を先に、
 * 次に累計のある業種を初めて出てきた順に割り当てる。入りきらない業種は overflow（書けない。計には入る）
 */
export function assignTradeRowsForDay(cfg, { todayCompanies = [], historyReports = [] }) {
  const byTrade = new Map();
  const overflow = [];
  const fixed = new Map(cfg.rows.map((r) => [normalizeTrade(r.label), r]));
  const free = [...(cfg.freeRows || [])];
  const b = attendanceBreakdown({ todayCompanies, historyReports });
  const ordered = [...b.trades.filter((t) => t.today > 0), ...b.trades.filter((t) => !t.today)];
  for (const t of ordered) {
    const hit = fixed.get(t.tradeKey);
    if (hit) byTrade.set(t.tradeKey, { row: hit.row, label: hit.label, free: false });
    else if (free.length) byTrade.set(t.tradeKey, { row: free.shift(), label: t.label, free: true });
    else overflow.push(t.label);
  }
  return { byTrade, overflow };
}

const num = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 日報1件の業種別の人数（業種のキー → 人数） */
export function countByTrade(companies) {
  const m = new Map();
  for (const c of companies || []) {
    const key = normalizeTrade(c.occupation);
    const n = num(c.actualWorkerCount);
    if (!key || !n) continue;
    m.set(key, (m.get(key) || 0) + n);
  }
  return m;
}

/**
 * 稼動人数表への書き込み。
 * @param {object} cfg mapping.tradeAttendance
 * @param {object} p
 * @param {{byTrade:Map, overflow:string[]}} p.assignment assignTradeRows の結果
 * @param {object[]} p.todayCompanies その日の業者
 * @param {object[]} [p.historyReports] 工事開始からその日までの日報（累計用。その日を含む）
 * @param {number} [p.supervisorsToday] 社員（現場監督）のその日の人数
 * @param {number} [p.supervisorsCumulative] 社員の累計
 * @param {boolean} [p.cumulative=true] 累計・計・延労働時間を書くか（台帳シートは数式なので false）
 * @param {string[]} [p.freeLabelTrades] 空き行の業種名を書く対象（既定: その日・累計のある業種）
 */
export function buildTradeAttendanceWrites(cfg, { assignment, todayCompanies, historyReports = [], supervisorsToday = 0, supervisorsCumulative = 0, cumulative = true, writeLabels = true }) {
  const writes = [];
  const warnings = [];
  // 人数はダッシュボードと同じ集計（業者×工種の行を工種ごとに合計）
  const b = attendanceBreakdown({ todayCompanies, historyReports });
  const today = new Map(b.trades.map((t) => [t.tradeKey, t.today]));
  const total = new Map(b.trades.map((t) => [t.tradeKey, t.cumulative]));
  const col = (c, row) => `${c}${row}`;
  for (const [key, slot] of assignment.byTrade) {
    const t = today.get(key) || 0;
    const sum = total.get(key) || 0;
    const show = t > 0 || (cumulative && sum > 0);
    if (!show) continue;
    if (slot.free && writeLabels) writes.push({ cell: col(cfg.labelColumn, slot.row), value: slot.label });
    if (t > 0) writes.push({ cell: col(cfg.countColumn, slot.row), value: t, numeric: true });
    if (cumulative && sum > 0) writes.push({ cell: col(cfg.cumulativeColumn, slot.row), value: sum, numeric: true });
  }
  for (const label of assignment.overflow) {
    const key = normalizeTrade(label);
    const t = today.get(key) || 0, sum = total.get(key) || 0;
    // 行が足りないのは「業種の行に出せない」だけで、人数は計・累計・延労働時間に入っている（1日分・台帳とも）
    if (t) warnings.push(`業種「${label}」（本日${t}人）は稼動人数表に書ける行が足りないため業種の行には出していません（人数は計・累計に含めています）`);
    else if (cumulative && sum) warnings.push(`業種「${label}」（累計${sum}人）は稼動人数表に書ける行が足りないため業種の行には出していません（人数は累計に含めています）`);
  }
  if (b.noTrade.today) warnings.push(`工種が未入力の業者の人数（本日${b.noTrade.today}人）は、稼動人数表の業種の行には出せません（人数は計・累計に含めています）`);
  // 計・延労働時間: 全員（行の無い業種・工種未入力を含む）＋社員。ダッシュボードの合計と同じ
  const todaySum = (supervisorsToday || 0) + b.totals.today;
  const cumulativeSum = (supervisorsCumulative || 0) + b.totals.cumulative;
  if (cumulative) {
    const hours = cfg.hoursPerPerson || 8;
    if (todaySum > 0) writes.push({ cell: col(cfg.countColumn, cfg.totalRow), value: todaySum, numeric: true }, { cell: col(cfg.countColumn, cfg.laborHoursRow), value: todaySum * hours, numeric: true });
    if (cumulativeSum > 0) writes.push({ cell: col(cfg.cumulativeColumn, cfg.totalRow), value: cumulativeSum, numeric: true }, { cell: col(cfg.cumulativeColumn, cfg.laborHoursRow), value: cumulativeSum * hours, numeric: true });
  }
  return { writes, warnings };
}
