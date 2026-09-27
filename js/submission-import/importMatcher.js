/* ==========================================================
   取込明細と既存の積算項目（estimateItems）の照合（純粋関数）
   「名称が似ているから同じ項目」と自動で確定しない。結果は4種類:
     exact     完全一致  名称・摘要・数量・単位・単価・金額がすべて一致し、
                        双方で一意（同じ内容の項目が複数あれば要確認）
     candidate 候補      有力な積算項目が1件ある（人間が採用を選ぶ）
     review    要確認    有力な候補が複数ある／名称は同じでも数値が食い違う 等
     none      不一致    有力な候補がない
   摘要のみの行（数値が全く無い行）は照合対象外（status "note"）。
   自動で初期割当になるのは exact だけ。それ以外は画面で人間が選ぶ。
   正規化・類似度は既存の itemNormalize.js（見積比較と同じ）を再利用する。
   ========================================================== */

import { normalizeItemText, itemSimilarity } from "../vendorQuote/itemNormalize.js";

const NAME_SIMILAR_THRESHOLD = 0.6; // 候補に入れる名称の類似度の下限（見積比較の「要確認」帯と同程度）
const NAME_STRONG_THRESHOLD = 0.82; // 数値が一致している場合に「有力」とみなす名称の類似度

const sameNumber = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));

function compareOne(line, item) {
  const nameEq = normalizeItemText(line.name) === normalizeItemText(item.itemName);
  const specEq = normalizeItemText(line.spec) === normalizeItemText(item.spec);
  const numbersEq =
    sameNumber(line.quantity, item.quantity) &&
    (line.unit || "") === (item.unit || "") &&
    sameNumber(line.unitPrice, item.unitPrice) &&
    sameNumber(line.amount, item.amount);
  const amountEq = line.amount != null && sameNumber(line.amount, item.amount) && sameNumber(line.quantity, item.quantity);
  const nameSim = nameEq ? 1 : itemSimilarity(line.name, item.itemName);
  return { nameEq, specEq, numbersEq, amountEq, nameSim };
}

/**
 * @param {object[]} lines parseSubmissionWorkbook().result.lines
 * @param {object[]} items 積算項目（listEstimateItemsBySite）
 * @returns {{ status: "exact"|"candidate"|"review"|"none"|"note", itemId: string|null, candidates: {itemId, nameSim, nameEq, specEq, numbersEq}[], reason: string }[]}
 *   linesと同じ順序
 */
export function matchImportLines(lines, items) {
  const evaluated = lines.map((line) => {
    if (line.flags?.noteOnly) return { status: "note", itemId: null, candidates: [], reason: "摘要のみの行（数値が無いため照合対象外）" };
    const scored = items
      .map((item) => ({ item, ...compareOne(line, item) }))
      .filter((c) => c.nameSim >= NAME_SIMILAR_THRESHOLD || c.amountEq);
    const fullEq = scored.filter((c) => c.nameEq && c.specEq && c.numbersEq);
    const candidates = scored
      .sort((a, b) => Number(b.nameEq && b.specEq && b.numbersEq) - Number(a.nameEq && a.specEq && a.numbersEq) || b.nameSim - a.nameSim)
      .slice(0, 8)
      .map((c) => ({ itemId: c.item.id, nameSim: c.nameSim, nameEq: c.nameEq, specEq: c.specEq, numbersEq: c.numbersEq }));

    if (fullEq.length === 1) return { status: "exact", itemId: fullEq[0].item.id, candidates, reason: "名称・摘要・数量・単位・単価・金額がすべて一致" };
    if (fullEq.length > 1) return { status: "review", itemId: null, candidates, reason: `完全に同じ内容の積算項目が${fullEq.length}件あり、どれに対応するか決められません` };
    if (scored.length === 0) return { status: "none", itemId: null, candidates: [], reason: "名称・数値が近い積算項目が見つかりません" };

    const strong = scored.filter((c) => (c.nameEq && (c.specEq || c.numbersEq)) || (c.numbersEq && c.nameSim >= NAME_STRONG_THRESHOLD));
    if (strong.length === 1 && scored.length === 1) {
      const c = strong[0];
      return { status: "candidate", itemId: c.item.id, candidates, reason: c.numbersEq ? "数値が一致し名称が近い（摘要が異なる）" : "名称・摘要が一致（数値が異なる）" };
    }
    return { status: "review", itemId: null, candidates, reason: strong.length > 1 ? "有力な候補が複数あります" : "名称は近いが数値・摘要が食い違います" };
  });

  // 同じ積算項目に「完全一致」した明細が複数ある場合は、どちらが正しいか決められないので要確認へ落とす
  const claims = new Map();
  evaluated.forEach((e, i) => {
    if (e.status === "exact") (claims.get(e.itemId) || claims.set(e.itemId, []).get(e.itemId)).push(i);
  });
  for (const [itemId, indexes] of claims) {
    if (indexes.length > 1) {
      for (const i of indexes) evaluated[i] = { ...evaluated[i], status: "review", itemId: null, reason: `同じ積算項目に${indexes.length}行の明細が完全一致しています（どの行に対応するか決められません）` };
    }
  }
  return evaluated;
}

const lineSignature = (l) => JSON.stringify([normalizeItemText(l.name), normalizeItemText(l.spec), l.quantity ?? null, l.unit || "", l.unitPrice ?? null, l.amount ?? null]);
const itemSignature = (i) => JSON.stringify([normalizeItemText(i.itemName), normalizeItemText(i.spec), i.quantity ?? null, i.unit || "", i.unitPrice ?? null, i.amount ?? null]);

/**
 * 「まったく同じ内容の明細がn行」「まったく同じ内容の積算項目がちょうどn件」の場合に限り、
 * 出現順の1対1の対応を"提案"する（例: 3棟に同じ内容の行がある）。確定はしない。
 * 提案の採用はユーザーが明示的に行う（画面の「同一内容を出現順に対応付け」ボタン）。
 * n行とm件が一致しない場合は提案しない。
 * @returns {{ lineKey: string, itemId: string }[]}
 */
export function proposeIdenticalPairings(lines, matches, items) {
  const groups = new Map();
  lines.forEach((line, i) => {
    if (matches[i].status !== "review" || line.flags?.noteOnly) return;
    const sig = lineSignature(line);
    (groups.get(sig) || groups.set(sig, []).get(sig)).push(line);
  });
  const itemsBySig = new Map();
  for (const item of items) {
    const sig = itemSignature(item);
    (itemsBySig.get(sig) || itemsBySig.set(sig, []).get(sig)).push(item);
  }
  const proposals = [];
  const exactItemIds = new Set(matches.filter((m) => m.status === "exact").map((m) => m.itemId));
  for (const [sig, group] of groups) {
    const candidates = (itemsBySig.get(sig) || []).filter((item) => !exactItemIds.has(item.id));
    if (candidates.length !== group.length) continue;
    const orderedLines = [...group].sort((a, b) => a.displayOrder - b.displayOrder);
    const orderedItems = [...candidates].sort((a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0) || String(a.id).localeCompare(String(b.id)));
    orderedLines.forEach((line, k) => proposals.push({ lineKey: line.lineKey, itemId: orderedItems[k].id }));
  }
  return proposals;
}

const REGISTRATION_SIMILAR_THRESHOLD = 0.4; // 登録前の「既存候補があります」表示用。照合（0.6）より緩くして見落としを減らす

/**
 * 積算項目として新規登録する前の重複チェック用。
 * identical … 名称・摘要・数量・単位・単価・金額がすべて一致する既存項目（新規登録すると完全な重複になる）
 * similar   … 名称が近い、または数量・金額が同じ既存項目（同じ項目の可能性。同一とは確定しない）
 */
export function findRegistrationCandidates(line, items) {
  const identical = [];
  const similar = [];
  for (const item of items) {
    const c = compareOne(line, item);
    if (c.nameEq && c.specEq && c.numbersEq) identical.push(item);
    else if (c.nameSim >= REGISTRATION_SIMILAR_THRESHOLD || c.amountEq) similar.push({ item, nameSim: c.nameSim, amountEq: c.amountEq, numbersEq: c.numbersEq });
  }
  similar.sort((a, b) => b.nameSim - a.nameSim);
  return { identical, similar: similar.slice(0, 6) };
}
