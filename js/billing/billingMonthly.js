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
    if (!byVendor.has(name)) byVendor.set(name, { vendor: name, total: 0, entered: 0, missing: 0, lastDate: "", trades: new Set(), days: new Set(), billingDays: new Set() });
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
      else { v.total += b; v.entered++; v.billingDays.add(r.date); if (r.date > v.lastDate) v.lastDate = r.date; }
    }
  }
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
      lastDate: v.lastDate,
      status,
      statusLabel: labelOf(BILLING_STATUSES, status),
      statusUpdatedAt: st.updatedAt || "",
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
    closeUpdatedAt: saved.closeUpdatedAt || ""
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

/** その月の業者別稼働（純粋関数） */
export function buildVendorActivity({ reports = [], month, today }) {
  const cutoff = cutoffOf(month, today);
  const byVendor = new Map();
  for (const r of reports) {
    if (!inMonth(r, month, cutoff) || !isWorkDay(r)) continue;
    const dayTotals = new Map(); // 同じ日の同じ業者（複数の工種の行）をまとめる
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
    for (const [name, t] of dayTotals) {
      if (t.workers < 1) continue; // 稼働人数0の日は稼働日にしない
      const v = byVendor.get(name) || { vendor: name, days: 0, workers: 0, minutes: 0, missingHours: 0, trades: new Set() };
      v.days++; v.workers += t.workers; v.minutes += t.minutes; v.missingHours += t.missingHours;
      t.trades.forEach((x) => v.trades.add(x));
      byVendor.set(name, v);
    }
  }
  const rows = [...byVendor.values()].map((v) => ({ vendor: v.vendor, days: v.days, workers: v.workers, manDays: v.workers, minutes: v.minutes, hoursMissing: v.missingHours, trades: [...v.trades] })).sort((a, b) => a.vendor.localeCompare(b.vendor, "ja"));
  return { month, cutoff, rows, totals: { vendors: rows.length, days: rows.reduce((s, r) => s + r.days, 0), workers: rows.reduce((s, r) => s + r.workers, 0), minutes: rows.reduce((s, r) => s + r.minutes, 0) } };
}

/**
 * 業者・月の日別の詳細（稼働と請求人工の入力を日ごとに並べる。どちらかがある日を出す）
 * 稼働は通常作業の日の実績人数、請求人工は日の状態に関係なく入力された値（未入力は null）
 */
export function buildVendorMonthDetail({ reports = [], site = null, month, today, vendor }) {
  const cutoff = cutoffOf(month, today);
  const name = String(vendor || "").trim();
  const days = [];
  for (const r of [...reports].sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
    if (!inMonth(r, month, cutoff)) continue;
    const rows = (r.companies || []).filter((c) => String(c.companyName || "").trim() === name);
    if (!rows.length) continue;
    const work = isWorkDay(r);
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
