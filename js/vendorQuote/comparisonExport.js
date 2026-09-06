/* ==========================================================
   積算チェック結果（見積落とし候補＋比較結果）のExcel(CSV)・
   PDF(印刷用HTML)出力
   既存のjs/report-output/配下（cellGrid.js・pdfDefault.js）と同じ
   技法（CSVベースのExcel出力・印刷用HTML文字列を組み立てブラウザの
   印刷機能でPDF化）を用いるが、既存ファイルは一切変更せずこの
   新規ファイルに実装する。比較結果は元請への提出様式ではなく
   現場監督の確認・業者との打合せ用のため、シンプルなCSV/印刷HTML
   で十分と判断している。
   omission（js/vendorQuote/omissionCheck.jsの戻り値）を渡すと、
   見積落とし候補・逆方向チェックのセクションを先頭に追加する。
   ========================================================== */

import { gridToCsv } from "../report-output/cellGrid.js";
import { escapeHtml } from "../utils.js";

const TYPE_LABEL = {
  match: "一致",
  diff: "数量・単価・金額差",
  needs_review: "要確認",
  estimate_only: "見積漏れの可能性",
  vendor_only: "積算漏れの可能性",
  duplicate_possible: "重複の可能性"
};

const RISK_ORDER_LABEL = { high: "高", medium: "中", low: "低", needs_review: "要確認" };

function fmt(n) {
  return n == null ? "" : n.toLocaleString("ja-JP");
}

function fmtPct(n) {
  return n == null ? "" : `${n.toFixed(1)}%`;
}

function rowValues(r) {
  const est = r.estimateItem;
  const vq = r.vendorItem;
  return [
    TYPE_LABEL[r.type] || r.type,
    est?._masterItemCode || vq?._masterItemCode || "",
    est?.category || vq?.category || "",
    est?.itemName || vq?.itemName || "",
    est?.spec || vq?.spec || "",
    est?.quantity ?? "",
    vq?.quantity ?? "",
    r.quantityDiffPct != null ? `${r.quantityDiffPct.toFixed(1)}%` : "",
    est?.unitPrice ?? "",
    vq?.unitPrice ?? "",
    r.unitPriceDiffPct != null ? `${r.unitPriceDiffPct.toFixed(1)}%` : "",
    est?.amount ?? "",
    vq?.amount ?? "",
    r.amountDiffPct != null ? `${r.amountDiffPct.toFixed(1)}%` : "",
    r.note || ""
  ];
}

const HEADER = [
  "判定", "共通項目コード", "工種", "項目", "仕様",
  "積算数量", "見積数量", "数量差率",
  "積算単価", "見積単価", "単価差率",
  "積算金額", "見積金額", "金額差率",
  "備考"
];

const OMISSION_HEADER = ["リスク", "共通項目コード", "工種", "項目", "仕様", "数量", "単位", "積算金額(参考)", "判定理由", "確認結果"];
const REVERSE_HEADER = ["共通項目コード", "工種", "項目", "仕様", "数量", "単位", "金額", "備考", "確認結果"];

function omissionCandidateRowValues(c) {
  const item = c.item;
  return [
    c.confirmed ? "高（確定）" : RISK_ORDER_LABEL[c.risk] || c.risk,
    item._masterItemCode || "",
    item.category || "", item.itemName || "", item.spec || "",
    item.quantity ?? "", item.unit || "", c.referenceAmount ?? "",
    c.reason || "", c.dispositionLabel || "（未確認）"
  ];
}

function reverseCandidateRowValues(c) {
  const item = c.item;
  return [item._masterItemCode || "", item.category || "", item.itemName || "", item.spec || "", item.quantity ?? "", item.unit || "", item.amount ?? "", c.reason || "", c.dispositionLabel || "（未確認）"];
}

/**
 * 比較結果（＋見積落とし候補）をCSV（Excelで開ける形式）として書き出す。
 * @param {object} [omission] js/vendorQuote/omissionCheck.jsのcheckOmissions()戻り値（任意）
 * @returns {{ blob: Blob, filename: string }}
 */
export function exportComparisonCsv({ site, vendorBatch, results, omission }) {
  const grid = [];
  if (omission) {
    grid.push(["【見積落とし候補】（積算資料を基準に、業者見積に含まれているか確認が必要な項目）"]);
    grid.push(OMISSION_HEADER);
    grid.push(...omission.candidates.map(omissionCandidateRowValues));
    grid.push([]);
    grid.push(["【逆方向チェック】（業者見積にあるが積算に無い項目）"]);
    grid.push(REVERSE_HEADER);
    grid.push(...omission.reverseCandidates.map(reverseCandidateRowValues));
    grid.push([]);
    grid.push(["【全比較結果】"]);
  }
  grid.push(HEADER, ...results.map(rowValues));

  const csv = gridToCsv(grid);
  const bom = "﻿"; // Excelで文字化けしないようUTF-8 BOMを付与
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
  const filename = `${site?.name || "現場"}_${vendorBatch?.vendorName || "業者"}_${omission ? "積算チェック結果" : "見積比較"}.csv`;
  return { blob, filename };
}

function resultRowHtml(r) {
  const est = r.estimateItem;
  const vq = r.vendorItem;
  const typeClass = `type-${r.type.replace(/_/g, "-")}`;
  return `<tr class="${typeClass}">
    <td><span class="badge ${typeClass}">${escapeHtml(TYPE_LABEL[r.type] || r.type)}</span></td>
    <td>${escapeHtml(est?._masterItemCode || vq?._masterItemCode || "")}</td>
    <td>${escapeHtml(est?.category || vq?.category || "")}</td>
    <td>${escapeHtml(est?.itemName || vq?.itemName || "")}</td>
    <td>${escapeHtml(est?.spec || vq?.spec || "")}</td>
    <td class="num">${fmt(est?.quantity)}</td>
    <td class="num">${fmt(vq?.quantity)}</td>
    <td class="num">${fmtPct(r.quantityDiffPct)}</td>
    <td class="num">${fmt(est?.unitPrice)}</td>
    <td class="num">${fmt(vq?.unitPrice)}</td>
    <td class="num">${fmtPct(r.unitPriceDiffPct)}</td>
    <td class="num">${fmt(est?.amount)}</td>
    <td class="num">${fmt(vq?.amount)}</td>
    <td class="num">${fmtPct(r.amountDiffPct)}</td>
    <td class="note">${escapeHtml(r.note || "")}</td>
  </tr>`;
}

function omissionCandidateRowHtml(c) {
  const item = c.item;
  const riskClass = c.confirmed ? "risk-high" : `risk-${c.risk}`;
  const riskLabel = c.confirmed ? "見積落とし（確定）" : c.riskLabel;
  return `<tr class="${riskClass}">
    <td><span class="badge ${riskClass}">${escapeHtml(riskLabel)}</span></td>
    <td>${escapeHtml(item._masterItemCode || "")}</td>
    <td>${escapeHtml(item.category || "")}</td>
    <td>${escapeHtml(item.itemName || "")}</td>
    <td>${escapeHtml(item.spec || "")}</td>
    <td class="num">${fmt(item.quantity)}${escapeHtml(item.unit || "")}</td>
    <td class="num">${fmt(c.referenceAmount)}</td>
    <td class="note">${escapeHtml(c.reason || "")}</td>
    <td>${escapeHtml(c.dispositionLabel || "未確認")}</td>
  </tr>`;
}

function reverseCandidateRowHtml(c) {
  const item = c.item;
  return `<tr>
    <td>${escapeHtml(item._masterItemCode || "")}</td>
    <td>${escapeHtml(item.category || "")}</td>
    <td>${escapeHtml(item.itemName || "")}</td>
    <td>${escapeHtml(item.spec || "")}</td>
    <td class="num">${fmt(item.quantity)}${escapeHtml(item.unit || "")}</td>
    <td class="num">${fmt(item.amount)}</td>
    <td class="note">${escapeHtml(c.reason || "")}</td>
    <td>${escapeHtml(c.dispositionLabel || "未確認")}</td>
  </tr>`;
}

const OVERALL_STATUS_LABEL = { attention: "🔴 要確認", partial: "🟡 一部要確認", ok: "🟢 問題なし" };

function omissionSectionHtml(omission) {
  const s = omission.summary;
  return `
  <h2>積算チェック結果 - 見積落とし候補</h2>
  <dl class="summary-panel">
    <div class="box"><dt>総合判定</dt><dd>${escapeHtml(OVERALL_STATUS_LABEL[s.overallStatus] || s.overallStatus)}</dd></div>
    <div class="box"><dt>高リスク</dt><dd>${s.counts.high}件</dd></div>
    <div class="box"><dt>中リスク</dt><dd>${s.counts.medium}件</dd></div>
    <div class="box"><dt>低リスク</dt><dd>${s.counts.low}件</dd></div>
    <div class="box"><dt>要確認</dt><dd>${s.counts.needs_review}件</dd></div>
    <div class="box"><dt>見積落とし候補 概算金額(参考)</dt><dd>${fmt(s.referenceAmountTotal)}円</dd></div>
  </dl>
  <table>
    <thead><tr><th>リスク</th><th>コード</th><th>工種</th><th>項目</th><th>仕様</th><th>数量</th><th>積算金額(参考)</th><th>判定理由</th><th>確認結果</th></tr></thead>
    <tbody>${omission.candidates.map(omissionCandidateRowHtml).join("") || `<tr><td colspan="9">見積落とし候補はありません。</td></tr>`}</tbody>
  </table>
  <h2>逆方向チェック（業者見積にあるが積算に無い項目）</h2>
  <table>
    <thead><tr><th>コード</th><th>工種</th><th>項目</th><th>仕様</th><th>数量</th><th>金額</th><th>備考</th><th>確認結果</th></tr></thead>
    <tbody>${omission.reverseCandidates.map(reverseCandidateRowHtml).join("") || `<tr><td colspan="8">該当項目はありません。</td></tr>`}</tbody>
  </table>
  <h2>詳細（全比較結果）</h2>`;
}

/**
 * 比較結果（＋見積落とし候補）を印刷用HTML文書として組み立てる。
 * 業者打合せ・発注前チェックでの確認・印刷/PDF保存を想定し、
 * ブラウザの印刷機能でPDF化する前提。
 * @param {object} [omission] checkOmissions()の戻り値（任意）
 * @returns {{ html: string, filename: string }}
 */
export function buildComparisonPrintHtml({ site, vendorBatch, summary, results, omission }) {
  const rowsHtml = results.map(resultRowHtml).join("");
  const diffAmountLabel = summary.diffAmount >= 0 ? "増" : "減";

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>積算チェック結果</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; margin: 0; padding: 16px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #1a4971; }
  h2 { font-size: 15px; margin: 20px 0 8px; padding-left: 8px; border-left: 5px solid #2b6cb0; }
  .info-panel { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f4f8fc; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; font-size: 12px; }
  .info-panel dt { color: #667; margin: 0; }
  .info-panel dd { font-weight: bold; margin: 2px 0 0; }
  .summary-panel { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 12px; font-size: 12px; }
  .summary-panel .box { border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; }
  .summary-panel .box dt { color: #667; margin: 0; }
  .summary-panel .box dd { font-weight: bold; margin: 2px 0 0; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 4px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  th { background: #eef4fa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.note { max-width: 220px; font-size: 10px; color: #555; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; white-space: nowrap; }
  .type-match .badge, .risk-ok .badge { background: #e3f6e6; color: #1a7a34; }
  .type-diff .badge, .risk-medium .badge { background: #fff1cf; color: #8a5a00; }
  .type-needs-review .badge, .risk-needs_review .badge { background: #eee; color: #555; }
  .type-estimate-only .badge, .type-vendor-only .badge, .risk-high .badge { background: #fde3e3; color: #a02b2b; }
  .type-duplicate-possible .badge { background: #e6e6fa; color: #4b3fa0; }
  .risk-low .badge { background: #fff8e1; color: #8a5a00; }
  p.caution { font-size: 11px; color: #a02b2b; margin: 10px 0 0; }
</style>
</head>
<body>
  <h1>積算チェック結果</h1>
  <dl class="info-panel">
    <div><dt>現場名</dt><dd>${escapeHtml(site?.name || "")}</dd></div>
    <div><dt>業者名</dt><dd>${escapeHtml(vendorBatch?.vendorName || "")}</dd></div>
    <div><dt>見積番号</dt><dd>${escapeHtml(vendorBatch?.quoteNumber) || "-"}</dd></div>
    <div><dt>見積日</dt><dd>${escapeHtml(vendorBatch?.quoteDate) || "-"}</dd></div>
  </dl>
  <dl class="summary-panel">
    <div class="box"><dt>積算総額</dt><dd>${fmt(summary.estimateTotalAmount)}円</dd></div>
    <div class="box"><dt>見積総額</dt><dd>${fmt(summary.vendorTotalAmount)}円</dd></div>
    <div class="box"><dt>差額</dt><dd>${fmt(Math.abs(summary.diffAmount))}円（${diffAmountLabel}）</dd></div>
    <div class="box"><dt>差率</dt><dd>${summary.diffPercent != null ? fmtPct(summary.diffPercent) : "-"}</dd></div>
    <div class="box"><dt>要確認・漏れ可能性</dt><dd>${(summary.counts.needs_review || 0) + (summary.counts.estimate_only || 0) + (summary.counts.vendor_only || 0) + (summary.counts.duplicate_possible || 0)}件</dd></div>
    <div class="box"><dt>一致</dt><dd>${summary.counts.match || 0}件</dd></div>
  </dl>
  ${omission ? omissionSectionHtml(omission) : ""}
  <table>
    <thead>
      <tr>
        <th>判定</th><th>コード</th><th>工種</th><th>項目</th><th>仕様</th>
        <th>積算数量</th><th>見積数量</th><th>数量差率</th>
        <th>積算単価</th><th>見積単価</th><th>単価差率</th>
        <th>積算金額</th><th>見積金額</th><th>金額差率</th>
        <th>備考</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p class="caution">※「見積落とし」「見積漏れ」「積算漏れ」「重複」は、システムによる自動判定（表記ゆれ推定・一式計上のヒューリスティック含む）であり断定ではありません。必ず現場担当者が内容を確認してください。</p>
</body>
</html>`;

  const filename = `${site?.name || "現場"}_${vendorBatch?.vendorName || "業者"}_${omission ? "積算チェック結果" : "見積比較"}.html`;
  return { html, filename };
}
