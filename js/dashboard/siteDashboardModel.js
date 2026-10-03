/* ==========================================================
   現場ダッシュボード・A3「今日の現場シート」の表示内容を、日誌データから作る
   （DOM・DB非依存の純粋関数）。ダッシュボード用の入力は無く、ここで日誌を
   集計・整理するだけなので、日誌とダッシュボードの内容が食い違わない。

   定義（利用者と確定した仕様）:
     進捗率     … 日誌ごとに入力した値（report.progressPercent）。表示する日までで一番新しい日誌の値を出し、
                  その日誌が未入力なら過去の日誌の値は使わず「未入力」にする（工期経過率は別の表示）。
                  現場に以前入力した進捗率（site.progressPercent）は使わない（データは消さずに残している）
     累計       … 工事開始から表示日までの、日誌の実績人数（業者の実績人数）の合計
     延べ労働時間 … 累計 × 8時間（03-2台帳と同じ「1人＝8時間」）
     日誌状況（表示日まで）:
       提出予定 … 工事開始日から表示日まで（竣工予定日を過ぎていればそこまで）の日数
       未提出   … そのうち日報の無い日
       未署名   … 業者名のある行のうち、職長サインの無い業者がある日報
       未承認   … 「確認済み」になっていない日報
       未印刷   … 印刷状態が未印刷の日報
   ========================================================== */

import { labelOf, dayStatusOf, isWorkDay, DAY_STATUSES, directionOf, DELIVERY_DIRECTIONS, DELIVERY_STATUSES, FLOW_STATUSES, FLOW_KINDS, parseWorkHours, formatWorkHours, workMinutes, durationLabel } from "./dailyFlow.js";
import { PATROL_CHECKLIST_ITEMS } from "../patrolChecklist.js";

/** 安全注意事項を箇条に分ける（改行ごと。先頭の「・」「-」は取る） */
const noteItems = (text) => String(text || "").split(/\r?\n/).map((l) => l.replace(/^\s*[・\-－‐●]\s*/, "").trim()).filter(Boolean);

const DAY_MS = 86400000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
export const HOURS_PER_PERSON = 8;

const toUtc = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
const addDays = (iso, n) => new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10);
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function weekdayOf(iso) {
  const t = toUtc(iso);
  return t == null ? "" : WEEKDAYS[new Date(t).getUTCDay()];
}

/**
 * 業者の人工（現場集計用）: 稼働人数（実績人数）を 1人＝1人工 として数える。
 * 請求人工（companies[].billingManDays）とは別の値で、ダッシュボードでは請求人工を使わない・表示しない。
 */
function manDaysOf(c) {
  return num(c.actualWorkerCount);
}

/**
 * 日報カレンダー用: 1日の状態。日報が無い日は "none"（未入力。作業なしとは扱わない）。
 * 通常作業の日報で、進捗率・業者・作業時間・職長サインのどれかが足りなければ "partial"（一部未入力）
 * @param {object|null} report その日の日報
 * @param {Set<string>} signedCompanyIds この日報で職長サインのある業者の companyId
 * @returns {{state: "none"|"ok"|"partial"|"nowork"|"holiday", missing: string[]}}
 */
export function calendarDayState(report, signedCompanyIds = new Set()) {
  if (!report) return { state: "none", missing: [] };
  const st = dayStatusOf(report);
  if (st !== "work") return { state: st, missing: [] };
  const missing = [];
  if (report.progressPercent == null) missing.push("進捗率");
  const cs = (report.companies || []).filter((c) => (c.companyName || "").trim());
  if (!cs.length) missing.push("業者");
  if (cs.some((c) => { const p = parseWorkHours(c.workHours); return !p || !p.end; })) missing.push("作業時間");
  if (cs.some((c) => !signedCompanyIds.has(c.companyId))) missing.push("署名");
  return { state: missing.length ? "partial" : "ok", missing };
}

/** その日の日報（同じ日付が複数あれば最後に更新されたもの） */
function reportOfDate(reports, date) {
  const same = reports.filter((r) => r.date === date);
  same.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return { report: same[0] || null, count: same.length };
}

function actualOf(report) {
  return (report?.companies || []).reduce((sum, c) => sum + (num(c.actualWorkerCount) || 0), 0);
}

/**
 * @param {object} params
 * @param {object} params.site 現場
 * @param {object[]} params.reports 現場の日報（削除済みを除く）
 * @param {object[]} params.signatures 署名（これらの日報のもの）
 * @param {string} params.date 表示する日（YYYY-MM-DD）
 */
/**
 * 危険予知活動表（KY活動表）の当日の状況（純粋関数）。日報とは独立した記録（kySubmissions）だけから作る。
 * 候補業者: その日の日報の業者と、前の作業日（通常作業）の日報の業者。候補は表示するだけで、対象には自動で入れない。
 */
export function buildKyModel({ records = [], reports = [], date }) {
  const key = (n) => String(n || "").trim();
  const rows = records
    .filter((r) => !r.isDeleted && r.date === date)
    .map((r) => ({ id: r.id, vendorName: r.vendorName, state: r.target === false ? "excluded" : r.submitted ? "submitted" : "not_submitted", submittedAt: r.submitted ? r.submittedAt || null : null }));
  const targets = rows.filter((r) => r.state !== "excluded");
  const submitted = targets.filter((r) => r.state === "submitted");
  const notSubmitted = targets.filter((r) => r.state === "not_submitted");
  const registered = new Set(rows.map((r) => key(r.vendorName)));
  const namesOf = (r) => [...new Set((r?.companies || []).map((c) => key(c.companyName)).filter(Boolean))];
  const live = reports.filter((r) => !r.isDeleted);
  const todayReport = reportOfDate(live, date).report;
  const prevWork = live.filter((r) => (r.date || "") < date && isWorkDay(r) && namesOf(r).length).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0] || null;
  return {
    rows,
    targetCount: targets.length,
    submittedCount: submitted.length,
    notSubmittedCount: notSubmitted.length,
    excludedCount: rows.length - targets.length,
    notSubmittedNames: notSubmitted.map((r) => r.vendorName),
    candidates: {
      today: todayReport ? namesOf(todayReport).filter((n) => !registered.has(n)) : [],
      previousDate: prevWork?.date || null,
      previous: prevWork ? namesOf(prevWork).filter((n) => !registered.has(n)) : []
    }
  };
}

export function buildDashboardModel({ site, reports = [], signatures = [], date, kySubmissions = [] }) {
  const live = reports.filter((r) => !r.isDeleted);
  const { report, count: sameDayCount } = reportOfDate(live, date);
  // 日の状態。日報が無い日は null（未入力）。作業なし・休工日の日報は稼働人数・人工などに数えない
  const dayStatus = report ? dayStatusOf(report) : null;
  const isWork = !!report && dayStatus === "work";
  const workLive = live.filter(isWorkDay);

  // ---- 現場情報 ----
  const start = site?.startDate || "";
  const end = site?.endDate || "";
  let elapsedPct = null;
  let remainingDays = null;
  let dayNumber = null;
  if (start && toUtc(start) != null) {
    dayNumber = daysBetween(start, date) + 1;
    if (end && toUtc(end) != null && toUtc(end) >= toUtc(start)) {
      const total = daysBetween(start, end) + 1;
      elapsedPct = Math.min(100, Math.max(0, Math.round((Math.min(Math.max(dayNumber, 0), total) / total) * 100)));
      remainingDays = Math.max(0, daysBetween(date, end));
    }
  }
  // ---- 進捗率（日誌ごとの記録から）----
  const upToDate = live.filter((r) => r.date && r.date <= date).sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const latestReport = upToDate[0] || null;
  const progressHistory = upToDate.filter((r) => r.progressPercent != null).slice(0, 5).reverse().map((r) => ({ date: r.date, value: r.progressPercent }));
  const header = {
    siteName: site?.name || "",
    constructionNumber: site?.constructionNumber || "",
    clientName: site?.clientName || "",
    startDate: start,
    endDate: end,
    progressPercent: latestReport?.progressPercent ?? null,
    progressDate: latestReport?.date || null, // 進捗率を読んだ日誌の日付（日誌が無ければ null）
    progressHistory,
    elapsedPct,
    remainingDays,
    dayNumber: dayNumber != null && dayNumber >= 1 ? dayNumber : null,
    date,
    weekday: weekdayOf(date)
  };

  // ---- 本日の現場の流れ（日誌の流れ● ＋ 搬入◆・搬出◇。時刻順、時刻の無いものは最後）----
  // 搬入・搬出は日誌の搬入・搬出の欄から自動で入れる（流れの欄に二重に入力しない）
  const flow = [];
  for (const f of report?.timeline || []) {
    flow.push({ time: f.time || "", mark: "●", kind: "flow", flowKind: f.kind || "work", title: f.title || labelOf(FLOW_KINDS, f.kind), kindLabel: labelOf(FLOW_KINDS, f.kind), status: labelOf(FLOW_STATUSES, f.status), note: f.note || "" });
  }
  // 区分の無い行（区分を追加する前の搬入事項）は搬入として扱う
  const deliveries = (report?.deliveries || []).map((d) => {
    const direction = directionOf(d);
    const dir = DELIVERY_DIRECTIONS.find((x) => x.value === direction);
    return { ...d, direction, directionLabel: dir.label, mark: dir.mark, statusLabel: labelOf(DELIVERY_STATUSES, d.status) };
  });
  for (const d of deliveries) {
    flow.push({
      time: d.time || "",
      mark: d.mark,
      kind: "delivery",
      direction: d.direction,
      title: `${d.item || d.directionLabel}${d.quantity ? `　${d.quantity}` : ""} ${d.directionLabel}`,
      kindLabel: d.directionLabel,
      status: d.statusLabel,
      note: [d.vendor, d.origin || d.destination ? `${d.origin || "―"} → ${d.destination || "―"}` : ""].filter(Boolean).join("　"),
      cancelled: d.status === "cancelled"
    });
  }
  flow.sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || a.time.localeCompare(b.time));
  deliveries.sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time || "").localeCompare(b.time || ""));

  // ---- 本日の作業（業者行）----
  const works = (isWork ? report.companies || [] : [])
    .filter((c) => [c.companyName, c.occupation, c.workContent, c.actualWorkerCount, c.plannedWorkerCount].some((v) => String(v ?? "").trim() !== ""))
    .map((c) => {
      // 作業時間: 読み取れれば "08:00～17:00" にそろえ、時間（開始～終了）も出す。読み取れない入力はそのまま表示
      const p = parseWorkHours(c.workHours);
      const minutes = p ? workMinutes(p.start, p.end) : null;
      return {
      vendor: c.companyName || "",
      occupation: c.occupation || "",
      planned: num(c.plannedWorkerCount),
      actual: num(c.actualWorkerCount),
      hours: p ? (p.end ? formatWorkHours(p.start, p.end) : `${p.start}～`) : c.workHours || "",
      hoursDuration: durationLabel(minutes),
      content: c.workContent || "",
      foreman: c.foremanName || "",
      machinery: c.machinery || "",
      notes: c.safetyNotes || "",
      // 人工（現場集計用）: 稼働人数 1人＝1人工。請求人工は使わない
      manDays: manDaysOf(c)
      };
    });

  // ---- 業者別の累計（工事開始から表示日まで。業者名ごと）----
  const vendorTotals = new Map();
  for (const r of workLive.filter((x) => (x.date || "") <= date)) {
    for (const c of r.companies || []) {
      const name = (c.companyName || "").trim();
      if (!name) continue;
      const t = vendorTotals.get(name) || { workers: 0, manDays: 0 };
      t.workers += num(c.actualWorkerCount) || 0;
      t.manDays += manDaysOf(c) || 0;
      vendorTotals.set(name, t);
    }
  }
  for (const w of works) {
    const t = vendorTotals.get(w.vendor.trim());
    w.cumulativeWorkers = t?.workers ?? null;
    w.cumulativeManDays = t?.manDays ?? null;
  }

  // ---- 業者別の安全注意事項（日報の業者ごとの「安全注意事項」。03-2では「作業及び安全に関する指示・注意事項」欄）----
  const safety = works.filter((w) => noteItems(w.notes).length).map((w) => ({ vendor: w.vendor || "（業者名なし）", occupation: w.occupation, items: noteItems(w.notes) }));

  // ---- 巡回点検（日報の巡回点検記録。03-2の「巡回点検記録 良好○ 不良×」と「巡回点検項目に対する是正指示」）----
  const checklist = report?.patrolChecklist || {};
  const counts = { good: 0, bad: 0, na: 0, unset: 0 };
  for (const item of PATROL_CHECKLIST_ITEMS) {
    const v = checklist[item.key];
    if (v === "good" || v === "bad" || v === "na") counts[v]++;
    else counts.unset++;
  }
  const patrol = report
    ? {
        ...counts,
        total: PATROL_CHECKLIST_ITEMS.length,
        // ×（否）の項目。是正指示（patrolComment）はその日1つの文章で、どの項目への指示かは記録されていない。
        // 対応したかどうか（対応状況）はDBに無いので、「未対応」とは判定しない（要確認として示すだけ）
        badItems: PATROL_CHECKLIST_ITEMS.filter((i) => checklist[i.key] === "bad").map((i) => `${i.category}：${i.label}`),
        comment: report.patrolComment || "",
        inspector: report.patrolInspectorName || ""
      }
    : null;

  // ---- 人員（日誌から自動集計）----
  const today = isWork ? actualOf(report) : 0;
  const plannedToday = works.reduce((s, w) => s + (w.planned || 0), 0);
  const cumulative = workLive.filter((r) => (r.date || "") <= date).reduce((s, r) => s + actualOf(r), 0);
  // 業種別の人数（03-2の「稼動人数」欄に相当。日報の業者の業種ごとに実績人数を合計。累計は工事開始から表示日まで）
  const byOccupation = [];
  for (const w of works) {
    if (!w.occupation || !w.actual) continue;
    const found = byOccupation.find((o) => o.occupation === w.occupation);
    if (found) found.count += w.actual;
    else byOccupation.push({ occupation: w.occupation, count: w.actual, cumulative: 0 });
  }
  for (const r of workLive.filter((x) => (x.date || "") <= date)) {
    for (const c of r.companies || []) {
      const o = byOccupation.find((x) => x.occupation === (c.occupation || ""));
      if (o) o.cumulative += num(c.actualWorkerCount) || 0;
    }
  }
  const supervisorCount = (r) => (r?.siteSupervisorNames || []).filter((n) => n && n.trim()).length;
  const supervisorsToday = supervisorCount(report);
  const supervisorsCumulative = live.filter((r) => (r.date || "") <= date).reduce((s, r) => s + supervisorCount(r), 0);
  const staff = {
    byOccupation,
    today,
    plannedToday,
    vendors: works.filter((w) => w.vendor).length,
    foremen: works.filter((w) => w.foreman).length,
    supervisors: supervisorsToday,
    // 累計・延べ労働時間は03-2の稼動人数表の「計」「延労働時間」と同じく社員（現場監督）を含む（1人＝8時間）
    totalToday: today + supervisorsToday,
    cumulative: cumulative + supervisorsCumulative,
    laborHoursToday: (today + supervisorsToday) * HOURS_PER_PERSON,
    laborHoursCumulative: (cumulative + supervisorsCumulative) * HOURS_PER_PERSON
  };

  // ---- 日誌状況（表示日まで）----
  const upTo = live.filter((r) => r.date && r.date <= date);
  const signedByReport = new Map();
  for (const s of signatures) {
    if (s.role !== "foreman" || !s.reportId || !s.companyId) continue;
    if (!signedByReport.has(s.reportId)) signedByReport.set(s.reportId, new Set());
    signedByReport.get(s.reportId).add(s.companyId);
  }
  let scheduled = null;
  let missing = null;
  if (start && toUtc(start) != null && toUtc(date) >= toUtc(start)) {
    const last = end && toUtc(end) != null && toUtc(end) < toUtc(date) ? end : date;
    scheduled = daysBetween(start, last) + 1;
    const dates = new Set(upTo.map((r) => r.date));
    missing = 0;
    for (let i = 0; i < scheduled; i++) if (!dates.has(addDays(start, i))) missing++;
  } else if (start && toUtc(date) < toUtc(start)) {
    scheduled = 0;
    missing = 0;
  }
  const status = {
    scheduled,
    missing,
    unsigned: upTo.filter((r) => (r.companies || []).some((c) => (c.companyName || "").trim() && !signedByReport.get(r.id)?.has(c.companyId))).length,
    unconfirmed: upTo.filter((r) => !r.confirmedAt).length,
    unprinted: upTo.filter((r) => !(r.printCount > 0)).length,
    reportsUpToDate: upTo.length
  };

  const diary = report
    ? {
        weather: report.weather || "",
        temperature: report.temperature ? `${report.temperature}℃` : "",
        tomorrowPlan: report.tomorrowPlan || "",
        remarks: report.remarks || "",
        focusInstructions: report.focusInstructions || "",
        workCoordination: report.workCoordination || "",
        confirmed: !!report.confirmedAt,
        printed: report.printCount > 0
      }
    : null;

  // ---- 今日の確認事項・要確認（日報DBの値だけから判定。新しい必須項目は作らない）----
  const checks = [];
  const add = (label, value, level = "ok") => checks.push({ label, value, level }); // level: ok / warn（要確認） / info
  if (!report) {
    add("日報", "未入力", "warn");
  } else {
    add("日報", `入力済み（${labelOf(DAY_STATUSES, dayStatus)}）`);
    add("進捗率", report.progressPercent != null ? `${report.progressPercent}%` : "未入力", report.progressPercent != null ? "ok" : "warn");
    if (isWork) {
      add("業者", works.length ? `${works.filter((w) => w.vendor).length}社` : "未入力", works.length ? "ok" : "warn");
      add("作業員数", `${today}人`, "info");
      const noHours = works.filter((w) => !w.hours || !w.hours.includes("～") || w.hours.endsWith("～"));
      add("作業時間", noHours.length ? `${noHours.map((w) => w.vendor || "（業者名なし）").join("・")} 未入力` : "入力済み", noHours.length ? "warn" : "ok");
      const signed = signedByReport.get(report.id) || new Set();
      const unsignedVendors = (report.companies || []).filter((c) => (c.companyName || "").trim() && !signed.has(c.companyId)).map((c) => c.companyName.trim());
      if (unsignedVendors.length) for (const v of unsignedVendors) add("署名", `${v} 署名未入力`, "warn");
      else if (works.length) add("署名", "全業者 署名済み");
      add("本日の重点指示", report.focusInstructions ? "入力済み" : "未入力", "info");
      add("作業間の連絡・調整", report.workCoordination ? "入力済み" : "未入力", "info");
      // 巡回点検・要確認: ×の項目、または是正指示がある日（是正指示＝未対応とは扱わない。対応状況はDBに無い）
      if (patrol.bad) add("巡回点検・要確認", `× ${patrol.bad}件${patrol.comment ? "・是正指示あり" : ""}`, "warn");
      else if (patrol.comment) add("巡回点検・要確認", "是正指示あり（×の項目なし）", "warn");
      if (patrol.unset) add("巡回点検", `未記入 ${patrol.unset}項目`, "warn");
      if (!patrol.bad && !patrol.comment && !patrol.unset) add("巡回点検", "全項目 記入済み（×なし）");
      if (deliveries.length) {
        const by = (st) => deliveries.filter((d) => d.status === st).length;
        add("搬入・搬出", `${deliveries.length}件（完了${by("done")}・予定${by("plan")}${by("changed") ? `・変更${by("changed")}` : ""}${by("cancelled") ? `・中止${by("cancelled")}` : ""}）`, "info");
      }
    }
    add("日報の確認", report.confirmedAt ? "確認済み" : "未確認", "info");
  }
  // 危険予知活動表（日報とは別の提出物。日報の有無・提出とは連動させない）
  const ky = buildKyModel({ records: kySubmissions, reports: live, date });
  if (ky.rows.length) {
    if (ky.notSubmittedCount) add("危険予知活動表", `未提出 ${ky.notSubmittedCount}業者（${ky.notSubmittedNames.join("・")}）・提出済み ${ky.submittedCount}／対象 ${ky.targetCount}業者`, "warn");
    else add("危険予知活動表", ky.targetCount ? `全業者 提出済み（${ky.targetCount}業者）` : "対象業者なし（すべて対象外）", ky.targetCount ? "ok" : "info");
  } else if (!report || isWork) {
    add("危険予知活動表", "対象業者 未登録", "info");
  }
  const attention = checks.filter((c) => c.level === "warn");

  // ---- 昨日 → 今日（前日の日報と比べる。片方が無ければ比較しない）----
  const dayFigures = (r) => {
    if (!r) return null;
    if (!isWorkDay(r)) return { state: labelOf(DAY_STATUSES, dayStatusOf(r)) };
    const cs = (r.companies || []).filter((c) => (c.companyName || "").trim() || num(c.actualWorkerCount));
    return { workers: actualOf(r), manDays: cs.reduce((s, c) => s + (manDaysOf(c) || 0), 0), vendors: cs.filter((c) => (c.companyName || "").trim()).length, progress: r.progressPercent ?? null };
  };
  const prevDate = addDays(date, -1);
  const prev = dayFigures(reportOfDate(live, prevDate).report);
  const now = dayFigures(report);
  const compare = { prevDate, prev, now };

  // ---- 現場概要（日報・現場情報から自動で作る）----
  const overview = {
    constructionNumber: header.constructionNumber,
    progress: header.progressPercent,
    dayStatus,
    stateLabel: report ? labelOf(DAY_STATUSES, dayStatus) : "日報なし",
    workers: isWork ? today : null,
    manDays: isWork ? works.reduce((s2, w) => s2 + (w.manDays || 0), 0) : null,
    vendors: isWork ? works.filter((w) => w.vendor).length : null,
    focus: (report?.focusInstructions || "").split(/\r?\n/)[0] || "",
    attentionCount: attention.length
  };

  return { header, reportId: report?.id || null, dayStatus, isWork, sameDayCount, flow, deliveries, works, safety, patrol, staff, status, diary, checks, attention, compare, overview, ky };
}
