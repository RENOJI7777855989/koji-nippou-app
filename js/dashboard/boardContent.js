/* ==========================================================
   現場掲示（作業員・業者への周知）の内容の定義（DOM・DB非依存）
   画面の「現場掲示」タブ（js/ui/site-dashboard.js）と、A3「今日の現場シート」の印刷
   （todaySheetHtml.js）の両方がここを使う。欄の名前・並び・中身をここで1か所にまとめ、
   画面と印刷で別々に書き直して食い違わないようにする。データは同じ buildDashboardModel の結果。

   載せないもの: 今日の確認事項・日誌状況など監督向けの情報、請求人工、見積の情報。
   巡回点検は状況（実施／要確認／未実施（休工日等）／未記入／記録なし）・件数・×の項目・是正指示だけ（対応状況は推測しない）。
   ========================================================== */

/** 現場掲示のレイアウトの版。画面の現場掲示タブとA3の印刷の両方に小さく表示し、古い版が出ていないか見分けられるようにする */
export const BOARD_LAYOUT_VERSION = "2026-10-03-3";

/**
 * 現場掲示の欄（この順に並べる）。a3: A3での置き場所
 *   works: 上段の表 / flow・deliveries: 中段 / side: 中段の右列 / bottom: 下段（手書き用の罫線つき）
 */
export const BOARD_SECTIONS = [
  { key: "works", title: "本日の作業・業者別 稼働状況", a3: "works" },
  { key: "flow", title: "本日の現場の流れ", a3: "flow" },
  { key: "deliveries", title: "本日の搬入・搬出", a3: "deliveries" },
  { key: "focus", title: "本日の重点指示", a3: "side" },
  { key: "ky", title: "本日の危険予知活動表", a3: "side" },
  { key: "patrol", title: "本日の巡回点検", a3: "mid" },
  { key: "safety", title: "本日の安全注意事項（業者別）", a3: "works" }, // A3では本日の作業の表の「安全注意事項・使用機械」の列
  { key: "staff", title: "本日の人員", a3: "side" },
  { key: "coordination", title: "作業間の連絡・調整", a3: "bottom" },
  { key: "notice", title: "連絡事項", a3: "bottom" },
  { key: "tomorrow", title: "明日の予定", a3: "bottom" }
];

export const sectionTitle = (key) => BOARD_SECTIONS.find((s) => s.key === key)?.title || key;

/** 危険予知活動表の状態の表示（紙のKY活動表が提出されたか） */
export const KY_BOARD_LABELS = { submitted: "✓ 提出済み", not_submitted: "未提出", excluded: "対象外" };

const slashDate = (iso) => (iso ? iso.replace(/-/g, "/") : "");

/**
 * 現場掲示の上部の情報帯（工期・本日・工事○日目・工期経過・残り・進捗・天気。画面とA3で同じもの）
 * 進捗率は日報に入力された値だけ（工期経過から計算しない）、天気はその日の日報の値だけ（推測しない）
 */
export function buildInfoBand(model) {
  const h = model.header;
  const p = h.period || { phase: "unset" };
  const md = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}/${d}`; };
  const range = p.phase === "unset" ? "未設定" : `${slashDate(p.startDate)} ～ ${p.endDate ? slashDate(p.endDate) : "未定"}${p.totalDays ? `（${p.totalDays}日）` : ""}`;
  const day = { unset: "工期未設定", before: "工事開始前", during: `${p.dayNumber}日目`, after: `${p.dayNumber}日目` }[p.phase];
  const elapsed = { unset: "工期未設定", before: "工事開始前", during: `${p.elapsedDays}日`, after: `${p.elapsedDays}日` }[p.phase];
  const remaining = p.phase === "unset" ? "工期未設定" : p.phase === "before" ? "工事開始前" : p.phase === "after" ? "工期終了" : p.endDate ? `${p.remainingDays}日` : "終了日未設定";
  // 進捗率: 表示日までで一番新しい日報の値（その日報が未入力なら「未入力」。それより前の日報の値には戻さない）
  const progress = h.progressPercent != null ? `${h.progressPercent}%${h.progressDate && h.progressDate !== h.date ? `（${md(h.progressDate)}の日報）` : ""}` : "未入力";
  const d = model.diary;
  const weather = d?.weather ? `${d.weather}${d.temperature ? `　${d.temperature}${/\d$/.test(String(d.temperature)) ? "℃" : ""}` : ""}` : "未入力";
  return [
    { key: "period", label: "工期", value: range, missing: p.phase === "unset" },
    { key: "today", label: "本日", value: `${slashDate(h.date)}（${h.weekday}）` },
    { key: "day", label: "工事", value: day, missing: p.phase === "unset" },
    { key: "elapsed", label: "工期経過", value: elapsed, missing: p.phase === "unset" },
    { key: "remaining", label: "残り", value: remaining, missing: p.phase === "unset" || (p.phase === "during" && !p.endDate) },
    { key: "progress", label: "進捗", value: progress, missing: h.progressPercent == null },
    { key: "weather", label: "天気", value: weather, missing: !d?.weather }
  ];
}

/** 現場掲示の中身（画面・A3共通） */
export function buildBoardContent(model) {
  const h = model.header;
  const diary = model.diary;
  const temperature = diary?.temperature ? `${diary.temperature}${/\d$/.test(String(diary.temperature)) ? "℃" : ""}` : "";
  const works = model.isWork
    ? model.works.map((w) => ({
        vendor: w.vendor,
        trade: w.occupation, // 工種（日誌の業者の「職種」欄）
        planned: w.planned,
        actual: w.actual, // 稼働人数
        manDays: w.manDays, // 人工（稼働人数を1人＝1人工）。請求人工は使わない
        hours: w.hours,
        hoursDuration: w.hoursDuration,
        content: w.content,
        foreman: w.foreman,
        notes: w.notes,
        machinery: w.machinery
      }))
    : [];
  const ky = model.ky || { rows: [], targetCount: 0, submittedCount: 0, notSubmittedCount: 0, excludedCount: 0 };
  return {
    version: BOARD_LAYOUT_VERSION,
    band: buildInfoBand(model),
    header: {
      siteName: h.siteName,
      constructionNumber: h.constructionNumber,
      date: h.date,
      weekday: h.weekday,
      weather: diary?.weather || "",
      temperature,
      startDate: h.startDate,
      endDate: h.endDate,
      progressText: h.progressPercent != null ? `進捗 ${h.progressPercent}%` : "進捗 未入力",
      elapsedText: h.elapsedPct != null ? `工期経過 ${h.elapsedPct}%` : "",
      remainingDays: h.remainingDays,
      dayNumber: h.dayNumber
    },
    dayStateLabel: { nowork: "本日は作業なし", office: "本日は事務作業日", holiday: "本日は休工日" }[model.dayStatus] || "",
    works,
    // 業者数は業者名の種類、工種数は工種の種類（同じ業者の複数工種・同じ工種の複数業者を正しく数える）
    totals: { workers: works.reduce((s, w) => s + (w.actual || 0), 0), manDays: works.reduce((s, w) => s + (w.manDays || 0), 0), vendors: model.staff?.vendors ?? null, trades: model.staff?.trades ?? null },
    flow: model.flow,
    deliveries: model.deliveries,
    focus: diary?.focusInstructions || "",
    coordination: diary?.workCoordination || "",
    notice: diary?.remarks || "",
    tomorrow: diary?.tomorrowPlan || "",
    safety: model.safety,
    staff: model.staff,
    // 巡回点検（状況は patrolStatusOf で表示時に判定。休工日等で記録が無い日は件数を出さず「未実施（…）」だけ）
    patrol: {
      state: model.patrolStatus?.state || "none",
      label: model.patrolStatus?.label || "記録なし",
      counts: model.patrol && !["notdone", "blank", "none"].includes(model.patrolStatus?.state) ? { good: model.patrol.good, bad: model.patrol.bad, na: model.patrol.na, unset: model.patrol.unset } : null,
      badItems: model.patrol?.badItems || [],
      comment: model.patrol?.comment || ""
    },
    ky: {
      rows: ky.rows.map((r) => ({ vendorName: r.vendorName, state: r.state, label: KY_BOARD_LABELS[r.state] })),
      targetCount: ky.targetCount,
      submittedCount: ky.submittedCount,
      notSubmittedCount: ky.notSubmittedCount,
      excludedCount: ky.excludedCount
    }
  };
}
