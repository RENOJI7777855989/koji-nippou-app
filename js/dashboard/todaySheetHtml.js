/* ==========================================================
   現場掲示 A3横「今日の現場シート」の印刷用HTML（DOM・DB非依存）
   画面の「現場掲示」タブと同じ内容・同じ欄名（js/dashboard/boardContent.js の buildBoardContent・
   BOARD_SECTIONS）から作る。データは画面と同じ buildDashboardModel の結果（同じ現場・日付・日報・KY）。
   会社指定の03-2とは別の帳票で、03-2の仕組み・様式には一切触れない。

   ・並び: 上段＝本日の作業・業者別 稼働状況（業者・工種・稼働人数・人工・作業時間・作業内容・職長・安全注意事項）、
     中段＝本日の現場の流れ｜本日の搬入・搬出／本日の巡回点検｜（本日の重点指示・本日の危険予知活動表・本日の人員）、
     下段＝作業間の連絡・調整｜連絡事項｜明日の予定｜現場メモ（日誌の内容のあとは手書き用の罫線）
   ・用紙はA3横（@page）。1枚に収まるよう、各欄の文字が溢れる場合だけ表示時・印刷前に文字を小さくする
     （最小6pt。情報が少ない日は小さくしない）。本日の作業が収まらない日はその欄の高さを広げて詰め直す
   ・載せないもの: 今日の確認事項・日誌状況など監督向けの情報、請求人工、見積の情報、操作ボタン
   ・ヘッダーの右端に現場掲示レイアウトの版を小さく出す（画面の現場掲示タブと同じ版か見分けるため）
   ========================================================== */

import { buildBoardContent, sectionTitle } from "./boardContent.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const br = (v) => esc(v).replace(/\n/g, "<br>");

const ruled = (count) => `<div class="ruled">${"<div></div>".repeat(count)}</div>`;

export function buildTodaySheetHtml(model) {
  const b = buildBoardContent(model);
  const h = b.header;
  const [y, m, d] = h.date.split("-").map(Number);
  const dateText = `${y}年${m}月${d}日（${h.weekday}）`;
  const box = (key, content, cls = "") => `<section class="box${cls ? " " + cls : ""}" data-section="${key}"><h2>${esc(sectionTitle(key))}</h2><div class="content">${content}</div></section>`;

  // 本日の作業・業者別 稼働状況（人工は稼働人数を1人＝1人工。請求人工は載せない）
  const works = b.works.length
    ? `<table class="works"><thead><tr><th>業者</th><th>工種</th><th>稼働人数<br><small>予定/実績</small></th><th>人工</th><th>作業時間</th><th>作業内容</th><th>職長</th><th>安全注意事項・使用機械</th></tr></thead><tbody>${b.works
        .map((w) => `<tr><td>${esc(w.vendor)}</td><td>${esc(w.trade)}</td><td class="c">${w.planned ?? ""} / <b>${w.actual ?? ""}</b></td><td class="c">${w.manDays ?? ""}</td><td>${esc(w.hours)}</td><td>${br(w.content)}</td><td>${esc(w.foreman)}</td><td>${br([w.notes, w.machinery ? "機械：" + w.machinery : ""].filter(Boolean).join("\n"))}</td></tr>`)
        .join("")}</tbody><tfoot><tr><th colspan="2">合計（${b.works.length}社）</th><td class="c"><b>${b.totals.workers}</b>人</td><td class="c">${b.totals.manDays}</td><td colspan="4"></td></tr></tfoot></table>`
    : `<p class="empty">${esc(b.dayStateLabel || "本日の作業（日誌の業者欄）は未入力")}</p>`;

  // 流れが多い日は2列に分けて並べる（左列→右列の順に時刻順）。搬入・搬出の詳細は右の表にあるので流れでは1行
  const flowRow = (f) => `<tr class="${f.kind === "delivery" ? `dlv${f.direction === "out" ? " out" : ""}` : ""}${f.cancelled ? " cancelled" : ""}"><td class="t">${esc(f.time || "")}</td><td class="mk">${f.mark}</td><td class="ti">${f.kind !== "delivery" && f.flowKind !== "work" && f.kindLabel && f.title !== f.kindLabel ? `<span class="kd">${esc(f.kindLabel)}</span>` : ""}${esc(f.title)}${f.note && f.kind !== "delivery" ? `<div class="nt">${esc(f.note)}</div>` : ""}</td><td class="st">${esc(f.status || "")}</td></tr>`;
  const FLOW_TWO_COLUMNS_FROM = 18;
  const flowTable = (rows) => `<table class="flow">${rows.map(flowRow).join("")}</table>`;
  const flow = !b.flow.length
    ? `<p class="empty">本日の現場の流れ（日誌に未入力）</p>`
    : b.flow.length >= FLOW_TWO_COLUMNS_FROM
      ? `<div class="flow-cols">${flowTable(b.flow.slice(0, Math.ceil(b.flow.length / 2)))}${flowTable(b.flow.slice(Math.ceil(b.flow.length / 2)))}</div>`
      : flowTable(b.flow);
  const flowFill = b.flow.length < 6 ? ruled(6 - b.flow.length) : "";

  // 本日の搬入・搬出（時刻順。区分は ◆搬入／◇搬出）
  const deliveries = b.deliveries.length
    ? `<table class="dlv"><colgroup><col class="c-t"><col class="c-dir"><col class="c-item"><col class="c-q"><col class="c-v"><col class="c-o"><col class="c-d"><col class="c-car"><col class="c-st"><col></colgroup>
        <thead><tr><th>時刻</th><th>区分</th><th>品名</th><th>数量</th><th>業者</th><th>元</th><th>先</th><th>車両</th><th>状況</th><th>備考</th></tr></thead><tbody>${b.deliveries
        .map((dl) => `<tr class="${dl.direction === "out" ? "out" : "in"}${dl.status === "cancelled" ? " cancelled" : ""}"><td class="t">${esc(dl.time || "")}</td><td class="dir">${dl.mark}${esc(dl.directionLabel)}</td><td>${esc(dl.item)}</td><td>${esc(dl.quantity)}</td><td>${esc(dl.vendor)}</td><td>${esc(dl.origin)}</td><td>${esc(dl.destination)}</td><td>${esc(dl.vehicle)}</td><td class="st">${esc(dl.statusLabel)}</td><td>${br(dl.note)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">本日の搬入・搬出なし</p>`;

  // 本日の危険予知活動表（紙のKY活動表が提出されたか）。提出時刻は載せない
  const ky = b.ky;
  const kyHtml = ky.rows.length
    ? `<div class="ky">${ky.rows.map((r) => `<span class="ky-${r.state}">${esc(r.vendorName)} ${esc(r.label)}</span>`).join("")}</div><div class="ky-sum">対象 ${ky.targetCount}　提出済み ${ky.submittedCount}　未提出 ${ky.notSubmittedCount}${ky.excludedCount ? `　対象外 ${ky.excludedCount}` : ""}（業者）</div>`
    : `<p class="empty">（対象業者の登録なし）</p>`;

  // 本日の巡回点検（状況・件数・×の項目・是正指示。休工日等で記録が無い日は「未実施（…）」、日報が無い日は「記録なし」）
  const pt = b.patrol;
  const patrolHtml = `<div class="pt-state pt-${pt.state}">巡回点検：<b>${esc(pt.label)}</b></div>${pt.counts ? `<div class="pt-counts">良好○ ${pt.counts.good}　不良× ${pt.counts.bad}　該当なし－ ${pt.counts.na}${pt.counts.unset ? `　未記入 ${pt.counts.unset}` : ""}</div>` : ""}${pt.badItems.length || pt.comment ? `<div class="pt-attn"><b>巡回点検・要確認</b>${pt.badItems.length ? `<div>${pt.badItems.map((i) => `<span class="pt-bad">× ${esc(i)}</span>`).join("")}</div>` : ""}${pt.comment ? `<div>是正指示：${br(pt.comment)}</div>` : ""}</div>` : ""}`;

  const s = b.staff;
  const staff = `<div class="staff">
      <div class="big">${s.today}<small>人</small></div>
      <table class="kv">
        ${s.plannedToday ? `<tr><th>予定</th><td>${s.plannedToday}人</td></tr>` : ""}
        <tr><th>職長</th><td>${s.foremen}人</td></tr><tr><th>業者</th><td>${s.vendors}社</td></tr>
        ${s.supervisors ? `<tr><th>現場監督</th><td>${s.supervisors}人</td></tr>` : ""}
        <tr><th>累計</th><td>${s.cumulative.toLocaleString()}人</td></tr>
        <tr><th>延べ労働時間</th><td>${s.laborHoursCumulative.toLocaleString()}時間</td></tr>
      </table></div>`;

  // 日誌の内容のあとに手書き用の罫線。内容が多い日は、その行数だけ罫線を減らす（欄からあふれないように）
  const notesBox = (text, lines) => `${text ? `<div class="filled">${br(text)}</div>` : ""}${ruled(Math.max(0, lines - (text ? String(text).split("\n").length : 0)))}`;
  const meta = [h.startDate || h.endDate ? `工期 ${esc(h.startDate || "未定")}〜${esc(h.endDate || "未定")}` : "", esc(h.progressText), esc(h.elapsedText), h.remainingDays != null ? `残り ${h.remainingDays}日` : "", h.dayNumber != null ? `${h.dayNumber}日目` : ""].filter(Boolean).join("　｜　");

  const body = `
  <div class="sheet">
    <header class="top">
      <div class="title">現場掲示　今日の現場シート</div>
      <div class="site">${esc(h.siteName)}${h.constructionNumber ? `<span class="no">工事番号 ${esc(h.constructionNumber)}</span>` : ""}</div>
      <div class="date">${esc(dateText)}${h.weather || h.temperature ? `<span class="wx">${esc(h.weather)}${h.temperature ? `　${esc(h.temperature)}` : ""}</span>` : ""}</div>
      <div class="meta">${meta}${b.dayStateLabel ? `　<b class="daystate">${esc(b.dayStateLabel)}</b>` : ""}<span class="ver">現場掲示レイアウト ${esc(b.version)}版</span></div>
    </header>
    ${box("works", works, "worksbox")}
    <main class="mid">
      ${box("flow", `${flow}${flowFill}`, "flowbox")}
      <div class="midcol">
        ${box("deliveries", deliveries)}
        ${box("patrol", patrolHtml, "patrolbox")}
      </div>
      <div class="side">
        ${box("focus", notesBox(b.focus, 3), "focusbox")}
        ${box("ky", kyHtml, "kybox")}
        ${box("staff", staff, "staffbox")}
      </div>
    </main>
    <footer class="bottom">
      ${box("coordination", notesBox(b.coordination, 4))}
      ${box("notice", notesBox(b.notice, 4))}
      ${box("tomorrow", notesBox(b.tomorrow, 4))}
      <section class="box" data-section="memo"><h2>現場メモ</h2><div class="content">${ruled(5)}</div></section>
    </footer>
  </div>`;

  // 各欄の中身が溢れる場合だけ、その欄の文字を小さくして1枚に収める（最小6pt）。
  // 本日の作業（業者の表）が最小の文字でも収まらない日は、その欄の高さを少しずつ広げて中段を詰め直す
  const fitScript = `<script>(function(){
    function over(c){return c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1;}
    function fitBox(c){var size=10.5;c.style.fontSize=size+"pt";while(over(c)&&size>6){size-=0.5;c.style.fontSize=size+"pt";}return !over(c);}
    function fitAll(){document.querySelectorAll(".box .content").forEach(fitBox);}
    function fit(){
      var works=document.querySelector(".worksbox");
      var heights=[80,95,110,125];
      if(works){works.style.maxHeight="";works.style.flex="";}
      fitAll();
      for(var i=0;works&&over(works.querySelector(".content"))&&i<heights.length;i++){
        works.style.maxHeight="none";works.style.flex="0 0 "+heights[i]+"mm";
        fitAll();
      }
    }
    fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();</script>`;

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>現場掲示 ${esc(h.siteName)} ${esc(h.date)}</title>
<style>
  @page { size: A3 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 404mm; height: 281mm; margin: 0 auto; display: flex; flex-direction: column; gap: 2.5mm; overflow: hidden; position: relative; }
  .top { display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto; column-gap: 8mm; align-items: baseline; border-bottom: 1.2mm solid #2b6cb0; padding-bottom: 1.5mm; }
  .title { font-size: 16pt; font-weight: bold; color: #2b6cb0; }
  .site { font-size: 18pt; font-weight: bold; }
  .site .no { font-size: 11pt; font-weight: normal; margin-left: 6mm; color: #444; }
  .date { font-size: 15pt; font-weight: bold; text-align: right; }
  .date .wx { font-size: 12pt; font-weight: normal; margin-left: 5mm; }
  .meta { grid-column: 1 / -1; font-size: 10.5pt; color: #333; }
  .meta .daystate { color: #553c9a; }
  .box { border: 0.4mm solid #555; border-radius: 1.5mm; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .box h2 { margin: 0; font-size: 11pt; background: #e8eef7; border-bottom: 0.3mm solid #555; padding: 0.8mm 3mm; }
  .box .content { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 1.5mm 3mm; font-size: 10.5pt; line-height: 1.3; }
  .worksbox { flex: 0 1 auto; max-height: 72mm; }
  .works { width: 100%; border-collapse: collapse; font-size: 0.95em; }
  .works th, .works td { border: 0.2mm solid #999; padding: 0.2em 0.5em; vertical-align: top; overflow-wrap: anywhere; }
  .works th { background: #f2f2f2; font-weight: normal; white-space: nowrap; }
  .works th small { font-size: 0.8em; }
  .works tfoot th, .works tfoot td { background: #f7f7f7; }
  .works .c { text-align: center; white-space: nowrap; }
  .mid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 30% 1fr 26%; gap: 3mm; }
  .midcol { display: grid; grid-template-rows: minmax(0, 1.5fr) minmax(0, 1fr); gap: 3mm; min-height: 0; }
  .pt-state { font-size: 1.05em; margin-bottom: 1mm; }
  .pt-attention b { color: #b45309; }
  .pt-counts { color: #333; margin-bottom: 1mm; }
  .pt-attn { border: 0.3mm solid #f0b35a; background: #fffaf0; padding: 1mm 2mm; border-radius: 1mm; }
  .pt-attn > b { color: #b45309; }
  .pt-bad { display: inline-block; margin-right: 4mm; color: #b42318; }
  .side { display: grid; grid-template-rows: minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 3mm; min-height: 0; }
  .flow { width: 100%; border-collapse: collapse; }
  .flow td { border-bottom: 0.2mm dashed #aaa; padding: 0.3em 0.3em; vertical-align: top; }
  .flow-cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 3mm; align-items: start; }
  .flow .t { width: 3.6em; font-weight: bold; white-space: nowrap; }
  .flow .mk { width: 6mm; text-align: center; color: #2b6cb0; }
  .flow .dlv .mk { color: #b7791f; }
  .flow .ti { font-size: 1.1em; }
  .flow .nt { font-size: 0.85em; color: #444; }
  .flow .kd { display: inline-block; white-space: nowrap; font-size: 0.8em; border: 0.2mm solid #2b6cb0; color: #2b6cb0; border-radius: 1mm; padding: 0 1mm; margin-right: 1.5mm; }
  .flow .st { width: 3.4em; text-align: right; color: #555; white-space: nowrap; }
  .cancelled { text-decoration: line-through; color: #888; }
  .flow .dlv.out .mk { color: #2c7a7b; }
  table.dlv { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.9em; }
  table.dlv th, table.dlv td { border: 0.2mm solid #999; padding: 0.2em 0.3em; vertical-align: top; overflow-wrap: anywhere; }
  table.dlv th { background: #f2f2f2; font-weight: normal; white-space: nowrap; }
  /* 時刻「08:00」・区分「◆搬入」が枠からはみ出して隣の列に重ならない幅（印刷で文字が太字・やや大きくなっても1行で収まる）。
     広げた分は備考の列（残りの幅）が狭くなるだけで、品名・業者・元・先の幅は変えない（情報の多い日に行が増えないように） */
  table.dlv .c-t { width: 12mm; } table.dlv .c-dir { width: 12.5mm; } table.dlv .c-item { width: 20mm; } table.dlv .c-q { width: 12mm; }
  table.dlv .c-v { width: 20mm; } table.dlv .c-o, table.dlv .c-d { width: 17mm; } table.dlv .c-car { width: 12mm; } table.dlv .c-st { width: 11mm; }
  table.dlv td.t { font-weight: bold; white-space: nowrap; padding-left: 0.15em; padding-right: 0.15em; }
  table.dlv td.dir { white-space: nowrap; color: #8a5a12; font-weight: bold; padding-left: 0.15em; padding-right: 0.15em; }
  table.dlv tr.out td.dir { color: #22605f; }
  .staff { display: flex; gap: 5mm; align-items: center; }
  .staff .big { font-size: 26pt; font-weight: bold; line-height: 1; }
  .staff .big small { font-size: 12pt; margin-left: 1mm; }
  .kv { border-collapse: collapse; width: 100%; }
  .kv th { text-align: left; font-weight: normal; color: #444; padding: 0.1em 0.6em 0.1em 0; white-space: nowrap; }
  .kv td { text-align: right; font-weight: bold; padding: 0.1em 0; }
  .ky { display: flex; flex-wrap: wrap; gap: 1mm 5mm; }
  .ky span { white-space: nowrap; }
  .ky .ky-not_submitted { color: #b42318; font-weight: bold; }
  .ky .ky-excluded { color: #888; }
  .ky-sum { margin-top: 1mm; font-size: 0.9em; color: #444; }
  .bottom { flex: 0 0 46mm; display: grid; grid-template-columns: 1.3fr 1.3fr 1.3fr 1fr; gap: 3mm; }
  .filled { margin-bottom: 1mm; }
  .ruled div { border-bottom: 0.2mm solid #bbb; height: 7mm; }
  .empty { color: #777; margin: 0 0 2mm; }
  .meta .ver { float: right; font-size: 7.5pt; color: #999; }
  @media screen { body { background: #eee; padding: 8mm 0; } .sheet { background: #fff; box-shadow: 0 0 4mm rgba(0,0,0,.2); padding: 0; } }
</style></head>
<body>${body}${fitScript}</body></html>`;
}
