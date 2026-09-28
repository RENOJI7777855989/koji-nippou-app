/* ==========================================================
   日誌の「本日の現場の流れ」「搬入・搬出」の定義（DOM・DB非依存）
   日誌の入力画面（report-form-view.js）と、現場ダッシュボード・
   A3「今日の現場シート」（siteDashboardModel.js）が同じ定義を使う。
   データは日報レコードの timeline / deliveries に保存する（DBの構造は変えない）。
   deliveries は搬入と搬出を1つの配列に持ち、各行の direction（"in"/"out"）で区別する。
   ========================================================== */

/** 本日の現場の流れの種別（ダッシュボードの印: ● 通常 / ◆ 搬入） */
export const FLOW_KINDS = [
  { value: "meeting", label: "朝礼・打合せ" },
  { value: "work", label: "作業" },
  { value: "inspection", label: "検査・立会" },
  { value: "other", label: "その他" }
];

export const FLOW_STATUSES = [
  { value: "plan", label: "予定" },
  { value: "done", label: "実績" }
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

/** "8:00" "08:00" "8時" などを "08:00" にそろえる（読めなければ空） */
export function normalizeTime(text) {
  const m = /^\s*(\d{1,2})\s*[:：時]\s*(\d{1,2})?/.exec(String(text || ""));
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
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
