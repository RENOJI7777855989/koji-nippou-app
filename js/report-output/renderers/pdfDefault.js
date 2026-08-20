/* ==========================================================
   ②オリジナルPDFレンダラー（rendererId: "default-print-html"）
   会社指定の様式に縛られない、アプリ独自の見やすいレイアウトの
   PDF。ブラウザの印刷機能（印刷 > PDFとして保存）でPDF化する
   前提の、印刷用HTML文書を組み立てるだけの薄いレンダラー。
   実際の印刷/PDF保存操作はUI層（report-output-view.js）が担う。
   現場情報・工事日報・人員一覧（協力会社ごと）・写真・職長サイン・
   巡回点検記録・安全確認事項をすべて1枚のHTMLに反映する。
   写真は大きめのカード表示で見やすさを優先する。

   「常にA4用紙1枚に収める」という要件のため、内容量（協力会社数・
   写真枚数等）によって自然な高さが変わっても必ず1ページに収まる
   よう、印刷時に内容全体をJavaScriptで実測してCSS transform:scale
   で縮小する（Excelの「シートを1ページに収める」に相当する処理を
   HTML側で行っている）。写真も含めて縮小されるため、内容が少ない
   ときほど写真は大きく、内容が多いときは縮小されて1枚に収まる。
   ========================================================== */

import { registerPdfRenderer } from "../rendererRegistry.js";
import { blobToDataUrl } from "../imageUtils.js";
import { escapeHtml } from "../../utils.js";
import { PATROL_CHECKLIST_ITEMS, PATROL_STATUS_OPTIONS } from "../../patrolChecklist.js";

export const DEFAULT_PDF_MAPPING = {
  title: "工事日報",
  showLogo: true,
  showHanko: true
};

// @page { size: A4; margin: 12mm; } の印刷可能領域を96dpi換算pxにしたもの。
// 縮小率計算(fitToOnePage)は、この値を目標サイズとして使う。
const A4_MARGIN_MM = 12;
const MM_TO_PX = 96 / 25.4;
const A4_CONTENT_WIDTH_PX = Math.round((210 - A4_MARGIN_MM * 2) * MM_TO_PX);
const A4_CONTENT_HEIGHT_PX = Math.round((297 - A4_MARGIN_MM * 2) * MM_TO_PX);

const PATROL_STATUS_LABEL = Object.fromEntries(PATROL_STATUS_OPTIONS.map((o) => [o.value, o.label]));

async function companyCardHtml(c) {
  const signatureDataUrl = c.signature?.blob ? await blobToDataUrl(c.signature.blob) : null;
  return `
    <div class="company-card">
      <div class="company-card-head">
        <span class="company-name">${escapeHtml(c.name) || "（業者名未入力）"}</span>
        <span class="company-occupation">${escapeHtml(c.occupation)}</span>
      </div>
      <div class="company-card-body">
        <dl class="summary">
          <dt>予定人数</dt><dd>${escapeHtml(c.plannedWorkerCount) || "-"}人</dd>
          <dt>実績人数</dt><dd>${escapeHtml(c.actualWorkerCount) || "-"}人</dd>
          <dt>使用機械</dt><dd>${escapeHtml(c.machinery) || "-"}</dd>
          <dt>作業内容</dt><dd>${escapeHtml(c.workContent) || "-"}</dd>
          <dt>安全注意事項</dt><dd>${escapeHtml(c.safetyNotes) || "-"}</dd>
        </dl>
        <div class="foreman-box">
          <p class="foreman-name">職長: ${escapeHtml(c.foremanName) || "-"}</p>
          ${signatureDataUrl ? `<img class="sign-img" src="${signatureDataUrl}" alt="職長サイン">` : `<p class="no-sign">未サイン</p>`}
        </div>
      </div>
    </div>`;
}

function patrolRowHtml(item, checklist) {
  const status = checklist[item.key] || "";
  if (!status) return ""; // 未確認の項目は出力しない
  const statusClass = status === "good" ? "status-good" : status === "bad" ? "status-bad" : "status-na";
  return `<tr><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.label)}</td><td class="${statusClass}">${escapeHtml(PATROL_STATUS_LABEL[status] || status)}</td></tr>`;
}

async function render(model, mapping, companyProfile) {
  const opts = { ...DEFAULT_PDF_MAPPING, ...(mapping || {}) };
  const profile = companyProfile || model.companyProfile;

  const logoDataUrl = opts.showLogo && profile?.logoBlob ? await blobToDataUrl(profile.logoBlob) : null;
  const hankoDataUrl = opts.showHanko && profile?.hankoBlob ? await blobToDataUrl(profile.hankoBlob) : null;

  const companyCards = (await Promise.all(model.companies.map(companyCardHtml))).join("");
  const patrolRows = PATROL_CHECKLIST_ITEMS.map((item) => patrolRowHtml(item, model.report.patrolChecklist || {})).join("");
  const photoDataUrls = await Promise.all(model.photos.map((p) => blobToDataUrl(p.blob)));

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(opts.title)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; margin: 0; padding: 0; color: #222; }
  #page-content { padding: 16px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 3px solid #2b6cb0; padding-bottom: 8px; }
  header img { max-height: 56px; }
  h1 { font-size: 22px; margin: 0; color: #1a4971; }
  h2 { font-size: 15px; margin: 22px 0 8px; padding-left: 8px; border-left: 5px solid #2b6cb0; break-after: avoid; }
  section { break-inside: avoid; }

  .info-panel { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: #f4f8fc; border-radius: 8px; padding: 12px 16px; margin-bottom: 4px; }
  .info-panel .info-item dt { font-size: 11px; color: #667; margin: 0; }
  .info-panel .info-item dd { font-size: 15px; font-weight: bold; margin: 2px 0 0; }
  .info-panel .info-item.wide { grid-column: span 2; }

  .company-card { border: 1px solid #ccc; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; break-inside: avoid; }
  .company-card-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 6px; }
  .company-name { font-size: 15px; font-weight: bold; }
  .company-occupation { font-size: 12px; color: #555; }
  .company-card-body { display: flex; gap: 16px; }
  dl.summary { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; font-size: 12px; margin: 0; flex: 1; }
  dl.summary dt { font-weight: bold; color: #555; }
  dl.summary dd { margin: 0; }
  .foreman-box { width: 160px; flex-shrink: 0; text-align: center; border-left: 1px solid #eee; padding-left: 12px; }
  .foreman-name { font-size: 12px; margin: 0 0 4px; }
  .sign-img { max-width: 150px; max-height: 60px; border: 1px solid #ddd; background: #fff; }
  .no-sign { font-size: 11px; color: #999; }

  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #999; padding: 4px 8px; font-size: 12px; text-align: left; vertical-align: top; }
  th { background: #eef4fa; }
  .status-good { color: #1a7a34; font-weight: bold; }
  .status-bad { color: #c0392b; font-weight: bold; }
  .status-na { color: #888; }

  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; margin-top: 8px; }
  .photo-card { break-inside: avoid; }
  .photo-card img { width: 100%; height: 320px; object-fit: cover; border: 1px solid #ccc; border-radius: 6px; display: block; }

  .signature-area { margin-top: 20px; display: flex; align-items: flex-end; justify-content: flex-end; gap: 16px; }
  .signature-area img { max-height: 80px; }

  /* 内容全体を常にA4用紙1枚に収めるための縮小コンテナ。
     #page-outerの高さをJSで実測結果に合わせるため、初期状態では
     高さ非表示(overflow:hidden, height:0)にしておき、縮小率が
     決まった瞬間に正しい高さへ切り替える（縮小前の一瞬だけ
     はみ出した状態が見えてしまうのを防ぐ）。 */
  #page-outer { overflow: hidden; }
  #page-content { transform-origin: top left; }
</style>
</head>
<body>
  <div id="page-outer">
  <div id="page-content">
  <header>
    <h1>${escapeHtml(opts.title)}</h1>
    ${logoDataUrl ? `<img src="${logoDataUrl}" alt="会社ロゴ">` : ""}
  </header>

  <section>
    <h2>現場情報・工事日報</h2>
    <div class="info-panel">
      <div class="info-item wide"><dt>現場名</dt><dd>${escapeHtml(model.site.name)}</dd></div>
      <div class="info-item wide"><dt>元請名</dt><dd>${escapeHtml(model.site.clientName)}</dd></div>
      <div class="info-item"><dt>日付</dt><dd>${escapeHtml(model.report.date)}</dd></div>
      <div class="info-item"><dt>天気</dt><dd>${escapeHtml(model.report.weather)} ${escapeHtml(model.report.temperature)}</dd></div>
      <div class="info-item"><dt>作業人数（合計）</dt><dd>${escapeHtml(model.report.workerCountTotal) || "0"}人</dd></div>
      <div class="info-item wide"><dt>明日の予定</dt><dd>${escapeHtml(model.report.tomorrowPlan) || "-"}</dd></div>
      <div class="info-item wide" style="grid-column: 1 / -1;"><dt>備考</dt><dd>${escapeHtml(model.report.remarks) || "-"}</dd></div>
    </div>
  </section>

  <section>
    <h2>人員一覧・協力会社ごとの作業内容（職長サイン含む）</h2>
    ${companyCards || `<p>業者の記載はありません</p>`}
  </section>

  ${patrolRows ? `
  <section>
    <h2>巡回点検記録・安全確認事項</h2>
    <dl class="summary" style="margin-bottom:6px;"><dt>巡回者</dt><dd>${escapeHtml(model.report.patrolInspectorName) || "-"}</dd></dl>
    <table>
      <thead><tr><th>区分</th><th>点検項目</th><th>状況</th></tr></thead>
      <tbody>${patrolRows}</tbody>
    </table>
    ${model.report.patrolComment ? `<dl class="summary" style="margin-top:6px;"><dt>是正指示</dt><dd>${escapeHtml(model.report.patrolComment)}</dd></dl>` : ""}
  </section>
  ` : ""}

  ${photoDataUrls.length ? `
  <section>
    <h2>写真（${photoDataUrls.length}枚）</h2>
    <div class="photo-grid">
      ${photoDataUrls.map((url) => `<div class="photo-card"><img src="${url}" alt="現場写真"></div>`).join("")}
    </div>
  </section>
  ` : ""}

  ${hankoDataUrl ? `<div class="signature-area"><img src="${hankoDataUrl}" alt="印影"></div>` : ""}
  </div>
  </div>
  <script>
  (function () {
    // A4縦・余白12mmでの印刷可能領域（96dpi換算px）。@pageの設定と対応させている。
    var TARGET_WIDTH_PX = ${A4_CONTENT_WIDTH_PX};
    var TARGET_HEIGHT_PX = ${A4_CONTENT_HEIGHT_PX};

    function fitToOnePage() {
      var content = document.getElementById("page-content");
      var outer = document.getElementById("page-outer");
      if (!content || !outer) return;
      content.style.transform = "none";
      content.style.width = TARGET_WIDTH_PX + "px";
      var naturalHeight = content.scrollHeight;
      var scale = Math.min(1, TARGET_HEIGHT_PX / naturalHeight);
      content.style.transform = "scale(" + scale + ")";
      outer.style.width = TARGET_WIDTH_PX + "px";
      outer.style.height = Math.ceil(naturalHeight * scale) + "px";
    }

    window.addEventListener("load", fitToOnePage);
    window.addEventListener("beforeprint", fitToOnePage);
    window.addEventListener("resize", fitToOnePage);
    if (document.readyState === "complete") fitToOnePage();
  })();
  </script>
</body>
</html>`;

  const filename = `${model.site.name || "現場"}_${model.report.date || "日付未定"}_日報.html`;
  return { html, filename };
}

registerPdfRenderer("default-print-html", render);
