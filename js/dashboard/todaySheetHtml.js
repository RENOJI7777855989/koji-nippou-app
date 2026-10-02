/* ==========================================================
   A3横「今日の現場シート」の印刷用HTML（DOM・DB非依存）
   流れは ●作業等・◆搬入・◇搬出、右上は「本日の搬入・搬出」の表（時刻・区分・品名・数量・業者・元・先・車両・状況・備考）
   現場ダッシュボードと同じ表示内容（siteDashboardModel.js）から作る。
   会社指定の03-2とは別の帳票で、03-2の仕組み・様式には一切触れない。

   ・用紙はA3横（@page）。1枚に収まるよう、各欄の文字が溢れる場合だけ
     表示時・印刷前に文字を小さくする（情報が少ない日は小さくしない）
   ・下段の「連絡事項」（日誌の備考）「明日の予定」「現場メモ」は、日誌の内容を載せたうえで
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

  // 流れが多い日は2列に分けて並べる（左列→右列の順に時刻順）。
  // 搬入・搬出の業者・元→先は右の「本日の搬入・搬出」の表に載るので、流れでは1行（時刻・品名・区分）にする
  const flowRow = (f) => `<tr class="${f.kind === "delivery" ? `dlv${f.direction === "out" ? " out" : ""}` : ""}${f.cancelled ? " cancelled" : ""}"><td class="t">${esc(f.time || "")}</td><td class="mk">${f.mark}</td><td class="ti">${f.kind !== "delivery" && f.flowKind !== "work" && f.kindLabel && f.title !== f.kindLabel ? `<span class="kd">${esc(f.kindLabel)}</span>` : ""}${esc(f.title)}${f.note && f.kind !== "delivery" ? `<div class="nt">${esc(f.note)}</div>` : ""}</td><td class="st">${esc(f.status || "")}</td></tr>`;
  const FLOW_TWO_COLUMNS_FROM = 18;
  const flowTable = (rows) => `<table class="flow">${rows.map(flowRow).join("")}</table>`;
  const flow = !model.flow.length
    ? `<p class="empty">本日の現場の流れ（日誌に未入力）</p>`
    : model.flow.length >= FLOW_TWO_COLUMNS_FROM
      ? `<div class="flow-cols">${flowTable(model.flow.slice(0, Math.ceil(model.flow.length / 2)))}${flowTable(model.flow.slice(Math.ceil(model.flow.length / 2)))}</div>`
      : flowTable(model.flow);
  const flowFill = model.flow.length < 8 ? ruled(8 - model.flow.length) : "";

  // 本日の搬入・搬出（時刻順。区分は ◆搬入／◇搬出）
  const deliveries = model.deliveries.length
    ? `<table class="dlv"><colgroup><col class="c-t"><col class="c-dir"><col class="c-item"><col class="c-q"><col class="c-v"><col class="c-o"><col class="c-d"><col class="c-car"><col class="c-st"><col></colgroup>
        <thead><tr><th>時刻</th><th>区分</th><th>品名</th><th>数量</th><th>業者</th><th>元</th><th>先</th><th>車両</th><th>状況</th><th>備考</th></tr></thead><tbody>${model.deliveries
        .map((dl) => `<tr class="${dl.direction === "out" ? "out" : "in"}${dl.status === "cancelled" ? " cancelled" : ""}"><td class="t">${esc(dl.time || "")}</td><td class="dir">${dl.mark}${esc(dl.directionLabel)}</td><td>${esc(dl.item)}</td><td>${esc(dl.quantity)}</td><td>${esc(dl.vendor)}</td><td>${esc(dl.origin)}</td><td>${esc(dl.destination)}</td><td>${esc(dl.vehicle)}</td><td class="st">${esc(dl.statusLabel)}</td><td>${br(dl.note)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">本日の搬入・搬出なし</p>`;

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
    ? `<table class="works"><thead><tr><th>業者</th><th>職種</th><th>予定/実績</th><th>作業時間</th><th>作業内容</th><th>職長</th><th>安全注意事項・使用機械</th></tr></thead><tbody>${model.works
        .map((w) => `<tr><td>${esc(w.vendor)}</td><td>${esc(w.occupation)}</td><td class="c">${w.planned ?? ""} / ${w.actual ?? ""}</td><td>${esc(w.hours)}</td><td>${br(w.content)}</td><td>${esc(w.foreman)}</td><td>${br([w.notes, w.machinery ? "機械：" + w.machinery : ""].filter(Boolean).join("\n"))}</td></tr>`)
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
        <section class="box"><h2>本日の搬入・搬出</h2><div class="content">${deliveries}</div></section>
        <section class="box staffbox"><h2>本日の人員</h2><div class="content">${staff}</div></section>
      </div>
    </main>
    ${works ? `<section class="box worksbox"><h2>本日の作業</h2><div class="content">${works}</div></section>` : ""}
    <footer class="bottom">
      <section class="box"><h2>日誌状況（${esc(`${m}/${d}`)}まで）</h2><div class="content">${statusBox}</div></section>
      <section class="box"><h2>連絡事項</h2><div class="content">${notesBox(diary?.remarks, 5)}</div></section>
      <section class="box"><h2>明日の予定</h2><div class="content">${notesBox(diary?.tomorrowPlan, 5)}</div></section>
      <section class="box"><h2>現場メモ</h2><div class="content">${ruled(6)}</div></section>
    </footer>
  </div>`;

  // 各欄の中身が溢れる場合だけ、その欄の文字を小さくして1枚に収める（最小6pt）。
  // 本日の作業（業者の表）が最小の文字でも収まらない日は、その欄の高さを少しずつ広げて、
  // 中段（流れ・搬入・搬出・人員）を詰め直す
  const fitScript = `<script>(function(){
    function over(c){return c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1;}
    function fitBox(c){var size=10.5;c.style.fontSize=size+"pt";while(over(c)&&size>6){size-=0.5;c.style.fontSize=size+"pt";}return !over(c);}
    function fitAll(){document.querySelectorAll(".box .content").forEach(fitBox);}
    function fit(){
      var works=document.querySelector(".worksbox");
      var heights=[70,80,90,100,110];
      if(works){works.style.maxHeight="";works.style.flex="";}
      fitAll();
      for(var i=0;works&&over(works.querySelector(".content"))&&i<heights.length;i++){
        works.style.maxHeight="none";works.style.flex="0 0 "+heights[i]+"mm";
        fitAll();
      }
    }
    fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();</script>`;

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
  .mid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 50% 1fr; gap: 3mm; }
  .right { display: grid; grid-template-rows: 1fr auto; gap: 3mm; min-height: 0; }
  .box { border: 0.4mm solid #555; border-radius: 1.5mm; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .box h2 { margin: 0; font-size: 11pt; background: #e8eef7; border-bottom: 0.3mm solid #555; padding: 1mm 3mm; }
  .box .content { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 2mm 3mm; font-size: 10.5pt; line-height: 1.3; }
  .flow { width: 100%; border-collapse: collapse; }
  .flow td { border-bottom: 0.2mm dashed #aaa; padding: 0.3em 0.3em; vertical-align: top; }
  .flow-cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 3mm; align-items: start; }
  .flow .t { width: 3.6em; font-weight: bold; white-space: nowrap; }
  .flow .mk { width: 6mm; text-align: center; color: #2b6cb0; }
  .flow .dlv .mk { color: #b7791f; }
  .flow .ti { font-size: 1.1em; }
  .flow .nt, .works .nt { font-size: 0.85em; color: #444; }
  .flow .kd { display: inline-block; font-size: 0.8em; border: 0.2mm solid #2b6cb0; color: #2b6cb0; border-radius: 1mm; padding: 0 1mm; margin-right: 1.5mm; }
  .flow .st { width: 3.4em; text-align: right; color: #555; white-space: nowrap; }
  .cancelled { text-decoration: line-through; color: #888; }
  .flow .dlv.out .mk { color: #2c7a7b; }
  table.dlv { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.9em; }
  table.dlv th, table.dlv td { border: 0.2mm solid #999; padding: 0.2em 0.4em; vertical-align: top; overflow-wrap: anywhere; }
  table.dlv th { background: #f2f2f2; font-weight: normal; white-space: nowrap; }
  table.dlv .c-t { width: 11mm; } table.dlv .c-dir { width: 12mm; } table.dlv .c-item { width: 22mm; } table.dlv .c-q { width: 13mm; }
  table.dlv .c-v { width: 22mm; } table.dlv .c-o, table.dlv .c-d { width: 20mm; } table.dlv .c-car { width: 13mm; } table.dlv .c-st { width: 11mm; }
  table.dlv td.t { font-weight: bold; white-space: nowrap; }
  table.dlv td.dir { white-space: nowrap; color: #8a5a12; font-weight: bold; }
  table.dlv tr.out td.dir { color: #22605f; }
  .staff { display: flex; gap: 6mm; align-items: center; }
  .staff .big { font-size: 30pt; font-weight: bold; line-height: 1; }
  .staff .big small { font-size: 12pt; margin-left: 1mm; }
  .kv { border-collapse: collapse; width: 100%; }
  .kv th { text-align: left; font-weight: normal; color: #444; padding: 0.2em 0.6em 0.2em 0; white-space: nowrap; }
  .kv td { text-align: right; font-weight: bold; padding: 0.2em 0; }
  .worksbox { flex: 0 1 auto; max-height: 60mm; }
  .works { width: 100%; border-collapse: collapse; font-size: 0.95em; }
  .works th, .works td { border: 0.2mm solid #999; padding: 0.25em 0.5em; vertical-align: top; overflow-wrap: anywhere; }
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
