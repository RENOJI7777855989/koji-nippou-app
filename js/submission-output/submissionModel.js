/* ==========================================================
   提出内訳の階層モデル構築（純粋関数、DOM・DB非依存）
   既存の積算項目（estimateItems、フラット構造）と、出力専用の
   区分割当（submissionAssignments）・区分グループ（plan.groups）から、
     区分グループ（号棟等）→ 工種 → 種別 → 明細
   の出力用ツリーを"毎回"組み立てる。積算項目の名称・数量・金額は
   コピーせず、この関数の呼び出し時点の値を参照するだけ（二重管理しない）。
   ========================================================== */

import { computeSubmissionTotals } from "./submissionTotals.js";

export const GROUP_KINDS = {
  building: { label: "号棟（直接工事費）", rank: 0 },
  common_temp_itemized: { label: "共通仮設費（積上）", rank: 1 },
  common_temp_general: { label: "共通仮設費（一般）", rank: 1 },
  site_management: { label: "現場管理費", rank: 2 }
};

const FULLWIDTH_A = 0xff21; // 全角「Ａ」
const MAX_GROUPS = 26;
const MAX_SUBTYPES = 26;

export function isLumpSumItem(item) {
  return (item.unit || "") === "式" || (item.itemName || "").includes("一式") || (item.spec || "").includes("一式");
}

/**
 * 名称・摘要の行分割。LF（\n）＝別の行（複数行に渡る1項目の上段の文字行）、
 * CRLF（\r\n）＝1セル内の折返し改行として分割しない。
 */
export function splitTextLines(text) {
  const lines = String(text ?? "").split(/(?<!\r)\n/);
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function toLineItem(item, note = "") {
  return {
    itemId: item.id,
    name: item.itemName || "",
    spec: item.spec || "",
    quantity: Number.isFinite(item.quantity) ? item.quantity : null,
    unit: item.unit || "",
    unitPrice: Number.isFinite(item.unitPrice) ? item.unitPrice : null,
    amount: Number.isFinite(item.amount) ? item.amount : null,
    note: note || "",
    lumpSum: isLumpSumItem(item),
    // 数量・単位・単価・金額のすべてが空の行は「摘要のみの行（注記）」として出力する
    noteOnly: item.quantity == null && item.unitPrice == null && item.amount == null && !(item.unit || "")
  };
}

function subTypeSymbol(index) {
  return String.fromCharCode(97 + index);
}

/**
 * @param {object} params
 * @param {object[]} params.items 積算項目（listEstimateItemsBySite）
 * @param {object[]} params.assignments 区分割当（{estimateItemId, groupId, workType, subType, order}）
 * @param {object[]} params.groups plan.groups（{id, name, kind, expand}）
 * @param {boolean} [params.allowUnassigned] 未割当の積算項目を除外して出力を許可する
 * @returns {{ groups: object[], totals: object, errors: object[], warnings: object[], stats: object }}
 */
export function buildSubmissionModel({ items = [], assignments = [], groups = [], allowUnassigned = false }) {
  const errors = [];
  const warnings = [];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // 有効な割当（積算項目が存在し、区分グループが存在するもの）を、項目ごとに1件へ
  const assignmentByItem = new Map();
  for (const a of assignments) {
    if (a.isDeleted) continue;
    if (!itemById.has(a.estimateItemId)) {
      warnings.push({ code: "orphan_assignment", message: "割当済みの積算項目が見つからない（削除済み）割当を無視しました。", itemId: a.estimateItemId });
      continue;
    }
    if (!groupById.has(a.groupId)) {
      warnings.push({ code: "orphan_group", message: "存在しない区分グループへの割当を無視しました。", itemId: a.estimateItemId });
      continue;
    }
    assignmentByItem.set(a.estimateItemId, a);
  }

  const unassigned = items.filter((item) => !assignmentByItem.has(item.id));
  if (unassigned.length > 0) {
    (allowUnassigned ? warnings : errors).push({
      code: "unassigned_items",
      message: `区分が未割当の積算項目が${unassigned.length}件あります${allowUnassigned ? "（除外して出力します）" : "。すべて割り当てるか、除外して出力を選んでください"}。`,
      itemIds: unassigned.map((item) => item.id)
    });
  }

  // 区分グループを種別順（号棟→共通仮設→現場管理費）に並べ、項目のあるものだけ記号(Ａ,Ｂ…)を振る
  const itemOrder = new Map(items.map((item, index) => [item.id, index]));
  const usedGroupIds = new Set([...assignmentByItem.values()].map((a) => a.groupId));
  const sortedGroups = groups
    .map((g, index) => ({ g, index }))
    .filter(({ g }) => usedGroupIds.has(g.id))
    .sort((a, b) => (GROUP_KINDS[a.g.kind]?.rank ?? 9) - (GROUP_KINDS[b.g.kind]?.rank ?? 9) || a.index - b.index)
    .map(({ g }) => g);

  if (sortedGroups.length === 0) {
    errors.push({ code: "no_groups", message: "項目が割り当てられた区分グループがありません。" });
  }
  if (sortedGroups.length > MAX_GROUPS) {
    errors.push({ code: "too_many_groups", message: `区分グループが${MAX_GROUPS}件を超えています。` });
  }

  const treeGroups = sortedGroups.slice(0, MAX_GROUPS).map((g, gi) => {
    const groupAssignments = [...assignmentByItem.values()]
      .filter((a) => a.groupId === g.id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || itemOrder.get(a.estimateItemId) - itemOrder.get(b.estimateItemId));

    const entries = [];
    const workTypeByName = new Map();
    for (const a of groupAssignments) {
      const line = toLineItem(itemById.get(a.estimateItemId), a.note);
      const workTypeName = (a.workType || "").trim();
      const subTypeName = (a.subType || "").trim();
      if (!workTypeName) {
        entries.push({ type: "leaf", item: line });
        continue;
      }
      let entry = workTypeByName.get(workTypeName);
      if (!entry) {
        entry = { type: "workType", name: workTypeName, directItems: [], subTypes: [] };
        workTypeByName.set(workTypeName, entry);
        entries.push(entry);
      }
      if (!subTypeName) {
        entry.directItems.push(line);
      } else {
        let sub = entry.subTypes.find((s) => s.name === subTypeName);
        if (!sub) {
          sub = { name: subTypeName, items: [] };
          entry.subTypes.push(sub);
        }
        sub.items.push(line);
      }
    }

    entries.forEach((entry, index) => {
      entry.symbol = String(index + 1);
      if (entry.type !== "workType") return;
      if (entry.directItems.length > 0 && entry.subTypes.length > 0) {
        errors.push({
          code: "mixed_work_type",
          message: `区分「${g.name}」の工種「${entry.name}」に、種別ありの項目と種別なしの項目が混在しています。どちらかに揃えてください。`
        });
      }
      if (entry.subTypes.length > MAX_SUBTYPES) {
        errors.push({ code: "too_many_sub_types", message: `工種「${entry.name}」の種別が${MAX_SUBTYPES}件を超えています。` });
      }
      entry.subTypes.forEach((sub, si) => {
        sub.symbol = subTypeSymbol(si);
      });
    });

    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      expand: g.expand !== false,
      symbol: String.fromCharCode(FULLWIDTH_A + gi),
      entries
    };
  });

  const totals = computeSubmissionTotals(treeGroups);
  if (totals.missingAmountItemIds.length > 0) {
    warnings.push({
      code: "missing_amount",
      message: `金額が未確認（数値でない）の項目が${totals.missingAmountItemIds.length}件あります（0円として集計しています）。`,
      itemIds: totals.missingAmountItemIds
    });
  }

  const lumpSumItems = [];
  for (const group of treeGroups) {
    for (const entry of group.entries) {
      const lines = entry.type === "leaf" ? [entry.item] : [...entry.directItems, ...entry.subTypes.flatMap((s) => s.items)];
      for (const line of lines) if (line.lumpSum) lumpSumItems.push(line.itemId);
    }
  }
  if (lumpSumItems.length > 0) {
    warnings.push({
      code: "lump_sum",
      message: `一式計上の項目が${lumpSumItems.length}件あります（一式計上・要確認）。内容が積算根拠と合っているか確認してください。`,
      itemIds: lumpSumItems
    });
  }

  const noteOnlyItems = [];
  for (const group of treeGroups) {
    for (const entry of group.entries) {
      const lines = entry.type === "leaf" ? [entry.item] : [...entry.directItems, ...entry.subTypes.flatMap((s) => s.items)];
      for (const line of lines) if (line.noteOnly) noteOnlyItems.push(line.itemId);
    }
  }
  if (noteOnlyItems.length > 0) {
    warnings.push({
      code: "note_only",
      message: `数量・単位・単価・金額がすべて空の行が${noteOnlyItems.length}件あります（摘要のみの行として出力します）。`,
      itemIds: noteOnlyItems
    });
  }

  const detailCount = treeGroups.reduce(
    (n, g) => n + g.entries.reduce((m, e) => m + (e.type === "leaf" ? 1 : e.directItems.length + e.subTypes.reduce((k, s) => k + s.items.length, 0)), 0),
    0
  );

  return {
    groups: treeGroups,
    totals,
    errors,
    warnings,
    stats: { itemCount: items.length, assignedCount: assignmentByItem.size, unassignedCount: unassigned.length, detailCount }
  };
}
