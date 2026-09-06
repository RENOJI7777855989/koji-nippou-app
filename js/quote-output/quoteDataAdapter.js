/* ==========================================================
   見積書帳票用データモデルへの変換（アダプター層）
   js/report-output/reportDataAdapter.jsと対になる存在。比較結果
   （js/vendorQuote/compareEstimateToQuote.jsの戻り値。呼び出し側で
   計算済みのものを受け取る。ここでは比較・許容差設定・マスター
   解決は一切行わない）から、見積書テンプレートだけが参照する
   中立なデータモデルを組み立てる。テンプレート側はここで定義した
   フィールド名（site.name, items[].itemName 等）だけを参照し、
   内部データ構造を直接参照してはならない（report-output側と同じ方針）。
   ========================================================== */

function mapResultToItem(r) {
  const est = r.estimateItem;
  const vq = r.vendorItem;
  return {
    masterItemCode: est?._masterItemCode || vq?._masterItemCode || "",
    category: est?.category || vq?.category || "",
    itemName: est?.itemName || vq?.itemName || "",
    spec: est?.spec || vq?.spec || "",
    unit: est?.unit || vq?.unit || "",
    estimateQuantity: est?.quantity ?? "",
    estimateUnitPrice: est?.unitPrice ?? "",
    estimateAmount: est?.amount ?? "",
    vendorQuantity: vq?.quantity ?? "",
    vendorUnitPrice: vq?.unitPrice ?? "",
    vendorAmount: vq?.amount ?? "",
    judgement: r.label || ""
  };
}

/**
 * @param {object} site js/sites.jsのレコード
 * @param {object} vendorBatch js/vendorQuote/vendorQuoteBatches.jsのレコード
 * @param {object[]} estimateItems 現場の積算項目全件（総額集計用）
 * @param {object[]} vendorItems 業者見積バッチの全項目（総額集計用）
 * @param {object[]} results compareEstimateToQuote()の戻り値（呼び出し側で計算済み）
 */
export function buildQuoteOutputModel({ site, vendorBatch, estimateItems = [], vendorItems = [], results = [] }) {
  const estimateTotalAmount = estimateItems.reduce((sum, i) => sum + (i.amount || 0), 0);
  const vendorTotalAmount = vendorItems.reduce((sum, i) => sum + (i.amount || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    site: {
      id: site?.id || "",
      name: site?.name || "",
      clientName: site?.clientName || ""
    },
    vendorBatch: {
      vendorName: vendorBatch?.vendorName || "",
      quoteNumber: vendorBatch?.quoteNumber || "",
      quoteDate: vendorBatch?.quoteDate || ""
    },
    items: results.map(mapResultToItem),
    summary: {
      estimateTotalAmount,
      vendorTotalAmount,
      diffAmount: vendorTotalAmount - estimateTotalAmount
    }
  };
}
