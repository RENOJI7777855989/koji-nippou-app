/* ==========================================================
   提出金額内訳書Excelの取込（データ層・反映処理）
   取込1回＝1レコード（submissionImports）。解析した明細・照合結果・
   人間の確認結果（採用／手動選択／割当しない）を保持し、再取込では
   行ごとの安定キーで前回と突き合わせて差分を出し、変更のない行の
   確認結果を引き継ぐ。取込結果を割当（submissionAssignments）へ反映
   するのは、ユーザーが「割当に反映」を押したときだけ。
   反映では既存の割当を壊さない:
     ・割当が無い項目 … 新規作成（origin: "import"）
     ・同じ内容の割当 … 何もしない（二重登録しない）
     ・取込で作った割当（origin: "import"）で内容が違う … 更新
     ・手動の割当（画面で作った／直した）で内容が違う … 衝突として残す。
       行ごとに「取込の内容で上書き」を明示した場合だけ上書きする。
   元のExcelファイル自体は読み取りのみで、保存もしない（SHA-256だけ記録）。
   ========================================================== */

import { dbGetAll, dbGet, dbPut } from "../db.js";
import { createEstimateBatch } from "../estimate/estimateBatches.js";
import { listEstimateItemsBySite } from "../estimate/estimateItems.js";
import { stampNew, stampUpdate } from "../utils.js";
import { recordChange } from "../auditLog.js";
import { readSheetParts } from "../submission-output/renderSubmissionWorkbook.js";
import { parseSubmissionWorkbook } from "./submissionWorkbookParser.js";
import { matchImportLines, findRegistrationCandidates } from "./importMatcher.js";
import { assignLineKeys, diffImportLines } from "./importDiff.js";
import { getSubmissionPlan, saveSubmissionPlan, newSubmissionGroup } from "../submission/submissionPlans.js";
import { listSubmissionAssignments, upsertImportAssignment } from "../submission/submissionAssignments.js";
import { normalizeItemText } from "../vendorQuote/itemNormalize.js";

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listImportsBySite(siteId) {
  const all = await dbGetAll("submissionImports", "by_siteId", siteId);
  return all.filter((r) => !r.isDeleted).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

export async function getActiveImport(siteId) {
  return (await listImportsBySite(siteId)).find((r) => r.isActive) || null;
}

/** ファイルを解析するだけ（保存しない）。元ファイルは読み取りのみ。 */
export async function analyzeImportFile(file) {
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const { sheetXml, sharedStringsXml, sheetName } = await readSheetParts(buffer);
  const parsed = parseSubmissionWorkbook({ sheetXml, sharedStringsXml, sheetName });
  return { sha256, size: buffer.byteLength, parsed, sheetName };
}

/** 人間の決定 or 完全一致の自動採用から、その行に対応させる積算項目IDを返す（無ければnull） */
export function resolvedItemIdOf(line) {
  if (["accepted", "manual", "registered"].includes(line.decision?.type)) return line.decision.itemId || null;
  if (line.decision?.type === "skipped") return null;
  if (line.flags?.noteOnly) return null;
  return line.match?.status === "exact" ? line.match.itemId : null;
}

/**
 * 取込を作成して保存する。同じファイル（SHA-256）または内容が前回と同一なら新規作成せず、
 * 既存の取込をそのまま返す（二重登録しない）。
 * @returns {{ record: object, diff: object|null, created: boolean, reason: string }}
 */
export async function createImport({ siteId, file, analysis, items }) {
  const { sha256, size, parsed } = analysis;
  if (!parsed.ok) throw new Error(`この様式は取り込めません: ${parsed.errors.join(" ")}`);
  const active = await getActiveImport(siteId);
  const lines = assignLineKeys(parsed.result.lines);

  let diff = null;
  if (active) {
    diff = diffImportLines(active.lines, lines);
    if (active.sourceFileSha256 === sha256 || diff.identical) {
      return { record: active, diff, created: false, reason: active.sourceFileSha256 === sha256 ? "同じファイルです（前回の取込と完全に同一）。新しい取込は作成していません。" : "前回の取込と内容が同一です。新しい取込は作成していません。" };
    }
  }

  const matches = matchImportLines(lines, items);
  const itemIds = new Set(items.map((i) => i.id));
  const prevByKey = new Map((active?.lines || []).map((l) => [l.lineKey, l]));
  const changedKeys = new Set((diff?.changed || []).map((c) => c.next.lineKey));
  const merged = lines.map((line, i) => {
    const prev = prevByKey.get(line.lineKey);
    let decision = { type: "none", itemId: null };
    let previousDecision = null;
    if (prev && prev.decision && prev.decision.type !== "none") {
      // 内容が変わっていない行だけ前回の確認結果を引き継ぐ（変わった行はもう一度確認してもらう）
      if (!changedKeys.has(line.lineKey) && (!prev.decision.itemId || itemIds.has(prev.decision.itemId))) decision = { ...prev.decision };
      else previousDecision = prev.decision;
    }
    return { ...line, match: matches[i], decision, previousDecision, changedFromPrevious: changedKeys.has(line.lineKey), addedInThisImport: !!active && !prevByKey.has(line.lineKey) };
  });

  if (active) await dbPut("submissionImports", stampUpdate(active, { isActive: false }));
  const result = parsed.result;
  const record = stampNew({
    siteId,
    sourceFileName: file.name,
    sourceFileSha256: sha256,
    sourceFileSize: size,
    sheetName: analysis.sheetName || parsed.result.sheetName || "",
    importedAt: new Date().toISOString(),
    isActive: true,
    pageTitle: result.pageTitle,
    companyName: result.companyName,
    groups: result.groups,
    lines: merged,
    checks: result.checks,
    stats: result.stats,
    warnings: parsed.warnings,
    diffSummary: diff ? { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, unchanged: diff.unchanged } : null
  });
  await dbPut("submissionImports", record);
  await recordChange({ entityType: "submissionImport", entityId: record.id, action: "create", summary: `提出内訳Excel「${file.name}」を取込（明細${merged.length}件）` });
  return { record, diff, created: true, reason: active ? "前回の取込との差分を反映して新しい取込を作成しました。" : "取込を作成しました。" };
}

async function updateRecord(importId, mutate) {
  const record = await dbGet("submissionImports", importId);
  if (!record) throw new Error("取込データが見つかりません");
  const updated = stampUpdate(record, mutate(record));
  await dbPut("submissionImports", updated);
  return updated;
}

/** 行ごとの人間の確認結果を保存する。type: "accepted"（候補を採用）|"manual"（手動選択）|"skipped"（割当しない）|"none"（未確認に戻す） */
export function setLineDecision(importId, lineKey, decision) {
  return updateRecord(importId, (record) => ({
    lines: record.lines.map((l) => (l.lineKey === lineKey ? { ...l, decision: { type: decision.type, itemId: decision.itemId ?? null } } : l))
  }));
}

export function setImportGroupKind(importId, symbol, kind) {
  return updateRecord(importId, (record) => ({ groups: record.groups.map((g) => (g.symbol === symbol ? { ...g, kind, kindBasis: "user" } : g)) }));
}

/**
 * 取込結果を割当へ反映する。冪等（何度実行しても二重登録しない）。
 * @param {string[]} [overwriteKeys] 手動割当と衝突した行のうち、取込の内容で上書きすると明示した行のlineKey
 */
export async function applyImportToAssignments({ siteId, importId, overwriteKeys = [] }) {
  const record = await dbGet("submissionImports", importId);
  if (!record) throw new Error("取込データが見つかりません");
  const overwrite = new Set(overwriteKeys);

  // 区分グループ: 名前が同じ既存グループを再利用し、無ければ追加する（既存グループは変更しない）
  let plan = await getSubmissionPlan(siteId);
  const groups = [...(plan?.groups || [])];
  const groupIdBySymbol = new Map();
  let groupsAdded = 0;
  for (const g of record.groups) {
    let existing = groups.find((x) => normalizeItemText(x.name) === normalizeItemText(g.name));
    if (!existing) {
      existing = newSubmissionGroup({ name: g.name, kind: g.kind });
      existing.expand = !!g.hasPage; // 内訳頁の無い区分（現場管理費等）は表紙の1行のみ
      groups.push(existing);
      groupsAdded++;
    }
    groupIdBySymbol.set(g.symbol, existing.id);
  }
  if (groupsAdded > 0) plan = await saveSubmissionPlan(siteId, { groups });

  const existingAssignments = new Map((await listSubmissionAssignments(siteId)).map((a) => [a.estimateItemId, a]));
  const report = { created: 0, updated: 0, unchanged: 0, conflicts: [], overwritten: 0, skippedUnresolved: 0, skippedNoteOnly: 0, duplicateItem: [], groupsAdded };
  const usedItems = new Set();

  for (const line of record.lines) {
    const itemId = resolvedItemIdOf(line);
    if (!itemId) {
      // 摘要のみの行は、人間が「積算項目として登録」した場合にだけ割当対象になる
      if (line.flags?.noteOnly) report.skippedNoteOnly++;
      else report.skippedUnresolved++;
      continue;
    }
    if (usedItems.has(itemId)) {
      report.duplicateItem.push(line.lineKey);
      continue;
    }
    usedItems.add(itemId);
    const desired = { groupId: groupIdBySymbol.get(line.groupSymbol), workType: line.workType, subType: line.subType, order: line.displayOrder, note: line.note, importLineKey: line.lineKey };
    const existing = existingAssignments.get(itemId);
    if (!existing) {
      await upsertImportAssignment(siteId, itemId, desired);
      report.created++;
    } else if (existing.groupId === desired.groupId && (existing.workType || "") === desired.workType && (existing.subType || "") === desired.subType) {
      report.unchanged++;
    } else if (existing.origin === "import") {
      await upsertImportAssignment(siteId, itemId, { ...desired, note: existing.note || desired.note });
      report.updated++;
    } else if (overwrite.has(line.lineKey)) {
      await upsertImportAssignment(siteId, itemId, { ...desired, note: existing.note || desired.note });
      report.overwritten++;
    } else {
      report.conflicts.push({ lineKey: line.lineKey, itemId, existing: { groupId: existing.groupId, workType: existing.workType, subType: existing.subType }, imported: { group: line.groupName, workType: line.workType, subType: line.subType } });
    }
  }
  await recordChange({ entityType: "submissionImport", entityId: importId, action: "update", summary: `提出内訳Excelの取込を割当へ反映（新規${report.created}・更新${report.updated}・維持${report.unchanged}・衝突${report.conflicts.length}）` });
  return report;
}

/** 取込レコードで「積算項目として登録済み」になっている積算項目 → {importId, lineKey} の対応（この現場の全取込を横断） */
export async function listRegisteredItemsBySite(siteId) {
  const map = new Map();
  for (const record of await listImportsBySite(siteId)) {
    for (const line of record.lines) {
      if (line.decision?.type === "registered" && line.decision.itemId && !map.has(line.decision.itemId)) {
        map.set(line.decision.itemId, { importId: record.id, lineKey: line.lineKey, sourceFileName: record.sourceFileName, registeredAt: line.decision.registeredAt });
      }
    }
  }
  return map;
}

const str = (v) => (v == null ? "" : String(v));

/**
 * 不一致などの明細を、人間の確認のうえで積算項目（estimateItems）として登録する。
 * ・呼び出し側（確認画面）が「登録」を押したときだけ呼ぶ。ここで自動登録はしない。
 * ・既存の積算項目の構造のまま作る（欄は増やさない）。金額はExcelの値をそのまま amount に入れ、
 *   数量×単価の再計算はしない（積算側の規則: amountは取込値が正規）。
 * ・元Excelとの対応: 既存欄（sourceFileName/sourceSheet/sourceRow/rawRowCells/category）に元情報を持たせ、
 *   「取込レコードのどの行か」は取込レコード側の確認結果（decision.type="registered"）に持たせる。
 * @param {object[]} entries { lineKey, mode: "new"|"existing", existingItemId?, name, spec,
 *                             confirmed: true（必須）, acknowledgeDuplicate?, acknowledgeAmbiguous?, acknowledgeNoteOnly? }
 * @returns {{ registered: object[], usedExisting: object[], skipped: {lineKey, reason, message}[] }}
 */
export async function registerImportLinesAsEstimateItems({ siteId, importId, entries }) {
  const record = await dbGet("submissionImports", importId);
  if (!record) throw new Error("取込データが見つかりません");
  const items = await listEstimateItemsBySite(siteId);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const out = { registered: [], usedExisting: [], skipped: [] };
  const skip = (lineKey, reason, message) => out.skipped.push({ lineKey, reason, message });

  let batchId = record.registrationBatchId && (await dbGet("estimateBatches", record.registrationBatchId))?.isDeleted === false ? record.registrationBatchId : null;
  const newDecisions = new Map();

  for (const entry of entries) {
    const line = record.lines.find((l) => l.lineKey === entry.lineKey);
    if (!line) { skip(entry.lineKey, "not_found", "取込明細が見つかりません"); continue; }
    if (entry.confirmed !== true) { skip(entry.lineKey, "not_confirmed", "内容の確認が済んでいません"); continue; }
    const current = line.decision;
    if (current?.type === "registered" && itemById.has(current.itemId)) { skip(entry.lineKey, "already_registered", "すでに積算項目として登録済みです"); continue; }
    if (line.match.status === "exact" && current?.type !== "skipped") { skip(entry.lineKey, "exact_exists", "完全一致する積算項目があるため登録できません（そのまま割当に使えます）"); continue; }

    if (entry.mode === "existing") {
      if (!entry.existingItemId || !itemById.has(entry.existingItemId)) { skip(entry.lineKey, "existing_missing", "選んだ既存の積算項目が見つかりません"); continue; }
      newDecisions.set(entry.lineKey, { type: "manual", itemId: entry.existingItemId });
      out.usedExisting.push({ lineKey: entry.lineKey, itemId: entry.existingItemId });
      continue;
    }

    if (entry.mode !== "new") { skip(entry.lineKey, "bad_mode", "登録方法が不正です"); continue; }
    if (line.flags.ambiguous && entry.acknowledgeAmbiguous !== true) { skip(entry.lineKey, "ambiguous_not_acknowledged", "構造要確認の行です。前の項目の追記行が混ざっていないか確認し、確認済みにしてください"); continue; }
    if (line.flags.noteOnly && entry.acknowledgeNoteOnly !== true) { skip(entry.lineKey, "note_only_not_acknowledged", "摘要のみの行です。積算項目として必要か確認し、確認済みにしてください"); continue; }
    const name = str(entry.name).trim();
    if (!name && !str(entry.spec).trim()) { skip(entry.lineKey, "empty", "名称も摘要も空のため登録できません"); continue; }
    const cand = findRegistrationCandidates({ ...line, name, spec: str(entry.spec) }, items);
    if (cand.identical.length > 0 && entry.acknowledgeDuplicate !== true) { skip(entry.lineKey, "identical_exists", `完全に同じ内容の積算項目が${cand.identical.length}件あります。重複登録する場合は確認欄にチェックしてください`); continue; }

    if (!batchId) {
      const batch = await createEstimateBatch({
        siteId,
        sourceFileName: record.sourceFileName,
        sourceFileType: "excel",
        sheetName: record.sheetName || "",
        columnMapping: {},
        headerRow: null,
        itemCount: 0,
        memo: `提出内訳Excelから確認のうえ登録した項目（取込ID: ${importId}）`
      });
      batchId = batch.id;
    }
    const item = stampNew({
      siteId,
      estimateBatchId: batchId,
      category: line.workType || line.groupName,
      itemName: name,
      spec: str(entry.spec).trim(),
      quantity: line.quantity ?? null,
      unit: line.unit || "",
      unitPrice: line.unitPrice ?? null,
      amount: line.amount ?? null, // Excelの金額をそのまま正規値とする（再計算しない）
      sourceFileName: record.sourceFileName,
      sourceSheet: record.sheetName || "",
      sourceRow: line.source.lastRow,
      rawRowCells: [
        `区分:${line.groupSymbol} ${line.groupName}`,
        `工種:${line.workTypeSymbol} ${line.workType}`.trim(),
        `種別:${line.subTypeSymbol} ${line.subType}`.trim(),
        line.name, line.spec, str(line.quantity), line.unit, str(line.unitPrice), str(line.amount), line.note
      ],
      needsReview: false,
      reviewReasons: [],
      memo: ""
    });
    await dbPut("estimateItems", item);
    itemById.set(item.id, item);
    items.push(item);
    newDecisions.set(entry.lineKey, { type: "registered", itemId: item.id, registeredAt: new Date().toISOString(), editedText: item.itemName !== line.name || item.spec !== line.spec });
    out.registered.push({ lineKey: entry.lineKey, itemId: item.id });
  }

  if (newDecisions.size > 0 || batchId !== record.registrationBatchId) {
    await updateRecord(importId, (r) => ({
      registrationBatchId: batchId ?? r.registrationBatchId ?? null,
      lines: r.lines.map((l) => (newDecisions.has(l.lineKey) ? { ...l, decision: newDecisions.get(l.lineKey) } : l))
    }));
    if (batchId) {
      const batch = await dbGet("estimateBatches", batchId);
      const count = (await listEstimateItemsBySite(siteId)).filter((i) => i.estimateBatchId === batchId).length;
      await dbPut("estimateBatches", stampUpdate(batch, { itemCount: count }));
    }
  }
  if (out.registered.length > 0) {
    await recordChange({ entityType: "submissionImport", entityId: importId, action: "update", summary: `提出内訳Excelの明細${out.registered.length}件を確認のうえ積算項目として登録` });
  }
  return out;
}
