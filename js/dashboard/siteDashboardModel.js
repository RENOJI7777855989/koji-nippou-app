/* ==========================================================
   現場ダッシュボード・A3「今日の現場シート」の表示内容を、日誌データから作る
   （DOM・DB非依存の純粋関数）。ダッシュボード用の入力は無く、ここで日誌を
   集計・整理するだけなので、日誌とダッシュボードの内容が食い違わない。

   定義（利用者と確定した仕様）:
     進捗率     … 現場の手入力（0〜100）。未入力なら「工期経過率」を別の表示として出す
     累計       … 工事開始から表示日までの、日誌の実績人数（業者の実績人数）の合計
     延べ労働時間 … 累計 × 8時間（03-2台帳と同じ「1人＝8時間」）
     日誌状況（表示日まで）:
       提出予定 … 工事開始日から表示日まで（竣工予定日を過ぎていればそこまで）の日数
       未提出   … そのうち日報の無い日
       未署名   … 業者名のある行のうち、職長サインの無い業者がある日報
       未承認   … 「確認済み」になっていない日報
       未印刷   … 印刷状態が未印刷の日報
   ========================================================== */

import { labelOf, directionOf, DELIVERY_DIRECTIONS, DELIVERY_STATUSES, FLOW_STATUSES, FLOW_KINDS } from "./dailyFlow.js";

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
export function buildDashboardModel({ site, reports = [], signatures = [], date }) {
  const live = reports.filter((r) => !r.isDeleted);
  const { report, count: sameDayCount } = reportOfDate(live, date);

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
  const header = {
    siteName: site?.name || "",
    constructionNumber: site?.constructionNumber || "",
    clientName: site?.clientName || "",
    startDate: start,
    endDate: end,
    progressPercent: site?.progressPercent ?? null,
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
    flow.push({ time: f.time || "", mark: "●", kind: "flow", title: f.title || labelOf(FLOW_KINDS, f.kind), kindLabel: labelOf(FLOW_KINDS, f.kind), status: labelOf(FLOW_STATUSES, f.status), note: f.note || "" });
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
  const works = (report?.companies || [])
    .filter((c) => [c.companyName, c.occupation, c.workContent, c.actualWorkerCount, c.plannedWorkerCount].some((v) => String(v ?? "").trim() !== ""))
    .map((c) => ({
      vendor: c.companyName || "",
      occupation: c.occupation || "",
      planned: num(c.plannedWorkerCount),
      actual: num(c.actualWorkerCount),
      hours: c.workHours || "",
      content: c.workContent || "",
      foreman: c.foremanName || "",
      machinery: c.machinery || "",
      notes: c.safetyNotes || ""
    }));

  // ---- 人員（日誌から自動集計）----
  const today = actualOf(report);
  const plannedToday = works.reduce((s, w) => s + (w.planned || 0), 0);
  const cumulative = live.filter((r) => (r.date || "") <= date).reduce((s, r) => s + actualOf(r), 0);
  const staff = {
    today,
    plannedToday,
    vendors: works.filter((w) => w.vendor).length,
    foremen: works.filter((w) => w.foreman).length,
    supervisors: (report?.siteSupervisorNames || []).filter((n) => n && n.trim()).length,
    cumulative,
    laborHoursToday: today * HOURS_PER_PERSON,
    laborHoursCumulative: cumulative * HOURS_PER_PERSON
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
        confirmed: !!report.confirmedAt,
        printed: report.printCount > 0
      }
    : null;

  return { header, reportId: report?.id || null, sameDayCount, flow, deliveries, works, staff, status, diary };
}
