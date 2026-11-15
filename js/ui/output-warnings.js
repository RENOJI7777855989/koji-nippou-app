/* ==========================================================
   帳票出力の警告を画面に出す（2026-11-01）
   帳票（03-2 など）に入りきらない作業行・工種の行などの警告（出力処理の warnings）を、コンソールに出すだけで
   終わらせず、Excel はダウンロードの前に確認し、印刷・PDF は印刷ダイアログの上に表示する。
   データは消さない・まとめない（帳票に書けない行があることを知らせるだけ）。

   ダウンロードの前に確認するのは、出力の内容が大きく欠けるものだけ（2026-11-01。利用者の指定。isBlockingWarning）:
     ・協力会社欄に書けない作業行がある（xlsxCellPlan.js「協力会社欄に書けるのは…」）
     ・その日の人数を稼動人数表の業種の行に書けない（tradeAttendance.js「（本日n人）」。工種が未入力の行の本日の人数も）
   それ以外（累計だけの業種、搬入・搬出の「ほか n件」、台帳のシートの追加などのお知らせ）は様式の枠による通常の制約なので、
   ダウンロードを止めず、出力後の注意として出す（実データの66件中5件で、毎回確認が出ていたため）。
   ========================================================== */

/** ダウンロードの前に確認する警告か（出力の内容が大きく欠けるもの） */
export function isBlockingWarning(w) {
  return /協力会社欄に書けるのは|（本日\d/.test(String(w || ""));
}

/** 警告を「ダウンロード前に確認するもの」と「出力後の注意」に分ける */
export function splitOutputWarnings(warnings) {
  const list = (warnings || []).filter(Boolean);
  return { blocking: list.filter(isBlockingWarning), notices: list.filter((w) => !isBlockingWarning(w)) };
}

/** 警告の一覧の文（多すぎるときは先頭だけ。残りの件数を示す） */
export function warningsText(warnings, limit = 12) {
  const list = (warnings || []).filter(Boolean);
  const shown = list.slice(0, limit).map((w) => `・${w}`);
  if (list.length > limit) shown.push(`・ほか${list.length - limit}件`);
  return shown.join("\n");
}

/**
 * 出力の内容が大きく欠ける警告（isBlockingWarning）があれば、出力（ダウンロード）する前に確認する。無ければそのまま true
 * （累計だけの業種・搬入の「ほか n件」などの注意では止めない。出力後のメッセージで知らせる）。
 * @param {string[]} warnings
 * @param {string} action 例: 「Excelを出力」
 * @returns {boolean} 出力してよいか
 */
export function confirmOutputWarnings(warnings, action) {
  const { blocking, notices } = splitOutputWarnings(warnings);
  if (!blocking.length) return true;
  return confirm(`帳票に書けない内容があります（日報のデータは消えていません）:\n\n${warningsText(blocking)}${notices.length ? `\n\n（このほかの注意${notices.length}件は、出力後に表示します）` : ""}\n\nこのまま${action}しますか？`);
}
