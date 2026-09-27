/* ==========================================================
   A3横「今日の現場シート」の印刷用HTML（DOM・DB非依存）
   現場ダッシュボードと同じ表示内容（siteDashboardModel.js）から作る。
   会社指定の03-2とは別の帳票で、03-2の仕組み・様式には一切触れない。

   ・用紙はA3横（@page）。1枚に収まるよう、各欄の文字が溢れる場合だけ
     表示時・印刷前に文字を小さくする（情報が少ない日は小さくしない）
   ・下段の「申し送り」「明日の予定」「現場メモ」は、日誌の内容を載せたうえで
     残りを手書き用の罫線にする（無理に情報を詰め込まない）
   ========================================================== */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const br = (v) => esc(v).replace(/\n/g, "<br>");

const ruled = (count) => `<div class="ruled">${"<div></div>".repeat(count)}</div>`;

export function buildTodaySheetHtml(model) {
  const h = model.header;
  const [y, m, d] = h.date.split("-").map(Number);
  const dateText = `${y}年${m}月${d}日（${h.weekday}）`;
  const progress = h.progressPercent != null ? `進捗 ${h.progressPercent}%` : h.elapsedPct != null ? `工期経過 ${h.elapsedPct}%` : "";
  const diary = model.diary;

  const flow = model.flow.length
    ? `<table class="flow">${model.flow
        .map((f) => `<tr class="${f.kind === "delivery" ? "dlv" : ""}${f.cancelled ? " cancelled" : ""}"><td class="t">${esc(f.time || "")}</td><td class="mk">${f.mark}</td><td class="ti">${esc(f.title)}${f.note ? `<div class="nt">${esc(f.note)}</div>` : ""}</td><td class="st">${esc(f.status || "")}</td></tr>`)
        .join("")}</table>`
    : `<p class="empty">本日の現場の流れ（日誌に未入力）</p>`;
  const flowFill = model.flow.length < 8 ? ruled(8 - model.flow.length) : "";

  const deliveries = model.deliveries.length
    ? model.deliveries
        .map((dl) => `<div class="dlv-item${dl.status === "cancelled" ? " cancelled" : ""}">
          <div class="dlv-head"><b>${esc(dl.time || "--:--")}</b>　<b>${esc(dl.item || "搬入")}</b>${dl.quantity ? `　${esc(dl.quantity)}` : ""}<span class="badge">${esc(dl.statusLabel)}</span></div>
          <div class="dlv-body">${[["業者", dl.vendor], ["搬入元", dl.origin], ["搬入先", dl.destination], ["車両", dl.vehicle]].filter(([, v]) => v).map(([k, v]) => `${k}：${esc(v)}`).join("　")}</div>
          ${dl.note ? `<div class="dlv-note">備考：${br(dl.note)}</div>` : ""}
        </div>`)
        .join("")
    : `<p class="empty">本日の搬入なし</p>`;

  const s = model.staff;
  const staff = `<div class="staff">
      <div class="big">${s.today}<small>人</small></div>
      <table class="kv">
        ${s.plannedToday ? `<tr><th>予定</th><td>${s.plannedToday}人</td></tr>` : ""}
        <tr><th>職長</th><td>${s.foremen}人</td></tr><tr><th>業者</th><td>${s.vendors}社</td></tr>
        ${s.supervisors ? `<tr><th>現場監督</th><td>${s.supervisors}人</td></tr>` : ""}
        <tr><th>累計</th><td>${s.cumulative.toLocaleString()}人</td></tr>
        <tr><th>延べ労働時間</th><td>${s.laborHoursCumulative.toLocaleString()}時間</td></tr>
      </table></div>`;

  const works = model.works.length
    ? `<table class="works"><thead><tr><th>業者</th><th>職種</th><th>予定/実績</th><th>作業時間</th><th>作業内容</th><th>職長</th><th>備考</th></tr></thead><tbody>${model.works
        .map((w) => `<tr><td>${esc(w.vendor)}</td><td>${esc(w.occupation)}</td><td class="c">${w.planned ?? ""} / ${w.actual ?? ""}</td><td>${esc(w.hours)}</td><td>${br(w.content)}</td><td>${esc(w.foreman)}</td><td>${esc([w.notes, w.machinery ? "機械：" + w.machinery : ""].filter(Boolean).join("／"))}</td></tr>`)
        .join("")}</tbody></table>`
    : "";

  const st = model.status;
  const statusBox = `<table class="kv">
      <tr><th>提出予定</th><td>${st.scheduled ?? "-"}</td></tr>
      <tr><th>未提出</th><td>${st.missing ?? "-"}</td></tr>
      <tr><th>未署名</th><td>${st.unsigned}</td></tr>
      <tr><th>未承認</th><td>${st.unconfirmed}</td></tr>
      <tr><th>未印刷</th><td>${st.unprinted}</td></tr>
    </table>`;

  const notesBox = (text, lines) => `${text ? `<div class="filled">${br(text)}</div>` : ""}${ruled(lines)}`;

  const body = `
  <div class="sheet">
    <header class="top">
      <div class="title">今日の現場シート</div>
      <div class="site">${esc(h.siteName)}${h.constructionNumber ? `<span class="no">工事番号 ${esc(h.constructionNumber)}</span>` : ""}</div>
      <div class="date">${esc(dateText)}${diary ? `<span class="wx">${esc(diary.weather)}${diary.temperature ? `　${esc(diary.temperature)}` : ""}</span>` : ""}</div>
      <div class="meta">${[h.startDate || h.endDate ? `工期 ${esc(h.startDate || "未定")}〜${esc(h.endDate || "未定")}` : "", progress, h.remainingDays != null ? `残り ${h.remainingDays}日` : "", h.dayNumber != null ? `${h.dayNumber}日目` : ""].filter(Boolean).join("　｜　")}</div>
    </header>
    <main class="mid">
      <section class="box flowbox"><h2>本日の現場の流れ</h2><div class="content">${flow}${flowFill}</div></section>
      <div class="right">
        <section class="box"><h2>本日の搬入</h2><div class="content">${deliveries}</div></section>
        <section class="box staffbox"><h2>本日の人員</h2><div class="content">${staff}</div></section>
      </div>
    </main>
    ${works ? `<section class="box worksbox"><h2>本日の作業</h2><div class="content">${works}</div></section>` : ""}
    <footer class="bottom">
      <section class="box"><h2>日誌状況（${esc(`${m}/${d}`)}まで）</h2><div class="content">${statusBox}</div></section>
      <section class="box"><h2>申し送り</h2><div class="content">${notesBox(diary?.remarks, 5)}</div></section>
      <section class="box"><h2>明日の予定</h2><div class="content">${notesBox(diary?.tomorrowPlan, 5)}</div></section>
      <section class="box"><h2>現場メモ</h2><div class="content">${ruled(6)}</div></section>
    </footer>
  </div>`;

  // 各欄の中身が溢れる場合だけ、その欄の文字を小さくして1枚に収める
  const fitScript = `<script>(function(){function fit(){document.querySelectorAll(".box .content").forEach(function(c){var size=10.5;c.style.fontSize=size+"pt";while(c.scrollHeight>c.clientHeight+1&&size>6){size-=0.5;c.style.fontSize=size+"pt";}});}fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();</script>`;

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>今日の現場シート ${esc(h.siteName)} ${esc(h.date)}</title>
<style>
  @page { size: A3 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 404mm; height: 281mm; margin: 0 auto; display: flex; flex-direction: column; gap: 3mm; overflow: hidden; }
  .top { display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto; column-gap: 8mm; align-items: baseline; border-bottom: 1.2mm solid #2b6cb0; padding-bottom: 2mm; }
  .title { font-size: 18pt; font-weight: bold; color: #2b6cb0; }
  .site { font-size: 18pt; font-weight: bold; }
  .site .no { font-size: 11pt; font-weight: normal; margin-left: 6mm; color: #444; }
  .date { font-size: 15pt; font-weight: bold; text-align: right; }
  .date .wx { font-size: 12pt; font-weight: normal; margin-left: 5mm; }
  .meta { grid-column: 1 / -1; font-size: 10.5pt; color: #333; }
  .mid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 58% 1fr; gap: 3mm; }
  .right { display: grid; grid-template-rows: 1fr auto; gap: 3mm; min-height: 0; }
  .box { border: 0.4mm solid #555; border-radius: 1.5mm; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .box h2 { margin: 0; font-size: 11pt; background: #e8eef7; border-bottom: 0.3mm solid #555; padding: 1mm 3mm; }
  .box .content { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 2mm 3mm; font-size: 10.5pt; }
  .flow { width: 100%; border-collapse: collapse; }
  .flow td { border-bottom: 0.2mm dashed #aaa; padding: 1.2mm 1mm; vertical-align: top; }
  .flow .t { width: 16mm; font-weight: bold; white-space: nowrap; }
  .flow .mk { width: 6mm; text-align: center; color: #2b6cb0; }
  .flow .dlv .mk { color: #b7791f; }
  .flow .ti { font-size: 1.1em; }
  .flow .nt { font-size: 0.85em; color: #444; }
  .flow .st { width: 16mm; text-align: right; color: #555; white-space: nowrap; }
  .cancelled { text-decoration: line-through; color: #888; }
  .dlv-item { border-bottom: 0.2mm dashed #aaa; padding: 1mm 0; }
  .dlv-head .badge { margin-left: 3mm; border: 0.2mm solid #777; border-radius: 1mm; padding: 0 1.5mm; font-size: 0.85em; }
  .dlv-body, .dlv-note { font-size: 0.9em; color: #333; }
  .staff { display: flex; gap: 6mm; align-items: center; }
  .staff .big { font-size: 30pt; font-weight: bold; line-height: 1; }
  .staff .big small { font-size: 12pt; margin-left: 1mm; }
  .kv { border-collapse: collapse; width: 100%; }
  .kv th { text-align: left; font-weight: normal; color: #444; padding: 0.6mm 2mm 0.6mm 0; white-space: nowrap; }
  .kv td { text-align: right; font-weight: bold; padding: 0.6mm 0; }
  .worksbox { flex: 0 1 auto; max-height: 60mm; }
  .works { width: 100%; border-collapse: collapse; font-size: 0.95em; }
  .works th, .works td { border: 0.2mm solid #999; padding: 0.8mm 1.5mm; vertical-align: top; }
  .works th { background: #f2f2f2; font-weight: normal; white-space: nowrap; }
  .works .c { text-align: center; white-space: nowrap; }
  .bottom { flex: 0 0 62mm; display: grid; grid-template-columns: 1fr 1.4fr 1.4fr 1.4fr; gap: 3mm; }
  .filled { margin-bottom: 1mm; }
  .ruled div { border-bottom: 0.2mm solid #bbb; height: 7.5mm; }
  .empty { color: #777; margin: 0 0 2mm; }
  @media screen { body { background: #eee; padding: 8mm 0; } .sheet { background: #fff; box-shadow: 0 0 4mm rgba(0,0,0,.2); padding: 0; } }
</style></head>
<body>${body}${fitScript}</body></html>`;
}
