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
   ========================================================== */

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
  const today = countByTrade(todayCompanies);
  const total = new Map();
  for (const r of historyReports) for (const [k, n] of countByTrade(r.companies)) total.set(k, (total.get(k) || 0) + n);
  const col = (c, row) => `${c}${row}`;
  let todaySum = supervisorsToday || 0;
  let cumulativeSum = supervisorsCumulative || 0;
  for (const [key, slot] of assignment.byTrade) {
    const t = today.get(key) || 0;
    const sum = total.get(key) || 0;
    todaySum += t;
    cumulativeSum += sum;
    const show = t > 0 || (cumulative && sum > 0);
    if (!show) continue;
    if (slot.free && writeLabels) writes.push({ cell: col(cfg.labelColumn, slot.row), value: slot.label });
    if (t > 0) writes.push({ cell: col(cfg.countColumn, slot.row), value: t, numeric: true });
    if (cumulative && sum > 0) writes.push({ cell: col(cfg.cumulativeColumn, slot.row), value: sum, numeric: true });
  }
  for (const label of assignment.overflow) {
    if (today.get(normalizeTrade(label))) warnings.push(`業種「${label}」は稼動人数表の空き行が足りないため書き込めませんでした（計には含めています）`);
  }
  // 空き行が足りず行の無い業種も、計・延労働時間には含める
  for (const label of assignment.overflow) {
    const key = normalizeTrade(label);
    todaySum += today.get(key) || 0;
    cumulativeSum += total.get(key) || 0;
  }
  if (cumulative) {
    const hours = cfg.hoursPerPerson || 8;
    if (todaySum > 0) writes.push({ cell: col(cfg.countColumn, cfg.totalRow), value: todaySum, numeric: true }, { cell: col(cfg.countColumn, cfg.laborHoursRow), value: todaySum * hours, numeric: true });
    if (cumulativeSum > 0) writes.push({ cell: col(cfg.cumulativeColumn, cfg.totalRow), value: cumulativeSum, numeric: true }, { cell: col(cfg.cumulativeColumn, cfg.laborHoursRow), value: cumulativeSum * hours, numeric: true });
  }
  return { writes, warnings };
}
