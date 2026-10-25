/* ==========================================================
   所長印の一括押印（日報カレンダーから。2026-10-25）
   保存済みの日報を複数選び、所長欄の電子印（日報の directorSeal）をまとめて押す。日報画面の押印と同じ形・同じ決まり
   （normalizeDirectorSeal）で書き、日報の他の項目（本文・人数・作業内容・巡回点検など）・写真・職長サインには触れない。
   ・書き込みは選んだ日報すべてを1つのトランザクションで行う（途中で失敗すれば1件も変わらない）。確認画面を出した後に
     日報が別の画面で変更されていたら、何も書かずに中止し、変更された日報を示す（古い内容で上書きしない）。
   ・押印済みの日報は、既定では対象外（overwrite を選んだときだけ名前を押し直す。位置はその日報のまま）。
   ・確定済み（工事完了）・削除済みの日報、工事完了の現場は対象外（データ層でも拒否）。
   ・元に戻す: 一括押印のたびに、押した日報ごとの押印前・押印後の値をこの端末の meta に1件（現場ごとに直前の1回分）残し、
     変更履歴（auditLog）に対象の日付・件数を記録する。［元に戻す］は、押印後に別の操作で印が変わっていない日報だけを押印前に戻す。
   ========================================================== */

import { dbGet, dbGetAll, dbGuardedPutMany } from "./db.js";
import { stampUpdate, createId } from "./utils.js";
import { buildChangeEntry } from "./auditLog.js";
import { normalizeDirectorSeal, normalizeSealName } from "./report-output/directorSeal.js";

const metaKeyOf = (siteId) => `directorSealBulk:${siteId}`;
const shortDate = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "日付なし");
const sameSeal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 一括押印の計画（書き込まない）。選んだ日報を「押す（新規）／押し直す（上書き）／対象外（理由つき）」に分ける
 * @returns {{targets: {report: object, kind: "new"|"overwrite"}[], skipped: {id: string, date: string, reason: string}[]}}
 */
export function planBulkSeal(reports, reportIds, { overwrite = false } = {}) {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const targets = [], skipped = [];
  for (const id of new Set(reportIds)) {
    const r = byId.get(id);
    if (!r || r.isDeleted) { skipped.push({ id, date: r?.date || "", reason: "日報が見つからない（削除済み）" }); continue; }
    if (r.finalizedAt) { skipped.push({ id, date: r.date, reason: "工事完了で確定済み" }); continue; }
    if (r.directorSeal?.name && !overwrite) { skipped.push({ id, date: r.date, reason: `押印済み（${r.directorSeal.name}）` }); continue; }
    targets.push({ report: r, kind: r.directorSeal?.name ? "overwrite" : "new" });
  }
  const byDate = (a, b) => String(a.report?.date ?? a.date).localeCompare(String(b.report?.date ?? b.date));
  return { targets: targets.sort(byDate), skipped: skipped.sort(byDate) };
}

/**
 * 一括押印する
 * @param {{siteId: string, reportIds: string[], name: string, overwrite?: boolean, expected?: Record<string, string>}} p
 *   expected: 確認画面を出したときの各日報の updatedAt（これと違えば中止する）
 * @returns {Promise<{batchId: string|null, done: {id, date, kind}[], skipped: {id, date, reason}[], failed: {id, date, reason}[]}>}
 */
export async function applyBulkSeal({ siteId, reportIds, name, overwrite = false, expected = null }) {
  const sealName = normalizeSealName(name);
  if (!sealName) throw new Error("印の名前を入力してください。");
  const site = await dbGet("sites", siteId);
  if (!site || site.isDeleted) throw new Error("現場が見つかりません。");
  if (site.completedAt) throw new Error("工事完了の現場の日報には押印できません（現場の「工事完了を取り消す」で解除できます）。");
  const reports = (await Promise.all([...new Set(reportIds)].map((id) => dbGet("reports", id)))).filter(Boolean);
  for (const r of reports) if (r.siteId !== siteId) throw new Error("別の現場の日報が含まれています。");
  const { targets, skipped } = planBulkSeal(reports, reportIds, { overwrite });
  if (!targets.length) return { batchId: null, done: [], skipped, failed: [] };
  // 確認画面の後に変更された日報（別の画面での保存など）があれば中止する
  const changed = new Set(targets.filter(({ report }) => expected && expected[report.id] && expected[report.id] !== report.updatedAt).map(({ report }) => report.id));
  // 中止したときは、押す予定だった日報をすべて「失敗（押印していません）」として、変更された日報とそれ以外を分けて示す
  const abortAll = (list, movedIds, why) => list.map((t) => { const r = t.report || t; return { id: r.id, date: r.date, reason: movedIds.has(r.id) ? `${why}（この日報）` : `ほかの日報が${why}ため中止` }; });
  if (changed.size) return { batchId: null, done: [], skipped, failed: abortAll(targets, changed, "確認画面を出した後に変更された") };

  const at = new Date().toISOString();
  const batchId = createId();
  const items = targets.map(({ report, kind }) => {
    const before = report.directorSeal ?? null;
    // 押し直しは位置をその日報のまま（日報画面の押し直しと同じ）。新しく押すときは中央
    const after = normalizeDirectorSeal({ name: sealName, offsetX: before?.offsetX || 0, offsetY: before?.offsetY || 0, stampedAt: at });
    return { id: report.id, date: report.date, kind, before, after, updatedAt: report.updatedAt, next: stampUpdate(report, { directorSeal: after, lastEditedAt: at }) };
  });
  const record = { key: metaKeyOf(siteId), kind: "directorSealBulk", batchId, siteId, at, name: sealName, overwrite, undoneAt: null,
    items: items.map(({ id, date, kind, before, after }) => ({ id, date, kind, before, after })) };
  const dates = items.map((i) => shortDate(i.date)).join("・");
  const summary = `所長印を一括押印（${sealName}・${items.length}件${overwrite ? `（押し直し${items.filter((i) => i.kind === "overwrite").length}件）` : ""}: ${dates}）`;
  try {
    await dbGuardedPutMany({
      reads: items.map((i) => ({ store: "reports", id: i.id })),
      // トランザクションの中で読み直し、計画の後に変わった日報があれば何も書かない
      check: ({ records }) => {
        const moved = items.filter((i) => { const cur = records.get(`reports:${i.id}`); return !cur || cur.isDeleted || cur.finalizedAt || cur.updatedAt !== i.updatedAt; });
        return moved.length ? Object.assign(new Error("changed"), { moved }) : null;
      },
      entries: [...items.map((i) => ({ store: "reports", value: i.next })), { store: "meta", value: record }, { store: "auditLog", value: buildChangeEntry({ entityType: "site", entityId: siteId, action: "update", summary }) }]
    });
  } catch (err) {
    if (err?.moved) return { batchId: null, done: [], skipped, failed: abortAll(items, new Set(err.moved.map((i) => i.id)), "押印の直前に変更・削除された") };
    return { batchId: null, done: [], skipped, failed: items.map((i) => ({ id: i.id, date: i.date, reason: `保存に失敗したため中止（1件も押印していません）: ${err?.message || err}` })) };
  }
  return { batchId, done: items.map(({ id, date, kind }) => ({ id, date, kind })), skipped, failed: [] };
}

/** この現場の直前の一括押印（この端末の記録。元に戻した後は undoneAt が入る）。無ければ null */
export async function getLastBulkSeal(siteId) {
  return (await dbGet("meta", metaKeyOf(siteId))) || null;
}

/**
 * 直前の一括押印を元に戻す。押印後に印が変わっていない日報だけを押印前の値（押していなければ印なし）に戻す
 * @returns {Promise<{restored: {id, date}[], skipped: {id, date, reason}[]}>}
 */
export async function undoBulkSeal(siteId) {
  const rec = await getLastBulkSeal(siteId);
  if (!rec || rec.undoneAt) throw new Error("元に戻せる一括押印がありません。");
  const site = await dbGet("sites", siteId);
  if (site?.completedAt) throw new Error("工事完了の現場では元に戻せません。");
  const current = new Map((await Promise.all(rec.items.map((i) => dbGet("reports", i.id)))).filter(Boolean).map((r) => [r.id, r]));
  const restore = [], skipped = [];
  for (const i of rec.items) {
    const r = current.get(i.id);
    if (!r || r.isDeleted) { skipped.push({ id: i.id, date: i.date, reason: "日報が削除されている" }); continue; }
    if (r.finalizedAt) { skipped.push({ id: i.id, date: i.date, reason: "工事完了で確定済み" }); continue; }
    if (!sameSeal(r.directorSeal, i.after)) { skipped.push({ id: i.id, date: i.date, reason: "一括押印の後に印が変更されている（そのままにします）" }); continue; }
    restore.push({ ...i, report: r });
  }
  const at = new Date().toISOString();
  const summary = `所長印の一括押印を元に戻す（${restore.length}件${restore.length ? `: ${restore.map((i) => shortDate(i.date)).join("・")}` : ""}）`;
  await dbGuardedPutMany({
    reads: [{ store: "meta", id: rec.key }, ...restore.map((i) => ({ store: "reports", id: i.id }))],
    check: ({ records }) => {
      const m = records.get(`meta:${rec.key}`);
      if (!m || m.batchId !== rec.batchId || m.undoneAt) return new Error("一括押印の記録が変わったため、元に戻すのを中止しました。もう一度開いてください。");
      const moved = restore.filter((i) => records.get(`reports:${i.id}`)?.updatedAt !== i.report.updatedAt);
      return moved.length ? new Error(`元に戻す直前に変更された日報があるため中止しました（${moved.map((i) => shortDate(i.date)).join("・")}）。もう一度開いてください。`) : null;
    },
    entries: [
      ...restore.map((i) => ({ store: "reports", value: stampUpdate(i.report, { directorSeal: i.before, lastEditedAt: at }) })),
      { store: "meta", value: { ...rec, undoneAt: at } },
      { store: "auditLog", value: buildChangeEntry({ entityType: "site", entityId: siteId, action: "update", summary }) }
    ]
  });
  return { restored: restore.map(({ id, date }) => ({ id, date })), skipped };
}

/** 名前の初期値: この端末で前に使った名前、無ければこの現場の一番新しい印の名前（日報画面の押印と同じ） */
export async function defaultSealName(siteId) {
  try { const v = localStorage.getItem("kojiNippou.directorSealName"); if (v) return v; } catch { /* 保存できない端末でも動く */ }
  const prev = (await dbGetAll("reports")).filter((r) => r.siteId === siteId && !r.isDeleted && r.directorSeal?.name).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return prev?.directorSeal.name || "";
}
