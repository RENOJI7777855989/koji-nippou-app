/* ==========================================================
   帳票レンダラー向けの画像変換ユーティリティ
   ロゴ・印影・署名・写真はBlobで保存されているため、
   HTML/CSV等に埋め込む際にdata URLへ変換する。
   ========================================================== */

export function blobToDataUrl(blob) {
  if (!blob) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
