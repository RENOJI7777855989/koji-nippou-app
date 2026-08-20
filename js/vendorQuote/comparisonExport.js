/* ==========================================================
   比較結果のExcel(CSV)・PDF(印刷用HTML)出力
   既存のjs/report-output/配下（cellGrid.js・pdfDefault.js）と同じ
   技法（CSVベースのExcel出力・印刷用HTML文字列を組み立てブラウザの
   印刷機能でPDF化）を用いるが、既存ファイルは一切変更せずこの
   新規ファイルに実装する。比較結果は元請への提出様式ではなく
   現場監督の確認・業者との打合せ用のため、シンプルなCSV/印刷HTML
   で十分と判断している。
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
  "判定", "工種", "項目", "仕様",
  "積算数量", "見積数量", "数量差率",
  "積算単価", "見積単価", "単価差率",
  "積算金額", "見積金額", "金額差率",
  "備考"
];

/**
 * 比較結果をCSV（Excelで開ける形式）として書き出す。
 * @returns {{ blob: Blob, filename: string }}
 */
export function exportComparisonCsv({ site, vendorBatch, results }) {
  const grid = [HEADER, ...results.map(rowValues)];
  const csv = gridToCsv(grid);
  const bom = "﻿"; // Excelで文字化けしないようUTF-8 BOMを付与
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
  const filename = `${site?.name || "現場"}_${vendorBatch?.vendorName || "業者"}_見積比較.csv`;
  return { blob, filename };
}

function resultRowHtml(r) {
  const est = r.estimateItem;
  const vq = r.vendorItem;
  const typeClass = `type-${r.type.replace(/_/g, "-")}`;
  return `<tr class="${typeClass}">
    <td><span class="badge ${typeClass}">${escapeHtml(TYPE_LABEL[r.type] || r.type)}</span></td>
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

/**
 * 比較結果を印刷用HTML文書として組み立てる。業者打合せの場での
 * 確認・印刷/PDF保存を想定し、ブラウザの印刷機能でPDF化する前提。
 * @returns {{ html: string, filename: string }}
 */
export function buildComparisonPrintHtml({ site, vendorBatch, summary, results }) {
  const rowsHtml = results.map(resultRowHtml).join("");
  const diffAmountLabel = summary.diffAmount >= 0 ? "増" : "減";

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>見積・積算比較</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; margin: 0; padding: 16px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #1a4971; }
  .info-panel { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f4f8fc; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; font-size: 12px; }
  .info-panel dt { color: #667; margin: 0; }
  .info-panel dd { font-weight: bold; margin: 2px 0 0; }
  .summary-panel { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 12px; font-size: 12px; }
  .summary-panel .box { border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; }
  .summary-panel .box dt { color: #667; margin: 0; }
  .summary-panel .box dd { font-weight: bold; margin: 2px 0 0; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  th { background: #eef4fa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.note { max-width: 220px; font-size: 10px; color: #555; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; white-space: nowrap; }
  .type-match .badge { background: #e3f6e6; color: #1a7a34; }
  .type-diff .badge { background: #fff1cf; color: #8a5a00; }
  .type-needs-review .badge { background: #eee; color: #555; }
  .type-estimate-only .badge, .type-vendor-only .badge { background: #fde3e3; color: #a02b2b; }
  .type-duplicate-possible .badge { background: #e6e6fa; color: #4b3fa0; }
  p.caution { font-size: 11px; color: #a02b2b; margin: 10px 0 0; }
</style>
</head>
<body>
  <h1>見積・積算比較結果</h1>
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
  <table>
    <thead>
      <tr>
        <th>判定</th><th>工種</th><th>項目</th><th>仕様</th>
        <th>積算数量</th><th>見積数量</th><th>数量差率</th>
        <th>積算単価</th><th>見積単価</th><th>単価差率</th>
        <th>積算金額</th><th>見積金額</th><th>金額差率</th>
        <th>備考</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p class="caution">※「見積漏れ」「積算漏れ」「重複」は、システムによる自動判定（表記ゆれ推定含む）であり断定ではありません。必ず現場担当者が内容を確認してください。</p>
</body>
</html>`;

  const filename = `${site?.name || "現場"}_${vendorBatch?.vendorName || "業者"}_見積比較.html`;
  return { html, filename };
}
