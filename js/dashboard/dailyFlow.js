/* ==========================================================
   日誌の「本日の現場の流れ」「搬入・搬出」の定義（DOM・DB非依存）
   日誌の入力画面（report-form-view.js）と、現場ダッシュボード・
   A3「今日の現場シート」（siteDashboardModel.js）が同じ定義を使う。
   データは日報レコードの timeline / deliveries に保存する（DBの構造は変えない）。
   deliveries は搬入と搬出を1つの配列に持ち、各行の direction（"in"/"out"）で区別する。
   ========================================================== */

/**
 * 本日の現場の流れの種別（ダッシュボードの印: ● 通常 / ◆ 搬入 / ◇ 搬出）。
 * 「朝礼・打合せ」（meeting）は朝礼・打ち合わせ・昼礼・現場巡回に分けた。meeting は以前に保存した行を
 * 読むためだけに残し（legacy）、新しく選ぶ選択肢には出さない（その行を開いたときだけ出す）。
 */
export const FLOW_KINDS = [
  { value: "chorei", label: "朝礼" },
  { value: "uchiawase", label: "打ち合わせ" },
  { value: "churei", label: "昼礼" },
  { value: "patrol", label: "現場巡回" },
  { value: "work", label: "作業" },
  { value: "inspection", label: "検査・立会" },
  { value: "other", label: "その他" },
  { value: "meeting", label: "朝礼・打合せ", legacy: true }
];

/** 状態。done は「実際に行った」の意味なので表示は「実施済み」（保存値は以前と同じ。以前の表示は「実績」） */
export const FLOW_STATUSES = [
  { value: "plan", label: "予定" },
  { value: "done", label: "実施済み" }
];

/** 搬入・搬出の区分。区分の無い行（区分を追加する前に保存した搬入事項）は搬入として扱う */
export const DELIVERY_DIRECTIONS = [
  { value: "in", label: "搬入", mark: "◆" },
  { value: "out", label: "搬出", mark: "◇" }
];

/** 区分の値（無い・不明なら "in"） */
export const directionOf = (row) => (row?.direction === "out" ? "out" : "in");

/** 状況（保存値は区分を追加する前と同じ。"done" の表示を「搬入済」から「完了」に変えただけ） */
export const DELIVERY_STATUSES = [
  { value: "plan", label: "予定" },
  { value: "done", label: "完了" },
  { value: "changed", label: "変更" },
  { value: "cancelled", label: "中止" }
];

export const labelOf = (list, value) => list.find((x) => x.value === value)?.label || "";

/**
 * 日報の「日の状態」。日報が無い日（未入力）とは別。
 *   work    … 通常作業
 *   nowork  … 作業なし（稼働対象日だが作業が無かった日）
 *   holiday … 休工日（休日・休工として現場を止めている日）
 * 作業なし・休工日の日報は履歴として残すが、稼働人数・人工・作業時間・業種別累計・業者別稼働には数えない。
 * 項目の無い日報（この項目を追加する前の日報）は通常作業として扱う。
 */
export const DAY_STATUSES = [
  { value: "work", label: "通常作業" },
  { value: "nowork", label: "作業なし" },
  { value: "holiday", label: "休工日" }
];
export const dayStatusOf = (report) => (report?.dayStatus === "nowork" || report?.dayStatus === "holiday" ? report.dayStatus : "work");
export const isWorkDay = (report) => dayStatusOf(report) === "work";

/** "8:00" "08:00" "8時" などを "08:00" にそろえる（読めなければ空） */
export function normalizeTime(text) {
  const m = /^\s*(\d{1,2})\s*[:：時]\s*(\d{1,2})?/.exec(String(text || ""));
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/* ---------- 業者ごとの作業時間（開始～終了。保存は従来どおり workHours の文字列 "08:00～17:00"）---------- */

/** 作業時間の選択肢（30分刻み） */
export const WORK_TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

/**
 * 保存されている作業時間（"8:00～17:00" "08:00-17:00" "8時～17時" "8:00から17:00" "8：00〜17:00" など）から開始・終了を読み取る。
 * 読み取れない自由入力は null（呼び出し側は元の文字をそのまま残す）
 */
export function parseWorkHours(text) {
  // 区切りは「～」「〜」「~」「-」「から」など。開始だけ（"8:00" "8:00～"）も読み、そのときの end は空
  const m = /^\s*(\d{1,2}\s*[:：時]\s*\d{0,2})\s*(?:分)?\s*(?:(?:[～〜~\-ー－―]|から)\s*(?:(\d{1,2}\s*[:：時]\s*\d{0,2})\s*(?:分)?)?)?\s*$/.exec(String(text || ""));
  if (!m) return null;
  const start = normalizeTime(m[1]);
  const end = m[2] ? normalizeTime(m[2]) : "";
  if (!start || (m[2] && !end)) return null;
  return { start, end };
}

/** 開始・終了から保存用の文字列（どちらかが空なら空） */
export const formatWorkHours = (start, end) => (start && end ? `${start}～${end}` : "");

/** 開始～終了の時間（分）。終了が開始以前なら null（日をまたぐ作業は計算しない） */
export function workMinutes(start, end) {
  const toMin = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const a = toMin(start);
  const b = toMin(end);
  return a == null || b == null || b <= a ? null : b - a;
}

/** "9時間" "8時間30分"（開始～終了の時間。休憩時間を入力する欄は無いため差し引かない） */
export function durationLabel(minutes) {
  if (minutes == null) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

/** 本日の現場の流れの1行を整える（すべて空の行はnull） */
export function normalizeFlowRow(row) {
  const r = {
    id: row.id || "",
    time: normalizeTime(row.time),
    title: String(row.title || "").trim(),
    kind: FLOW_KINDS.some((k) => k.value === row.kind) ? row.kind : "work",
    status: FLOW_STATUSES.some((s) => s.value === row.status) ? row.status : "plan",
    note: String(row.note || "").trim()
  };
  return r.time || r.title || r.note ? r : null;
}

const DELIVERY_TEXT_FIELDS = ["item", "quantity", "vendor", "origin", "destination", "vehicle", "note"];

/** 搬入・搬出の1行を整える（すべて空の行はnull）。origin/destination は区分に応じて搬入元・搬入先／搬出元・搬出先 */
export function normalizeDeliveryRow(row) {
  const r = { id: row.id || "", direction: directionOf(row), time: normalizeTime(row.time) };
  for (const f of DELIVERY_TEXT_FIELDS) r[f] = String(row[f] || "").trim();
  r.status = DELIVERY_STATUSES.some((s) => s.value === row.status) ? row.status : "plan";
  return r.time || DELIVERY_TEXT_FIELDS.some((f) => r[f]) ? r : null;
}
