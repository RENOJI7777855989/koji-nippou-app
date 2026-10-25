/* ==========================================================
   請求人工の月次管理（現場 × 業者 × 月）
   ・月間請求人工は、日報の業者の行に保存されている「請求人工」（companies[].billingManDays。
     以前の版の manDays も請求人工として読む）を、日報の日付の月ごとに業者名で合計して、表示のたびに計算する
     （合計は保存しない＝日報を直せばその月の合計に反映され、二重管理にならない）。
   ・業者は業者名（前後の空白を除いた文字列）で識別する。同じ業者が複数の工種を担当していても1社として合計する（工種別に分けない）。
   ・月次の一覧・集計の対象は、その月にその業者の請求人工が1件以上入力されている業者だけ。日報に出ただけ・稼働人数や
     作業時間があるだけ・請求状況だけ保存されている業者は一覧に出さない（未入力の行は合計に入れないだけで、0は保存しない）。
   ・請求状況（未確認／請求あり／請求なし）と月の締め状態（未締め／締め確認中／締め済み）は監督が選んだものだけを、
     現場の記録 site.billingMonths[月] に保存する（DBの構造・バージョンは変えない。バックアップは現場のレコードごと）。
     請求人工が入力されていても「請求あり」にはしない。請求なしでも請求人工を0にはしない。保存されていない月・業者は「未確認」。
   ・未来の日付（基準日より後）の日報は合計に入れない。月をまたいで足さない。
   ・稼働人数・人工・作業時間から請求人工を計算しない。03-2・現場掲示（A3）には出さない。
   ========================================================== */

import { dbGet } from "../db.js";
export { parseBillingInput, BILLING_INPUT_RULE } from "./billingValue.js";
import { updateSite } from "../sites.js";
import { isWorkDay, dayStatusOf, labelOf as statusLabelOf, DAY_STATUSES, parseWorkHours, workMinutes } from "../dashboard/dailyFlow.js";

export const BILLING_STATUSES = [
  { value: "unconfirmed", label: "未確認" },
  { value: "billed", label: "請求あり" },
  { value: "none", label: "請求なし" }
];
export const BILLING_CLOSE_STATUSES = [
  { value: "open", label: "未締め" },
  { value: "reviewing", label: "締め確認中" },
  { value: "closed", label: "締め済み" }
];
const labelOf = (list, v) => list.find((x) => x.value === v)?.label || list[0].label;

/** 日報の業者の行の請求人工（未入力は null） */
export function billingValueOf(company) {
  const raw = company?.billingManDays ?? company?.manDays;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ----------------------------------------------------------
   業者×職種の明細（請求人工・業者別稼働で共通。2026-10-25）
   ・明細の単位は「業者名＋日報に保存された職種（工種）の名前」。名前は前後の空白だけを除き、そのまま比べる
     （似た名前（洗浄と屋根洗浄、外壁補修と外壁下地補修など）を部分一致・類似度・語尾の削除でまとめない。
     ダッシュボード・03-2の稼動人数表は様式の業種の行に当てはめるため表記ゆれをそろえるが、ここではそろえない）。
   ・業者は業者名（前後の空白を除く）で見分ける。どの業者にも同じ決まり（特定の業者名による例外は無い）。
   ・明細ごとに、根拠の日報（日付・日報id・その業者×職種の行の companyId・値）を持つ（元の日報を開くため）。
   ・業者の合計は明細の合計（請求人工は小数2桁で丸める）。
   ---------------------------------------------------------- */
export const NO_TRADE_LINE = "（職種未入力）";
const tradeNameOf = (c) => String(c?.occupation ?? "").trim() || NO_TRADE_LINE;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} p
 * @param {object[]} p.reports 日報
 * @param {(r: object) => boolean} p.include 数える日報
 * @param {(c: object) => (number|null)} p.valueOf 業者の行の値（null＝数えない行）
 * @returns {Map<string, {trade: string, value: number, entries: {date: string, reportId: string, companyIds: string[], value: number}[]}[]>} 業者名 → 明細（職種名の順）
 */
export function vendorTradeLines({ reports = [], include, valueOf }) {
  const byVendor = new Map();
  for (const r of [...reports].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    if (r.isDeleted || !r.date || !include(r)) continue;
    const perReport = new Map(); // 業者\0職種 → この日報の明細の値
    for (const c of r.companies || []) {
      const vendor = String(c.companyName || "").trim();
      if (!vendor) continue;
      const v = valueOf(c);
      if (v == null) continue;
      const trade = tradeNameOf(c);
      const k = `${vendor}\u0000${trade}`;
      const e = perReport.get(k) || { vendor, trade, value: 0, companyIds: [] };
      e.value += v;
      if (c.companyId) e.companyIds.push(c.companyId);
      perReport.set(k, e);
    }
    for (const e of perReport.values()) {
      if (!byVendor.has(e.vendor)) byVendor.set(e.vendor, new Map());
      const lines = byVendor.get(e.vendor);
      if (!lines.has(e.trade)) lines.set(e.trade, { trade: e.trade, value: 0, entries: [] });
      const line = lines.get(e.trade);
      line.value += e.value;
      line.entries.push({ date: r.date, reportId: r.id, companyIds: e.companyIds, value: round2(e.value) });
    }
  }
  const out = new Map();
  for (const [vendor, lines] of byVendor) out.set(vendor, [...lines.values()].map((l) => ({ ...l, value: round2(l.value) })).sort((a, b) => a.trade.localeCompare(b.trade, "ja")));
  return out;
}

const monthEnd = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };

/**
 * ある月の業者別の請求人工と請求状況（純粋関数）
 * @param {{reports: object[], site: object, month: string, today: string}} p month は "YYYY-MM"、today は基準日（これより後の日報は入れない）
 */
export function buildMonthlyBilling({ reports = [], site = null, month, today }) {
  const end = monthEnd(month);
  const cutoff = today && today < end ? today : end; // 当月は基準日まで、過去の月は月末まで
  const saved = site?.billingMonths?.[month] || {};
  const savedVendors = saved.vendors || {};
  const byVendor = new Map();
  const ensure = (name) => {
    if (!byVendor.has(name)) byVendor.set(name, { vendor: name, total: 0, entered: 0, missing: 0, lastDate: "", trades: new Set(), days: new Set(), billingDays: new Set(), billingReportsByDate: new Map() });
    return byVendor.get(name);
  };
  for (const r of reports) {
    if (r.isDeleted || !r.date || r.date.slice(0, 7) !== month || r.date > cutoff) continue;
    for (const c of r.companies || []) {
      const name = String(c.companyName || "").trim();
      if (!name) continue;
      const v = ensure(name);
      v.days.add(r.date);
      if ((c.occupation || "").trim()) v.trades.add(c.occupation.trim());
      const b = billingValueOf(c);
      if (b == null) v.missing++;
      else {
        v.total += b; v.entered++; v.billingDays.add(r.date); if (r.date > v.lastDate) v.lastDate = r.date;
        if (!v.billingReportsByDate.has(r.date)) v.billingReportsByDate.set(r.date, new Set());
        v.billingReportsByDate.get(r.date).add(r.id);
      }
    }
  }
  // 業者×職種の明細（請求人工が入力された行だけ。業者別稼働と同じ決まり vendorTradeLines）
  const billingLines = vendorTradeLines({ reports, include: (r) => r.date.slice(0, 7) === month && r.date <= cutoff, valueOf: billingValueOf });
  // 一覧・集計の対象は、この月に請求人工が1件以上入力されている業者だけ
  const rows = [...byVendor.values()].filter((v) => v.entered > 0).map((v) => {
    const st = savedVendors[v.vendor] || {};
    const status = ["billed", "none", "unconfirmed"].includes(st.status) ? st.status : "unconfirmed";
    const manDays = Math.round(v.total * 100) / 100;
    return {
      vendor: v.vendor,
      manDays,
      enteredRows: v.entered,
      enteredDays: v.billingDays.size, // 請求人工を入力した日数
      missingRows: v.missing,
      days: v.days.size,
      trades: [...v.trades],
      // 職種ごとの明細（月間請求人工・入力日数・根拠の日報）。明細の合計＝月間請求人工
      lines: (billingLines.get(v.vendor) || []).map((l) => ({ trade: l.trade, manDays: l.value, enteredDays: new Set(l.entries.map((e) => e.date)).size, entries: l.entries })),
      lastDate: v.lastDate,
      status,
      statusLabel: labelOf(BILLING_STATUSES, status),
      statusUpdatedAt: st.updatedAt || "",
      // 同じ日に複数の日報があり、その業者の請求人工がそれぞれに入っている日（集計は従来どおり全部を合算する。重複登録の可能性の警告用）
      multiReportDates: [...v.billingReportsByDate].filter(([, ids]) => ids.size > 1).map(([d]) => d).sort(),
    };
  }).sort((a, b) => a.vendor.localeCompare(b.vendor, "ja"));
  // 請求状況は「請求あり」で保存されているのに、この月の請求人工が1件も入力されていない業者（一覧には出さず、確認事項にだけ出す）
  const listed = new Set(rows.map((r) => r.vendor));
  const billedWithoutManDays = Object.entries(savedVendors).filter(([name, st]) => st?.status === "billed" && !listed.has(name)).map(([name]) => name).sort((a, b) => a.localeCompare(b, "ja"));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const closeStatus = ["open", "reviewing", "closed"].includes(saved.closeStatus) ? saved.closeStatus : "open";
  return {
    month,
    cutoff,
    rows,
    total: Math.round(rows.reduce((s, r) => s + (r.manDays || 0), 0) * 100) / 100,
    counts: { billed: count("billed"), none: count("none"), unconfirmed: count("unconfirmed"), billedWithoutManDays: billedWithoutManDays.length },
    billedWithoutManDays,
    closeStatus,
    closeLabel: labelOf(BILLING_CLOSE_STATUSES, closeStatus),
    closeUpdatedAt: saved.closeUpdatedAt || "",
    // 基準日までで、同じ日に日報が2件以上ある日（請求人工の有無に関係なく。重複登録の可能性）
    sameDayReportDates: (() => { const c = new Map(); for (const r of reports) { if (r.isDeleted || !r.date || r.date.slice(0, 7) !== month || r.date > cutoff) continue; c.set(r.date, (c.get(r.date) || 0) + 1); } return [...c].filter(([, n]) => n > 1).map(([d]) => d).sort(); })()
  };
}

/** 業者のその月の請求状況を保存する（未確認／請求あり／請求なし）。請求人工は変えない */
export async function setBillingStatus(siteId, month, vendor, status) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw new Error("月の指定が不正です");
  const name = String(vendor || "").trim();
  if (!name) throw new Error("業者名がありません");
  if (!BILLING_STATUSES.some((s) => s.value === status)) throw new Error("請求状況の指定が不正です");
  const site = await dbGet("sites", siteId);
  if (!site) throw new Error("現場が見つかりません");
  const months = { ...(site.billingMonths || {}) };
  const m = { ...(months[month] || {}), vendors: { ...(months[month]?.vendors || {}) } };
  m.vendors[name] = { status, updatedAt: new Date().toISOString() };
  months[month] = m;
  return updateSite(siteId, { billingMonths: months });
}

/** その月の締め状態を保存する（未締め／締め確認中／締め済み） */
export async function setBillingClose(siteId, month, closeStatus) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw new Error("月の指定が不正です");
  if (!BILLING_CLOSE_STATUSES.some((s) => s.value === closeStatus)) throw new Error("締め状態の指定が不正です");
  const site = await dbGet("sites", siteId);
  if (!site) throw new Error("現場が見つかりません");
  const months = { ...(site.billingMonths || {}) };
  months[month] = { ...(months[month] || {}), vendors: { ...(months[month]?.vendors || {}) }, closeStatus, closeUpdatedAt: new Date().toISOString() };
  return updateSite(siteId, { billingMonths: months });
}

/* ----------------------------------------------------------
   業者管理: 業者別稼働（実際の現場稼働。請求人工は使わない）と、業者・月の日別の詳細
   ・稼働日＝通常作業の日報で、その業者の稼働人数（実績人数）が1人以上の日。現場作業なし・休工日・
     雨天作業不可日・事務作業日の日報は、既存の決まりどおり現場作業員の稼働に数えない
   ・稼働人数＝実績人数の合計、実績人工＝1人＝1人工（稼働人数と同じ）、作業時間＝業者の行の作業時間（開始～終了）の合計
     （同じ日に同じ業者が複数の工種の行にあるときは行ごとに足す。開始・終了がそろわない行は「未入力」として数える）
   ・基準日（今日）より後の日報は入れない。月をまたいで足さない
   ---------------------------------------------------------- */
const actualOf = (c) => { const n = Number(String(c?.actualWorkerCount ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : 0; };
const minutesOf = (c) => { const p = parseWorkHours(c?.workHours); return p && p.end ? workMinutes(p.start, p.end) : null; };
const inMonth = (r, month, cutoff) => !r.isDeleted && r.date && r.date.slice(0, 7) === month && r.date <= cutoff;
const cutoffOf = (month, today) => { const end = monthEnd(month); return today && today < end ? today : end; };

/** 日報1件の、業者ごとの稼働（同じ日の同じ業者（複数の工種の行）をまとめる） */
function dayVendorTotals(r) {
  const dayTotals = new Map();
  for (const c of r.companies || []) {
    const name = String(c.companyName || "").trim();
    if (!name) continue;
    const t = dayTotals.get(name) || { workers: 0, minutes: 0, missingHours: 0, trades: new Set() };
    t.workers += actualOf(c);
    const m = minutesOf(c);
    if (actualOf(c) > 0) { if (m == null) t.missingHours++; else t.minutes += m; }
    if ((c.occupation || "").trim()) t.trades.add(c.occupation.trim());
    dayTotals.set(name, t);
  }
  return dayTotals;
}

/**
 * その月の業者別稼働（純粋関数）。
 * cumManDays（累計実績人工）は、基準日（その月の末日。今月なら今日）までのすべての日報の実績人工の合計
 * （工期の初めから。月の区切りは無く、決まりは月の稼働と同じ: 通常作業の日だけ・1人＝1人工・請求人工は使わない）。
 * 一覧には、その月に稼働した業者に加えて、それより前に稼働した業者も出す（その月の稼働日数・稼働人数・実績人工・作業時間は0）。
 * totals.vendors はその月に稼働した業者の数（以前どおり）、totals.listed は一覧の業者の数。
 * startDate（現場の工期開始日）があれば、それより前の日付の日報は、その月の稼働にも累計にも入れない（実績人工は工期開始日以降だけ）
 */
export function buildVendorActivity({ reports = [], month, today, startDate = null }) {
  const cutoff = cutoffOf(month, today);
  const byVendor = new Map();
  const blank = (name) => ({ vendor: name, days: 0, workers: 0, minutes: 0, missingHours: 0, trades: new Set(), cumManDays: 0 });
  for (const r of reports) {
    if (r.isDeleted || !r.date || r.date > cutoff || (startDate && r.date < startDate) || !isWorkDay(r)) continue;
    const thisMonth = r.date.slice(0, 7) === month;
    for (const [name, t] of dayVendorTotals(r)) {
      if (t.workers < 1) continue; // 稼働人数0の日は稼働日にしない
      const v = byVendor.get(name) || blank(name);
      v.cumManDays += t.workers;
      if (thisMonth) {
        v.days++; v.workers += t.workers; v.minutes += t.minutes; v.missingHours += t.missingHours;
        t.trades.forEach((x) => v.trades.add(x));
      }
      byVendor.set(name, v);
    }
  }
  // 業者×職種の明細（その月の実績人工・稼働日数・作業時間と、累計。請求人工管理と同じ決まり vendorTradeLines）
  const workDay = (r) => r.date <= cutoff && !(startDate && r.date < startDate) && isWorkDay(r);
  const actualOrNull = (c) => (actualOf(c) > 0 ? actualOf(c) : null);
  const monthLines = vendorTradeLines({ reports, include: (r) => workDay(r) && r.date.slice(0, 7) === month, valueOf: actualOrNull });
  const cumLines = vendorTradeLines({ reports, include: workDay, valueOf: actualOrNull });
  const minutesLines = vendorTradeLines({ reports, include: (r) => workDay(r) && r.date.slice(0, 7) === month, valueOf: (c) => (actualOf(c) > 0 ? minutesOf(c) : null) });
  const linesOf = (vendor) => (cumLines.get(vendor) || []).map((cl) => {
    const ml = (monthLines.get(vendor) || []).find((l) => l.trade === cl.trade);
    const mins = (minutesLines.get(vendor) || []).find((l) => l.trade === cl.trade);
    return { trade: cl.trade, manDays: ml ? ml.value : 0, workers: ml ? ml.value : 0, days: ml ? new Set(ml.entries.map((e) => e.date)).size : 0, minutes: mins ? mins.value : 0, cumManDays: cl.value, entries: ml ? ml.entries : [], cumEntries: cl.entries };
  });
  const rows = [...byVendor.values()].map((v) => ({ vendor: v.vendor, days: v.days, workers: v.workers, manDays: v.workers, minutes: v.minutes, hoursMissing: v.missingHours, trades: [...v.trades], cumManDays: v.cumManDays, lines: linesOf(v.vendor) })).sort((a, b) => a.vendor.localeCompare(b.vendor, "ja"));
  const active = rows.filter((r) => r.days > 0);
  return { month, cutoff, rows, totals: { vendors: active.length, listed: rows.length, days: rows.reduce((s, r) => s + r.days, 0), workers: rows.reduce((s, r) => s + r.workers, 0), minutes: rows.reduce((s, r) => s + r.minutes, 0), cumManDays: rows.reduce((s, r) => s + r.cumManDays, 0) } };
}

/* ----------------------------------------------------------
   業者別稼働: 期間を指定した集計（開始年月の1日〜終了年月の末日。今月を含めば今日まで）
   ・決まりは月の業者別稼働と同じ（dayVendorTotals。通常作業の日だけ・稼働人数0の日は数えない・1人＝1人工・
     今日より後の日報は入れない・請求人工は使わない）。表示のたびに日報から計算し、保存しない
   ・業者ごとに、月ごとの実績人工（期間内に稼働の無い月は0）と期間合計（＝月ごとの合計）・稼働日数・稼働人数・作業時間
   ・期間内に稼働の無い業者も、期間より前に稼働していれば出す（月の業者別稼働と同じ考え方。期間内の欄は0）
   ・startDate（現場の工期開始日）があれば、それより前の日付の日報は、期間に入っていても数えない（実績人工は工期開始日以降だけ）
   ---------------------------------------------------------- */
const monthsBetween = (from, to) => { const out = []; for (let m = from; m <= to && out.length < 240; ) { out.push(m); const [y, mm] = m.split("-").map(Number); const d = new Date(y, mm, 1); m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; } return out; };

/**
 * @returns {{error?: string, from: string, to: string, cutoff: string, months: string[], rows: object[], monthTotals: Object<string, number>, totals: object}}
 */
export function buildVendorPeriodActivity({ reports = [], fromMonth, toMonth, today, startDate = null }) {
  if (!/^\d{4}-\d{2}$/.test(fromMonth || "") || !/^\d{4}-\d{2}$/.test(toMonth || "")) return { error: "開始年月と終了年月を選んでください。", from: fromMonth, to: toMonth, months: [], rows: [], monthTotals: {}, totals: null };
  if (fromMonth > toMonth) return { error: "開始年月が終了年月より後になっています。開始年月か終了年月を選び直してください。", from: fromMonth, to: toMonth, months: [], rows: [], monthTotals: {}, totals: null };
  const months = monthsBetween(fromMonth, toMonth);
  const start = `${fromMonth}-01`;
  const cutoff = cutoffOf(toMonth, today);
  const byVendor = new Map();
  const blank = (name) => ({ vendor: name, byMonth: Object.fromEntries(months.map((m) => [m, 0])), days: 0, workers: 0, minutes: 0, missingHours: 0, trades: new Set() });
  for (const r of reports) {
    if (r.isDeleted || !r.date || r.date > cutoff || (startDate && r.date < startDate) || !isWorkDay(r)) continue;
    const inPeriod = r.date >= start;
    for (const [name, t] of dayVendorTotals(r)) {
      if (t.workers < 1) continue;
      const v = byVendor.get(name) || blank(name);
      if (inPeriod) {
        v.byMonth[r.date.slice(0, 7)] += t.workers;
        v.days++; v.workers += t.workers; v.minutes += t.minutes; v.missingHours += t.missingHours;
        t.trades.forEach((x) => v.trades.add(x));
      }
      byVendor.set(name, v);
    }
  }
  // 業者×職種の明細（期間合計・月ごと・稼働日数。vendorTradeLines）
  const periodLines = vendorTradeLines({ reports, include: (r) => r.date >= start && r.date <= cutoff && !(startDate && r.date < startDate) && isWorkDay(r), valueOf: (c) => (actualOf(c) > 0 ? actualOf(c) : null) });
  const linesOf = (vendor) => (periodLines.get(vendor) || []).map((l) => ({ trade: l.trade, total: l.value, days: new Set(l.entries.map((e) => e.date)).size, byMonth: Object.fromEntries(months.map((m) => [m, l.entries.filter((e) => e.date.slice(0, 7) === m).reduce((s, e) => s + e.value, 0)])), entries: l.entries }));
  const rows = [...byVendor.values()].map((v) => ({ vendor: v.vendor, byMonth: v.byMonth, total: months.reduce((s, m) => s + v.byMonth[m], 0), days: v.days, workers: v.workers, minutes: v.minutes, hoursMissing: v.missingHours, trades: [...v.trades], lines: linesOf(v.vendor) })).sort((a, b) => a.vendor.localeCompare(b.vendor, "ja"));
  const monthTotals = Object.fromEntries(months.map((m) => [m, rows.reduce((s, r) => s + r.byMonth[m], 0)]));
  return { from: fromMonth, to: toMonth, cutoff, months, rows, monthTotals, totals: { vendors: rows.filter((r) => r.days > 0).length, listed: rows.length, total: months.reduce((s, m) => s + monthTotals[m], 0), days: rows.reduce((s, r) => s + r.days, 0), workers: rows.reduce((s, r) => s + r.workers, 0), minutes: rows.reduce((s, r) => s + r.minutes, 0) } };
}

/**
 * 業者・月の日別の詳細（稼働と請求人工の入力を日ごとに並べる。どちらかがある日を出す）
 * 稼働は通常作業の日の実績人数、請求人工は日の状態に関係なく入力された値（未入力は null）
 */
export function buildVendorMonthDetail({ reports = [], site = null, month, today, vendor, startDate = null }) {
  const cutoff = cutoffOf(month, today);
  const name = String(vendor || "").trim();
  // startDate（業者別稼働の詳細から渡す）: 工期開始日より前の日は稼働に数えない（請求人工の入力は従来どおり。請求人工管理の詳細は渡さない）
  const days = vendorDetailDays(reports, (r) => inMonth(r, month, cutoff), name, startDate);
  const billingInfo = buildMonthlyBilling({ reports, site, month, today }).rows.find((r) => r.vendor === name) || null;
  const saved = site?.billingMonths?.[month]?.vendors?.[name];
  return {
    vendor: name,
    month,
    cutoff,
    days,
    summary: {
      workDays: days.filter((d) => d.worked).length,
      workers: days.reduce((s, d) => s + d.workers, 0),
      manDays: days.reduce((s, d) => s + d.workers, 0),
      billing: billingInfo ? billingInfo.manDays : null,
      billingDays: days.filter((d) => d.billing != null).length,
      status: billingInfo ? billingInfo.status : saved?.status || "unconfirmed",
      statusLabel: labelOf(BILLING_STATUSES, billingInfo ? billingInfo.status : saved?.status || "unconfirmed")
    }
  };
}

/**
 * 業者・期間の日別の稼働（業者別稼働の期間の集計の根拠。稼働した日だけ。月ごとの小計つき）。日の並べ方・数え方は月の詳細と同じ
 * @returns {{vendor: string, from: string, to: string, cutoff: string, days: object[], months: {month: string, manDays: number, days: number}[], summary: object, error?: string}}
 */
export function buildVendorPeriodDetail({ reports = [], fromMonth, toMonth, today, vendor, startDate = null }) {
  const name = String(vendor || "").trim();
  if (!fromMonth || !toMonth || fromMonth > toMonth) return { vendor: name, from: fromMonth, to: toMonth, days: [], months: [], summary: { workDays: 0, workers: 0, manDays: 0 }, error: "期間が正しくありません。" };
  const start = `${fromMonth}-01`;
  const cutoff = cutoffOf(toMonth, today);
  const days = vendorDetailDays(reports, (r) => !r.isDeleted && r.date && r.date >= start && r.date <= cutoff, name, startDate).filter((d) => d.worked);
  const months = monthsBetween(fromMonth, toMonth).map((m) => { const ds = days.filter((d) => d.date.slice(0, 7) === m); return { month: m, manDays: ds.reduce((s, d) => s + d.workers, 0), days: ds.length }; });
  return { vendor: name, from: fromMonth, to: toMonth, cutoff, days, months, summary: { workDays: days.length, workers: days.reduce((s, d) => s + d.workers, 0), manDays: days.reduce((s, d) => s + d.workers, 0) } };
}

/** 業者の日ごとの稼働と請求人工の入力（どちらかがある日。inRange(日報) が真の日報だけ）。startDate より前の日は稼働に数えない */
function vendorDetailDays(reports, inRange, name, startDate = null) {
  const days = [];
  for (const r of [...reports].sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
    if (!inRange(r)) continue;
    const rows = (r.companies || []).filter((c) => String(c.companyName || "").trim() === name);
    if (!rows.length) continue;
    const work = isWorkDay(r) && !(startDate && r.date < startDate);
    const workers = work ? rows.reduce((s, c) => s + actualOf(c), 0) : 0;
    const mins = rows.map(minutesOf).filter((m) => m != null);
    const billingVals = rows.map(billingValueOf).filter((b) => b != null);
    const billing = billingVals.length ? Math.round(billingVals.reduce((s, b) => s + b, 0) * 100) / 100 : null;
    if (workers < 1 && billing == null) continue;
    days.push({
      date: r.date,
      reportId: r.id,
      dayStatus: dayStatusOf(r),
      dayStatusLabel: statusLabelOf(DAY_STATUSES, dayStatusOf(r)),
      worked: workers >= 1,
      workers,
      hours: [...new Set(rows.map((c) => c.workHours).filter(Boolean))].join("・"),
      minutes: work && mins.length ? mins.reduce((s, m) => s + m, 0) : null,
      trades: [...new Set(rows.map((c) => (c.occupation || "").trim()).filter(Boolean))],
      billing
    });
  }
  return days;
}
