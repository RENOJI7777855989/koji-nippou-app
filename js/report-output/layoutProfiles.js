/* ==========================================================
   帳票様式の種類（レイアウトプロファイル）のレジストリ
   「03-2 安全衛生作業打合日誌」のような会社様式ごとに、
     ・1日分の出力マッピング（dailyMapping）
     ・台帳出力のマッピング（ledgerMapping）
     ・その様式かどうかの判定（detect）
   をまとめて登録する。アプリ全体のデータ構造（sites/reports/reportTemplates）は
   様式固有の情報を持たず、テンプレートのレコードに layoutId（文字列）を持たせて
   ここを引くだけにする。別の様式・新しい版に対応するときは、layouts/ に
   プロファイルを1つ追加して layouts/index.js に1行importするだけでよい。
   ========================================================== */

const profiles = new Map();

/**
 * @param {{
 *   id: string, label: string,
 *   dailyMapping: object, ledgerMapping?: object|null,
 *   detect: (ctx: {sheetNames: string[]}) => boolean
 * }} profile
 */
export function registerLayoutProfile(profile) {
  if (!profile?.id) throw new Error("レイアウトプロファイルにidが必要です");
  profiles.set(profile.id, profile);
}

export function getLayoutProfile(id) {
  return id ? profiles.get(id) || null : null;
}

export function listLayoutProfiles() {
  return [...profiles.values()];
}

/** シート名一覧などから、登録済みのどの様式か判別する（判別できなければnull） */
export function detectLayoutProfile(ctx) {
  return listLayoutProfiles().find((p) => p.detect(ctx)) || null;
}
