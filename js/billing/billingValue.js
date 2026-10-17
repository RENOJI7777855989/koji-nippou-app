/* ==========================================================
   請求人工の入力値の決まり（日報画面・請求人工入力の画面・保存処理で共通。2026-10-17）
   ・空欄は未入力（""）。0 は「0」と入力したときだけ0人工
   ・0以上の数で、小数は2桁まで（例 1・2.5・3.75・0.5・.5）。全角数字・全角小数点は半角として読む
   ・誤り（保存しない）: マイナス、-0、指数表記（1e2 など）、小数3桁以上（1.333）、数字以外、「1.」のような途中の形
   ・正しい値は数の形にそろえる（"2.50"→"2.5"、"007"→"7"）。誤りを別の数（100 など）に変えて保存することはしない
   ・ほかのモジュールを読み込まない（reports.js からも使うため。循環を作らない）
   ========================================================== */

const BILLING_PATTERN = /^(\d+(\.\d{1,2})?|\.\d{1,2})$/;

/**
 * 請求人工の入力値を検査して整える
 * @param {unknown} raw 入力欄の文字列（数値でもよい）
 * @returns {{value: string}|null} 空欄は { value: "" }、正しい値は { value: "2.5" }、誤りは null
 */
export function parseBillingInput(raw) {
  if (raw === null || raw === undefined) return { value: "" };
  const s = String(raw).trim().replace(/[０-９．]/g, (d) => (d === "．" ? "." : String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
  if (s === "") return { value: "" };
  if (!BILLING_PATTERN.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? { value: String(n) } : null;
}

export const BILLING_INPUT_RULE = "請求人工は0以上の数で、小数は2桁まで（例 2・2.5・3.75）。空欄は未入力、0人工は「0」。マイナス・1e2 などの表記・小数3桁以上は使えません。";
