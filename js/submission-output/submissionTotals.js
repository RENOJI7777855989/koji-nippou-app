/* ==========================================================
   提出内訳の小計・合計の計算（唯一の計算元、純粋関数）
   Excel出力・確認プレビュー・テストは、すべてここが返す値を参照する。
   積算側（estimateItems.amount）には計算処理が無い（取込値そのもの）ため、
   金額の出典は各項目のamountだけとし、数量×単価の再計算はしない。
   金額が数値でない項目は0円扱いにせず、呼び出し側へ「金額未確認」として
   返す（missingAmountItemIds）。
   ========================================================== */

function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

function amountOf(item, missing) {
  if (Number.isFinite(item.amount)) return item.amount;
  // 数値が全く無い行（摘要のみの注記行）は金額を持たないのが正常なので「未確認」にしない
  if (!item.noteOnly) missing.add(item.itemId);
  return 0;
}

/**
 * 階層ツリー（submissionModel.jsが組み立てる groups）へ小計を書き込み、
 * 表紙の合計（直接工事費・共通仮設費・純工事費・現場管理費・工事原価）を返す。
 *   group.entries[i] は { type: "workType", directItems, subTypes } か { type: "leaf", item }
 */
export function computeSubmissionTotals(groups) {
  const missing = new Set();

  for (const group of groups) {
    for (const entry of group.entries) {
      if (entry.type === "leaf") {
        entry.total = amountOf(entry.item, missing);
      } else {
        for (const sub of entry.subTypes) {
          sub.total = sum(sub.items.map((item) => amountOf(item, missing)));
        }
        const direct = sum(entry.directItems.map((item) => amountOf(item, missing)));
        entry.total = direct + sum(entry.subTypes.map((sub) => sub.total));
      }
    }
    group.total = sum(group.entries.map((entry) => entry.total));
  }

  const byKind = (kinds) => sum(groups.filter((g) => kinds.includes(g.kind)).map((g) => g.total));
  const directTotal = byKind(["building"]);
  const commonTotal = byKind(["common_temp_itemized", "common_temp_general"]);
  const netTotal = directTotal + commonTotal;
  const managementTotal = byKind(["site_management"]);
  const costTotal = netTotal + managementTotal;

  return {
    directTotal,
    commonTotal,
    netTotal,
    managementTotal,
    costTotal,
    missingAmountItemIds: [...missing]
  };
}
