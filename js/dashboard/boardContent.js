/* ==========================================================
   現場掲示（作業員・業者への周知）の内容の定義（DOM・DB非依存）
   画面の「現場掲示」タブ（js/ui/site-dashboard.js）と、A3「今日の現場シート」の印刷
   （todaySheetHtml.js）の両方がここを使う。欄の名前・並び・中身をここで1か所にまとめ、
   画面と印刷で別々に書き直して食い違わないようにする。データは同じ buildDashboardModel の結果。

   載せないもの: 今日の確認事項・日誌状況・巡回点検など監督向けの情報、請求人工、見積の情報。
   ========================================================== */

/** 現場掲示のレイアウトの版。画面の現場掲示タブとA3の印刷の両方に小さく表示し、古い版が出ていないか見分けられるようにする */
export const BOARD_LAYOUT_VERSION = "2026-10-03";

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
  { key: "safety", title: "本日の安全注意事項（業者別）", a3: "works" }, // A3では本日の作業の表の「安全注意事項・使用機械」の列
  { key: "staff", title: "本日の人員", a3: "side" },
  { key: "coordination", title: "作業間の連絡・調整", a3: "bottom" },
  { key: "notice", title: "連絡事項", a3: "bottom" },
  { key: "tomorrow", title: "明日の予定", a3: "bottom" }
];

export const sectionTitle = (key) => BOARD_SECTIONS.find((s) => s.key === key)?.title || key;

/** 危険予知活動表の状態の表示（紙のKY活動表が提出されたか） */
export const KY_BOARD_LABELS = { submitted: "✓ 提出済み", not_submitted: "未提出", excluded: "対象外" };

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
    dayStateLabel: model.dayStatus === "nowork" ? "本日は作業なし" : model.dayStatus === "holiday" ? "本日は休工日" : "",
    works,
    totals: { workers: works.reduce((s, w) => s + (w.actual || 0), 0), manDays: works.reduce((s, w) => s + (w.manDays || 0), 0) },
    flow: model.flow,
    deliveries: model.deliveries,
    focus: diary?.focusInstructions || "",
    coordination: diary?.workCoordination || "",
    notice: diary?.remarks || "",
    tomorrow: diary?.tomorrowPlan || "",
    safety: model.safety,
    staff: model.staff,
    ky: {
      rows: ky.rows.map((r) => ({ vendorName: r.vendorName, state: r.state, label: KY_BOARD_LABELS[r.state] })),
      targetCount: ky.targetCount,
      submittedCount: ky.submittedCount,
      notSubmittedCount: ky.notSubmittedCount,
      excludedCount: ky.excludedCount
    }
  };
}
