/* ==========================================================
   頁生成エンジン（純粋関数、DOM・DB非依存）
   階層モデル → スケジュール（表紙／区分頁／工種頁／種別頁）→ 明細行の
   展開 → 頁割付（改頁・継続頁）→ 頁ごとの小計・頁番号。
   行位置・容量・小計位置はすべてtemplateProfile.jsが原本から導出した
   プロファイル（profile.positions / lineParity）から取得し、41行等は
   ここには書かない。

   行の置き方（原本の規則）:
     ・1項目は「上段の文字行 … 最終行（数値行）」の連続した行になる。
       名称・摘要は下詰め（最終行に最後の行が来る）。
     ・数値行は決まった偶奇の行位置にしか置けない（罫線が1行おき）。
       置けない場合は1行空けてから置く。
   ========================================================== */

import { splitTextLines } from "./submissionModel.js";

function textRowsOf(item) {
  const nameLines = splitTextLines(item.name);
  const specLines = splitTextLines(item.spec);
  const count = Math.max(nameLines.length, specLines.length, 1);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const cells = {};
    const nameLine = nameLines[i - (count - nameLines.length)];
    const specLine = specLines[i - (count - specLines.length)];
    if (nameLine) cells.name = nameLine;
    if (specLine) cells.spec = specLine;
    rows.push({ cells });
  }
  return rows;
}

function withNumbers(rows, numbers) {
  const last = rows[rows.length - 1];
  for (const [key, value] of Object.entries(numbers)) {
    if (value !== null && value !== undefined && value !== "") last.cells[key] = value;
  }
  return rows;
}

function itemLine(item, symbol = "") {
  const rows = textRowsOf(item);
  return withNumbers(rows, {
    symbol,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    amount: item.amount,
    note: item.note
  });
}

/** 「1式・単価＝金額＝合計」の集計行（表紙・区分頁・工種頁の一覧行） */
function lumpLine({ symbol, name, spec = "", total }, cover) {
  const cells = { symbol, name, quantity: cover.lumpQuantity, unit: cover.lumpUnit, unitPrice: total, amount: total };
  if (spec) cells.spec = spec;
  return [{ cells }];
}

function totalLine(label, total) {
  return [{ cells: { name: label, amount: total } }];
}

function buildSchedules(model, profile) {
  const { cover, labels } = profile;
  const schedules = [];

  const coverLines = [];
  const groupsOfKind = (kinds) => model.groups.filter((g) => kinds.includes(g.kind));
  const pushGroups = (kinds) => {
    for (const g of groupsOfKind(kinds)) coverLines.push(lumpLine({ symbol: g.symbol, name: g.name, total: g.total }, cover));
  };
  pushGroups(["building"]);
  coverLines.push(totalLine(cover.subtotalLabels[0], model.totals.directTotal));
  pushGroups(["common_temp_itemized", "common_temp_general"]);
  coverLines.push(totalLine(cover.subtotalLabels[1], model.totals.netTotal));
  pushGroups(["site_management"]);
  coverLines.push(totalLine(cover.subtotalLabels[2], model.totals.costTotal));
  schedules.push({ kind: "cover", crumb: null, lines: coverLines, subtotal: null });

  for (const group of model.groups) {
    if (!group.expand) continue;

    const groupLines = group.entries.map((entry) =>
      entry.type === "leaf"
        ? itemLine(entry.item, entry.symbol)
        : lumpLine({ symbol: entry.symbol, name: entry.name, total: entry.total }, cover)
    );
    schedules.push({
      kind: "group",
      crumb: { symbol: group.symbol, name: group.name },
      lines: groupLines,
      subtotal: { label: `${group.name}${labels.groupSuffix}`, amount: group.total }
    });

    for (const entry of group.entries) {
      if (entry.type !== "workType") continue;
      const listsSubTypes = entry.subTypes.length > 0;
      const lines = listsSubTypes
        ? entry.subTypes.map((sub) => lumpLine({ symbol: sub.symbol, name: entry.name, spec: sub.name, total: sub.total }, cover))
        : entry.directItems.map((item) => itemLine(item));
      schedules.push({
        kind: "workType",
        crumb: { symbol: entry.symbol, name: entry.name },
        lines,
        subtotal: { label: labels.workType, amount: entry.total }
      });
      for (const sub of entry.subTypes) {
        schedules.push({
          kind: "subType",
          crumb: { symbol: sub.symbol, name: entry.name, spec: sub.name },
          lines: sub.items.map((item) => itemLine(item)),
          subtotal: { label: labels.subType, amount: sub.total }
        });
      }
    }
  }
  return schedules;
}

/**
 * スケジュール1つを、物理頁（行位置つき）へ割り付ける。
 * 本体の容量を超える場合は継続頁に分割し、小計は最後の頁にだけ置く。
 */
function paginateSchedule(schedule, scheduleIndex, profile) {
  const { firstBody, lastLine, subtotal } = profile.positions;
  const parity = profile.lineParity;
  const pages = [];
  let current = null;
  let pos = firstBody;

  const crumbRows = () => (schedule.crumb ? [{ cells: { ...schedule.crumb }, kind: "crumb" }] : []);

  const startPage = (continuation) => {
    current = { scheduleIndex, kind: schedule.kind, crumb: schedule.crumb, continuation, rows: [], subtotal: null };
    pages.push(current);
    pos = firstBody;
    for (const row of crumbRows()) placeRows([row], true);
  };

  function placeRows(lineRows, isCrumb = false) {
    const count = lineRows.length;
    let start = pos;
    if ((start + count - 1) % 2 !== parity) start++;
    const end = start + count - 1;
    if (end > lastLine) return false;
    lineRows.forEach((row, i) => {
      const isLast = i === count - 1;
      current.rows.push({ pos: start + i, cells: row.cells, kind: isCrumb ? "crumb" : isLast ? "numbers" : "text" });
    });
    pos = end + 1;
    return true;
  }

  startPage(false);
  for (const lineRows of schedule.lines) {
    if (!placeRows(lineRows)) {
      startPage(true);
      if (!placeRows(lineRows)) {
        throw new Error("1つの明細が1頁に収まりません（行数が多すぎます）。名称・摘要の行数を減らしてください。");
      }
    }
  }
  if (schedule.subtotal) {
    current.subtotal = { pos: subtotal, cells: { name: schedule.subtotal.label, amount: schedule.subtotal.amount } };
  }
  return pages;
}

/**
 * @returns {{ pages: object[], scheduleCount: number, continuationPageCount: number }}
 *   pages[i] = { scheduleIndex, kind, continuation, rows:[{pos,cells,kind}], subtotal:{pos,cells}|null }
 *   頁番号は配列順の1始まり（P-1…P-n）。呼び出し側（sheetXmlWriter）が振る。
 */
export function buildSubmissionPages(model, profile) {
  const schedules = buildSchedules(model, profile);
  const pages = schedules.flatMap((schedule, index) => paginateSchedule(schedule, index, profile));
  return {
    pages,
    scheduleCount: schedules.length,
    continuationPageCount: pages.filter((p) => p.continuation).length
  };
}
