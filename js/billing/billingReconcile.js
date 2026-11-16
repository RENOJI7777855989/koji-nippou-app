/* ==========================================================
   請求人工と実稼働の照合（現場 × 月。2026-11-16。DOM・DB に触れない純粋関数）
   ・元のデータは日報の業者の行だけ（companies[]）。照合のために日報・請求人工を書き換えない（差異があっても直さない）。
   ・実稼働は業者管理の「業者別稼働」と同じ決まり: 通常作業の日報だけ・工期開始日より前の日報は数えない・
     稼働人数は数字で0より大きい実績人数（actualWorkersOf）。
       延べ稼働人数 = 稼働人数の合計
       実稼働人日   = 延べ稼働人数 × 1（既存の決まり「1人＝1人工」。03-2 の稼動人数表・業者別稼働の実績人工と同じ。
                      作業時間からは計算しない。03-2 の延労働時間（計×8時間）は時間なので別のもの）
       稼働日数     = その単位で稼働人数が1人以上の日の数
   ・請求人工は業者管理の「請求人工管理」と同じく、入力された値だけ（日の状態に関係なく、その月の日報の行）。
     読み方は朝礼入力・日報画面と同じ（billingManDays が有ればそれ、無いときだけ以前の版の manDays。readBilling）。
     未入力は合計に入れない（0にしない）。決まりに合わない古い値は「要確認」で、合計に入れない。0.01 単位の整数で足す。
   ・単位: 業者別（業者の全棟の合計）／棟別（その棟に入った全業者）／業者・棟別。職種別にも分けられる（職種の名前は
     業者管理の明細と同じく、前後の空白だけ除いてそのまま比べる）。棟は作業行の buildingId で見分ける（未設定は「棟未設定」）。
     棟を使わない現場（siteUsesBuildings）では棟で分けない。
   ・業者は業者名の完全一致。利用者が「同じ業者」と確認した名前だけをまとめる（vendorNames.js）。
   ・照合状態（優先の順）: 業者名確認待ち → 棟未設定 → 未照合（請求人工が1件も入力されていない）→
     未入力あり（稼働した行に請求人工が未入力・要確認の行がある）→ 差異あり／一致（請求人工の合計と実稼働人日を比べる）。
   ========================================================== */

import { isWorkDay, dayStatusOf, labelOf, DAY_STATUSES } from "../dashboard/dailyFlow.js";
import { actualWorkersOf } from "./billingMonthly.js";
import { readBilling, centsText } from "./dailyBillingSheet.js";
import { vendorResolver, siteUsesBuildings } from "./vendorNames.js";

export const NO_TRADE = "（職種未入力）";
export const NO_BUILDING = "（棟未設定）";
export const RECONCILE_VIEWS = [
  { value: "vendor", label: "業者別（全棟の合計）" },
  { value: "building", label: "棟別（全業者）" },
  { value: "vendorBuilding", label: "業者・棟別" }
];
export const RECONCILE_STATES = {
  match: "一致",
  diff: "差異あり",
  missing: "未入力あり",
  unbilled: "未照合",
  noBuilding: "棟未設定",
  nameReview: "業者名確認待ち"
};

const monthEnd = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
export const cutoffOf = (month, today) => { const end = monthEnd(month); return today && today < end ? today : end; };
const trim = (s) => String(s ?? "").trim();

/**
 * その月の、業者の行ごとの記録（照合・業者ごとのPDFの元）。稼働も請求人工も無い行は入れない
 * @returns {{date, reportId, companyId, rawName, vendorId, vendorName, buildingKey, buildingLabel, trade, workContent, dayStatus, work, workers, billing}[]}
 */
export function monthLineItems({ site, reports = [], month, today }) {
  const cutoff = cutoffOf(month, today);
  const startDate = site?.startDate || null;
  const resolve = vendorResolver(site);
  const useB = siteUsesBuildings(site);
  const master = new Map((site?.buildings || []).map((b) => [b.id, b.name]));
  const items = [];
  for (const r of [...reports].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    if (r.isDeleted || !r.date || r.date.slice(0, 7) !== month || r.date > cutoff) continue;
    const work = isWorkDay(r) && !(startDate && r.date < startDate);
    const status = dayStatusOf(r);
    for (const c of r.companies || []) {
      const v = resolve(c.companyName);
      if (!v) continue;
      const workers = work ? actualWorkersOf(c) : 0;
      const billing = readBilling(c);
      if (workers <= 0 && billing.state === "blank") continue;
      const bId = trim(c.buildingId);
      items.push({
        date: r.date,
        reportId: r.id,
        companyId: c.companyId || "",
        rawName: trim(c.companyName),
        vendorId: v.id,
        vendorName: v.name,
        buildingKey: useB ? bId : null,
        buildingLabel: !useB ? "" : bId ? trim(c.buildingName) || master.get(bId) || "（名前なし）" : NO_BUILDING,
        trade: trim(c.occupation) || NO_TRADE,
        workContent: trim(c.workContent),
        dayStatus: status,
        dayStatusLabel: labelOf(DAY_STATUSES, status),
        work,
        workers,
        billing
      });
    }
  }
  return items;
}

function blankUnit(key, it, view, byTrade) {
  return {
    key,
    vendorId: view === "building" ? null : it.vendorId,
    vendorName: view === "building" ? "" : it.vendorName,
    rawNames: new Set(),
    buildingKey: view === "vendor" ? null : it.buildingKey,
    buildingLabel: view === "vendor" ? "" : it.buildingLabel,
    trade: byTrade ? it.trade : "",
    workers: 0, workDays: new Set(), billingCents: 0, billingRows: 0, missingRows: 0, invalidRows: 0,
    days: new Map()
  };
}

/** 単位の照合状態 */
function stateOf(u, { pendingNames, useB, view }) {
  if (view !== "building" && [...u.rawNames].some((n) => pendingNames.has(n))) return "nameReview";
  if (useB && view !== "vendor" && u.buildingKey === "") return "noBuilding";
  if (u.billingRows === 0) return "unbilled";
  if (u.missingRows + u.invalidRows > 0) return "missing";
  return u.billingCents === u.workers * 100 ? "match" : "diff";
}

/**
 * 照合表
 * @param {{site: object, reports: object[], month: string, today: string, view?: string, byTrade?: boolean, pendingNames?: Set<string>}} p
 */
export function buildReconciliation({ site, reports = [], month, today, view = "vendor", byTrade = false, pendingNames = new Set() }) {
  const useB = siteUsesBuildings(site);
  const v = useB ? view : "vendor";
  const items = monthLineItems({ site, reports, month, today });
  const units = new Map();
  for (const it of items) {
    const parts = [];
    if (v !== "building") parts.push(it.vendorId);
    if (v !== "vendor") parts.push(it.buildingKey);
    if (byTrade) parts.push(it.trade);
    const key = parts.join("|");
    const u = units.get(key) || blankUnit(key, it, v, byTrade);
    if (v !== "vendor" && it.buildingKey) u.buildingLabel = it.buildingLabel; // 最後に出てきた日報の名前
    u.rawNames.add(it.rawName);
    const d = u.days.get(it.date) || { date: it.date, workers: 0, billingCents: 0, billingRows: 0, missingRows: 0, invalidRows: 0, reportIds: new Set(), companyIds: [], dayStatusLabel: it.dayStatusLabel, work: it.work };
    u.workers += it.workers; d.workers += it.workers;
    if (it.workers > 0) u.workDays.add(it.date);
    if (it.billing.state === "ok") { u.billingCents += it.billing.cents; u.billingRows++; d.billingCents += it.billing.cents; d.billingRows++; }
    else if (it.billing.state === "invalid") { u.invalidRows++; d.invalidRows++; }
    else if (it.workers > 0) { u.missingRows++; d.missingRows++; }
    d.reportIds.add(it.reportId);
    if (it.companyId) d.companyIds.push(it.companyId);
    u.days.set(it.date, d);
    units.set(key, u);
  }
  const rows = [...units.values()].map((u) => {
    const state = stateOf(u, { pendingNames, useB, view: v });
    const days = [...u.days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
      ...d,
      reportIds: [...d.reportIds],
      manDays: d.workers,
      billing: d.billingRows ? centsText(d.billingCents) : null,
      diffCents: d.billingCents - d.workers * 100,
      diff: centsText(d.billingCents - d.workers * 100),
      hasGap: d.billingCents !== d.workers * 100 || d.missingRows + d.invalidRows > 0
    }));
    return {
      key: u.key,
      vendorId: u.vendorId,
      vendorName: u.vendorName,
      rawNames: [...u.rawNames].sort((a, b) => a.localeCompare(b, "ja")),
      buildingKey: u.buildingKey,
      buildingLabel: u.buildingLabel,
      trade: u.trade,
      workDays: u.workDays.size,
      workers: u.workers,          // 延べ稼働人数
      manDays: u.workers,          // 実稼働人日（1人＝1人日）
      billingCents: u.billingCents,
      billing: u.billingRows ? centsText(u.billingCents) : null,
      billingRows: u.billingRows,
      missingRows: u.missingRows,
      invalidRows: u.invalidRows,
      diffCents: u.billingCents - u.workers * 100,
      diff: centsText(u.billingCents - u.workers * 100),
      state,
      stateLabel: RECONCILE_STATES[state],
      days
    };
  }).sort((a, b) => {
    const bo = (x) => (x.buildingKey === "" ? 1 : 0);
    if (v === "building") return bo(a) - bo(b) || a.buildingLabel.localeCompare(b.buildingLabel, "ja") || a.trade.localeCompare(b.trade, "ja");
    return a.vendorName.localeCompare(b.vendorName, "ja") || bo(a) - bo(b) || a.buildingLabel.localeCompare(b.buildingLabel, "ja") || a.trade.localeCompare(b.trade, "ja");
  });
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const totals = {
    workers: sum((r) => r.workers),
    manDays: sum((r) => r.manDays),
    billingCents: sum((r) => r.billingCents),
    billingRows: sum((r) => r.billingRows),
    missingRows: sum((r) => r.missingRows),
    invalidRows: sum((r) => r.invalidRows)
  };
  totals.billing = centsText(totals.billingCents);
  totals.diffCents = totals.billingCents - totals.manDays * 100;
  totals.diff = centsText(totals.diffCents);
  const counts = Object.fromEntries(Object.keys(RECONCILE_STATES).map((k) => [k, rows.filter((r) => r.state === k).length]));
  return { month, cutoff: cutoffOf(month, today), view: v, byTrade, usesBuildings: useB, rows, totals, counts };
}

/** 差異の表示（+1.5 / -2 / 0）。請求人工が未入力（null）なら「—」（未入力を0として差を出さない） */
export const signedText = (cents, billing = 0) => (billing == null ? "—" : cents > 0 ? `+${centsText(cents)}` : centsText(cents));
