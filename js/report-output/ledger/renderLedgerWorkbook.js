/* ==========================================================
   工事期間の台帳（安全衛生作業打合日誌の台帳シート）を1冊のExcelで作る
   （DB非依存。呼び出し側が現場・日報・テンプレート原本を渡す）

   手順（すべて出力用の複製に対して行い、原本テンプレートは変更しない）:
     1. 台帳構造の解析（1頁の行数・1シートの頁数を原本から導出）
     2. 他工事データ除去（前の工事の記入例を消す。数式・様式の文言は残す）
     3. 必要なシート数に合わせる
          工事期間が短い … 使わない後ろのシートを外し、最後のシートの印刷範囲を
                           工事最終日の頁までに縮める
          180日を超える   … 最後の台帳シートを複製して「181～200」…と追加する
                           （数式が参照する前シート名を付け替える）。上限は設けない
     4. 起点（工事名・工事開始日・打合日）を先頭シート1頁目に書く
        → 全頁の工事名・日付は原本の数式が決める（数式セルには書き込まない）
     5. 日報ごとに「日報日付−工事開始日」の頁へ書き込む（休工日は空欄の頁のまま）
     6. 数式の表示値（キャッシュ）を計算し直す（数式そのものは残す）
     7. 残留情報（保存先パス・外部リンク・参照されない共有文字列）を除く

   同じ期間・同じ日報なら何度出力しても同じ内容になる（毎回原本から作り直すため、
   前回の出力へ追記・上書きすることはない）。
   ========================================================== */

import { WorkbookPackage, parseRelationships, resolvePartPath } from "./workbookPackage.js";
import { analyzeLedgerTemplate, readFormLabels, clearLedgerSampleInputs, scrubWorkbookResidue } from "./ledgerTemplate.js";
import { parseSharedStringsXml, readSheetCells, mapSheetCells, colToIndex, indexToCol } from "./sheetCells.js";
import { WorkbookCalculator } from "./formulaCache.js";
import { buildXlsxCellPlan } from "../xlsxCellPlan.js";
import { applyDiagonalBorders } from "../xlsxDiagonal.js";
import { assignTradeRows, freeLabelWrites } from "../tradeAttendance.js";
import {
  renderTemplateString,
  setCellInSheetXml,
  escapeXmlText,
  appendImageAnchorToDrawingXml,
  appendRelationship,
  estimateCellExtentEmu
} from "../xlsxTemplateEngine.js";
import { computeFitScalePercent } from "../../submission-output/sheetXmlWriter.js";

const DAY_MS = 86400000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  if (d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return t;
}

/** "2026-04-01" → Excelの日付シリアル値（1900年方式） */
export function isoToExcelSerial(iso) {
  const t = parseIsoDate(iso);
  return t == null ? null : Math.round((t - EXCEL_EPOCH_UTC) / DAY_MS);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((parseIsoDate(toIso) - parseIsoDate(fromIso)) / DAY_MS);
}

export function addDaysIso(iso, days) {
  const d = new Date(parseIsoDate(iso) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

function getField(model, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), model);
}

function shiftRef(ref, rowOffset) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return `${m[1]}${Number(m[2]) + rowOffset}`;
}

/**
 * 日報を頁に割り付ける（純粋関数）。
 * @returns {{ placements: Array<{entry, dayIndex, sheetIndex, pageIndex}>, lastDayIndex: number, errors: string[] }}
 */
export function planLedgerPlacement({ startDate, endDate, entries, pagesPerSheet }) {
  const errors = [];
  if (!parseIsoDate(startDate)) {
    errors.push("現場の工事開始日が設定されていません（台帳の1頁目＝工事開始日のため必須です）。現場の編集画面で工事開始日を入力してください。");
    return { placements: [], lastDayIndex: 0, errors };
  }
  const placements = [];
  const byDay = new Map();
  for (const entry of entries) {
    if (!parseIsoDate(entry.date)) {
      errors.push(`日付が正しくない日報があります（${entry.date || "日付なし"}）。`);
      continue;
    }
    const dayIndex = daysBetween(startDate, entry.date);
    if (dayIndex < 0) {
      errors.push(`工事開始日（${startDate}）より前の日付の日報があります: ${entry.date}。工事開始日を見直してください。`);
      continue;
    }
    if (byDay.has(dayIndex)) {
      errors.push(`同じ日付の日報が複数あります: ${entry.date}。台帳は1日1頁のため、どちらか1件にまとめてください。`);
      continue;
    }
    byDay.set(dayIndex, entry);
    placements.push({ entry, dayIndex, sheetIndex: Math.floor(dayIndex / pagesPerSheet), pageIndex: dayIndex % pagesPerSheet });
  }
  let lastDayIndex = placements.reduce((max, p) => Math.max(max, p.dayIndex), 0);
  if (parseIsoDate(endDate) && endDate >= startDate) lastDayIndex = Math.max(lastDayIndex, daysBetween(startDate, endDate));
  placements.sort((a, b) => a.dayIndex - b.dayIndex);
  return { placements, lastDayIndex, errors };
}

function ledgerSheetName(profile, sheetIndex) {
  const first = 1 + sheetIndex * profile.pagesPerSheet;
  return `${first}${profile.separator}${first + profile.pagesPerSheet - 1}`;
}

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

/** 複製したシートの数式が参照する「前のシート名」を付け替え、頁番号の開始値をずらす */
function retargetClonedSheet(xml, { fromPrevName, toPrevName, pageNumberShift }) {
  let out = xml.split(`${quoteSheet(fromPrevName)}!`).join(`${quoteSheet(toPrevName)}!`);
  out = out.replace(/(<pageSetup\b[^>]*\sfirstPageNumber=")(\d+)(")/, (w, a, n, b) => `${a}${Number(n) + pageNumberShift}${b}`);
  out = out.replace(/\sxr:uid="\{[^}]*\}"/g, "");
  out = out.replace(/(<sheetView\b[^>]*?)\stabSelected="1"/, "$1");
  out = out.replace(/(<sheetView\b[^>]*?)\stopLeftCell="[A-Z]+\d+"/, "$1");
  return out;
}

/**
 * 1頁（pageRows行）ごとに改ページし、1頁が用紙に収まる縮小率を設定する。
 * テンプレートに拡大縮小・改ページの指定が既にある場合は変更しない。
 */
function applyLedgerPrintLayout(sheetXml, { pageRows, pageCount, lastCol }) {
  if (/<pageSetup\b[^>]*\s(scale|fitToWidth|fitToHeight)=/.test(sheetXml) || /<rowBreaks\b/.test(sheetXml)) return { sheetXml, scale: null };
  const rowAttrs = {};
  for (let pos = 1; pos <= pageRows; pos++) {
    const m = new RegExp(`<row r="${pos}"([^>]*?)(?:/>|>)`).exec(sheetXml);
    rowAttrs[pos] = m ? m[1] : "";
  }
  const columns = [];
  for (let c = 1; c <= colToIndex(lastCol); c++) columns.push(indexToCol(c));
  const scale = computeFitScalePercent(sheetXml, { pageRows, rowAttrs, columns });
  let out = sheetXml;
  if (scale != null && scale < 100) out = out.replace(/<pageSetup\b([^>]*?)\/>/, `<pageSetup$1 scale="${scale}"/>`);
  const breaks = [];
  for (let p = 1; p < pageCount; p++) breaks.push(`<brk id="${p * pageRows}" max="16383" man="1"/>`);
  if (breaks.length) {
    const xml = `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.join("")}</rowBreaks>`;
    if (/<\/headerFooter>/.test(out)) out = out.replace("</headerFooter>", `</headerFooter>${xml}`);
    else if (/<headerFooter\b[^>]*\/>/.test(out)) out = out.replace(/(<headerFooter\b[^>]*\/>)/, `$1${xml}`);
    else out = out.replace(/(<pageSetup\b[^>]*\/>)/, `$1${xml}`);
  }
  return { sheetXml: out, scale };
}

/**
 * セルへの一括書き込み（1回の走査で置換。存在しないセルだけ個別に挿入）。
 * 数式セルには書き込まず、skippedFormulaCellsとして返す。
 */
function writeCells(sheetXml, sharedStrings, writes) {
  const pending = new Map(writes.map((w) => [w.cell, w]));
  const skippedFormulaCells = [];
  let out = mapSheetCells(sheetXml, sharedStrings, (cell) => {
    const ref = `${cell.col}${cell.row}`;
    const w = pending.get(ref);
    if (!w) return undefined;
    pending.delete(ref);
    if (cell.formula) {
      skippedFormulaCells.push(ref);
      return undefined;
    }
    const s = cell.style != null ? ` s="${cell.style}"` : "";
    if (w.numeric && w.value !== "" && w.value != null && Number.isFinite(Number(w.value))) return `<c r="${ref}"${s}><v>${Number(w.value)}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(w.value)}</t></is></c>`;
  });
  for (const w of pending.values()) out = setCellInSheetXml(out, w.cell, w.value, { numeric: w.numeric });
  return { sheetXml: out, skippedFormulaCells };
}

async function drawingPartsOf(pkg, sheetPath) {
  const relsPath = sheetPath.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels";
  const rel = parseRelationships(await pkg.getText(relsPath)).find((r) => r.type.endsWith("/drawing"));
  if (!rel) return null;
  const drawingPath = resolvePartPath(sheetPath, rel.target);
  const drawingRelsPath = drawingPath.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels";
  return {
    drawingPath,
    drawingRelsPath,
    drawingXml: await pkg.getText(drawingPath),
    drawingRelsXml:
      (await pkg.getText(drawingRelsPath)) ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  };
}

/**
 * @param {object} params
 * @param {ArrayBuffer} params.templateBuffer 原本テンプレート（読み取り専用）
 * @param {object} params.mapping 台帳マッピング（ANZEN_EISEI_LEDGER_MAPPING等）
 * @param {{name, startDate, endDate}} params.site 帳票用の現場情報（reportDataAdapterのsite）
 * @param {Array<{date: string, model: object}>} params.entries 日報ごとの帳票用モデル
 * @returns {Promise<{blob, filename, sheetNames, pageCount, placedCount, firstDate, lastDate, warnings, sanitized, printScale}>}
 */
export async function renderLedgerWorkbook({ templateBuffer, mapping, site, entries }) {
  const warnings = [];
  const pkg = await WorkbookPackage.open(templateBuffer);
  const profile = await analyzeLedgerTemplate(pkg);
  if (!profile) throw new Error("この帳票テンプレートには台帳シート（「1～20」のような名前のシート）がありません。台帳出力はできません。");

  const { placements, lastDayIndex, errors } = planLedgerPlacement({
    startDate: site.startDate,
    endDate: site.endDate,
    entries,
    pagesPerSheet: profile.pagesPerSheet
  });
  if (errors.length) throw new Error(`台帳を作成できません。\n・${errors.join("\n・")}`);

  const { anchor } = mapping;
  const base = profile.ledgerSheets[0];

  // 2. 他工事データ除去（全台帳シート）
  const sharedStrings = parseSharedStringsXml(await pkg.getText("xl/sharedStrings.xml"));
  const formLabels = await readFormLabels(pkg, profile.formSheet, profile.pageRows);
  let clearedCount = 0;
  for (const sheet of profile.ledgerSheets) {
    const r = clearLedgerSampleInputs(await pkg.getText(sheet.path), {
      sharedStrings,
      formLabels,
      pageRows: profile.pageRows,
      pagesPerSheet: profile.pagesPerSheet
    });
    pkg.setText(sheet.path, r.sheetXml);
    clearedCount += r.clearedCount;
  }

  // 起点セルが数式でないこと（数式なら書き込めない＝様式が想定と違う）
  const baseCells = readSheetCells(await pkg.getText(base.path), sharedStrings);
  for (const ref of [anchor.projectNameCell, anchor.workDateCell, anchor.meetingDateCell]) {
    if (baseCells.get(ref)?.formula) throw new Error(`台帳の起点セル${ref}に数式が入っているため、書き込めません（様式が想定と異なります）。`);
  }

  // 3. 必要なシート数に合わせる
  const neededSheets = Math.floor(lastDayIndex / profile.pagesPerSheet) + 1;
  const sheetNames = profile.ledgerSheets.map((s) => s.name);
  if (neededSheets < sheetNames.length) {
    for (const name of sheetNames.slice(neededSheets).reverse()) await pkg.removeSheet(name);
    sheetNames.length = neededSheets;
  } else if (neededSheets > sheetNames.length) {
    if (sheetNames.length < 2) throw new Error("台帳シートが1枚しかない様式のため、自動で追加できません。");
    const source = sheetNames[sheetNames.length - 1];
    const sourcePrev = sheetNames[sheetNames.length - 2];
    const sourceIndex = sheetNames.length - 1;
    for (let k = sheetNames.length; k < neededSheets; k++) {
      const newName = ledgerSheetName(profile, k);
      const prevName = sheetNames[k - 1];
      await pkg.cloneSheet(source, newName, prevName, (xml) =>
        retargetClonedSheet(xml, { fromPrevName: sourcePrev, toPrevName: prevName, pageNumberShift: (k - sourceIndex) * profile.pagesPerSheet })
      );
      sheetNames.push(newName);
      warnings.push(`工事期間が${profile.ledgerSheets.length * profile.pagesPerSheet}日を超えるため、台帳シート「${newName}」を追加しました（「${source}」を複製）。`);
    }
  }

  const sheets = await pkg.listSheets();
  const pathOf = (name) => sheets.find((s) => s.name === name).path;

  // 印刷範囲（最後のシートは工事最終日の頁まで）・改ページ・縮小率
  const lastSheetPages = (lastDayIndex % profile.pagesPerSheet) + 1;
  let printScale = null;
  for (let k = 0; k < sheetNames.length; k++) {
    const pages = k === sheetNames.length - 1 ? lastSheetPages : profile.pagesPerSheet;
    await pkg.setPrintArea(sheetNames[k], `$${profile.firstCol}$1:$${profile.lastCol}$${pages * profile.pageRows}`);
    const applied = applyLedgerPrintLayout(await pkg.getText(pathOf(sheetNames[k])), {
      pageRows: profile.pageRows,
      pageCount: pages,
      lastCol: profile.lastCol
    });
    pkg.setText(pathOf(sheetNames[k]), applied.sheetXml);
    if (applied.scale != null) printScale = applied.scale;
  }

  // 4. 起点
  const startSerial = isoToExcelSerial(site.startDate);

  // 4-2. 各頁の日付を暦日（工事開始日＋頁番号）にそろえる
  //   原本の先頭シートは2頁目以降が「前頁の作業日＋n」の数式だが、前の工事で土日を
  //   飛ばすよう手修正され（+3/+2）、前々頁を参照している頁もあった。暦日で頁を
  //   決める台帳ではその値は前工事の予定そのものなので、数式のまま「前頁＋1」
  //   （打合日は「前頁の作業日」）に統一する（数式を値に置き換えることはしない）。
  //   2枚目以降のシートは日付欄が空の入力欄（数式なし）なので、日付を値で書く。
  const dateChain = { rewrittenFormulas: 0, writtenValues: 0 };
  for (let k = 0; k < sheetNames.length; k++) {
    const name = sheetNames[k];
    const xml = await pkg.getText(pathOf(name));
    const cells = readSheetCells(xml, sharedStrings);
    const formulaRewrites = new Map();
    const valueWrites = [];
    for (let p = 0; p < profile.pagesPerSheet; p++) {
      const dayIndex = k * profile.pagesPerSheet + p;
      if (dayIndex === 0 || dayIndex > lastDayIndex) continue;
      const rowOffset = p * profile.pageRows;
      const prevWork = p > 0 ? shiftRef(anchor.workDateCell, rowOffset - profile.pageRows) : null;
      for (const [cellRef, pattern, text, value] of [
        [anchor.workDateCell, /^\$?[A-Z]+\$?\d+\+\d+$/, prevWork && `${prevWork}+1`, startSerial + dayIndex],
        [anchor.meetingDateCell, /^\$?[A-Z]+\$?\d+$/, prevWork, startSerial + dayIndex + (anchor.meetingDateOffsetDays ?? -1)]
      ]) {
        const ref = shiftRef(cellRef, rowOffset);
        const cell = cells.get(ref);
        if (cell?.formula) {
          if (!text || cell.formula.shared || !pattern.test(cell.formula.text)) {
            throw new Error(`台帳「${name}」${ref}の日付の数式（${cell.formula.text || "共有数式"}）が想定外の形のため、日付を暦日にそろえられません。`);
          }
          if (cell.formula.text !== text) formulaRewrites.set(ref, text);
        } else {
          valueWrites.push({ cell: ref, value, numeric: true });
        }
      }
    }
    let next = mapSheetCells(xml, sharedStrings, (cell, original) => {
      const text = formulaRewrites.get(`${cell.col}${cell.row}`);
      if (!text) return undefined;
      return original.replace(/(<f\b[^>]*>)[\s\S]*?(<\/f>)/, `$1${escapeXmlText(text)}$2`);
    });
    next = writeCells(next, sharedStrings, valueWrites).sheetXml;
    if (next !== xml) pkg.setText(pathOf(name), next);
    dateChain.rewrittenFormulas += formulaRewrites.size;
    dateChain.writtenValues += valueWrites.length;
  }
  const anchorWrites = [
    { cell: anchor.projectNameCell, value: renderTemplateString(anchor.projectNameTemplate || "{site.name}", { site }), numeric: false },
    { cell: anchor.workDateCell, value: startSerial, numeric: true },
    { cell: anchor.meetingDateCell, value: startSerial + (anchor.meetingDateOffsetDays ?? -1), numeric: true }
  ];
  const writesBySheet = new Map([[sheetNames[0], [...anchorWrites]]]);

  // 5. 日報ごとの書き込み
  const imagesBySheet = new Map();
  const diagonalsBySheet = new Map(); // 巡回点検の欄の斜線（休工日・作業なし・事務作業日で点検記録が無い日の頁だけ）
  const pageCfgBase = mapping.page;
  // 稼動人数表の業種の行の割り当ては、台帳全体（全頁）で固定する（累計の数式が前頁の同じ行を参照するため）
  const tradeAssignment = pageCfgBase.tradeAttendance
    ? assignTradeRows(pageCfgBase.tradeAttendance, placements.filter(({ entry }) => (entry.model.report?.dayStatus || "work") === "work").map(({ entry }) => ({ date: entry.date, companies: entry.model.companies || [] })))
    : null;
  // 空き行の業種名は台帳の最初の頁（先頭シートの1頁目）にだけ書く。2頁目以降は様式の数式が前の頁の業種名を映す
  if (tradeAssignment) writesBySheet.get(sheetNames[0]).push(...freeLabelWrites(pageCfgBase.tradeAttendance, tradeAssignment));
  for (const { entry, sheetIndex, pageIndex } of placements) {
    const model = entry.model;
    const rowOffset = pageIndex * profile.pageRows;
    const cfg = {
      sheetName: sheetNames[sheetIndex],
      templates: (pageCfgBase.templates || []).filter((t) => (t.requires || []).every((path) => {
        const v = getField(model, path);
        return v != null && String(v).trim() !== "";
      })),
      companiesTable: pageCfgBase.companiesTable,
      patrolChecklist: pageCfgBase.patrolChecklist,
      staffAttendance: pageCfgBase.staffAttendance,
      tradeAttendance: pageCfgBase.tradeAttendance,
      textLines: pageCfgBase.textLines,
      deliveriesAmPm: pageCfgBase.deliveriesAmPm
    };
    const plan = buildXlsxCellPlan(tradeAssignment ? { ...model, attendance: { assignment: tradeAssignment } } : model, cfg);
    for (const w of plan.warnings) warnings.push(`${entry.date}: ${w}`);
    const list = writesBySheet.get(cfg.sheetName) || [];
    for (const w of plan.cellWrites) list.push({ ...w, cell: shiftRef(w.cell, rowOffset), date: entry.date });
    writesBySheet.set(cfg.sheetName, list);
    if (plan.diagonalCells?.length) {
      const list = diagonalsBySheet.get(cfg.sheetName) || [];
      for (const ref of plan.diagonalCells) list.push(shiftRef(ref, rowOffset));
      diagonalsBySheet.set(cfg.sheetName, list);
    }
    if (plan.images.length) {
      const imgs = imagesBySheet.get(cfg.sheetName) || [];
      for (const img of plan.images) imgs.push({ ...img, cell: shiftRef(img.cell, rowOffset) });
      imagesBySheet.set(cfg.sheetName, imgs);
    }
  }

  // 稼動人数表「社員」行（監督・職員）の累計: 全頁（日報の無い日を含む）に、工事開始からその日までの合計を書く。
  // 当日の人数（O50）は日報のある頁だけ（buildXlsxCellPlan の staffAttendance.headcountCell）。休工日は0人（dailyFlow.js）
  const staffCumCell = pageCfgBase.staffAttendance?.cumulativeCell;
  if (staffCumCell) {
    const staffByDay = new Map(placements.map(({ entry, dayIndex }) => [dayIndex, Number(entry.model.report?.siteSupervisorCount) || 0]));
    let cum = 0;
    for (let d = 0; d <= lastDayIndex; d++) {
      cum += staffByDay.get(d) || 0;
      const sheetName = sheetNames[Math.floor(d / profile.pagesPerSheet)];
      if (!sheetName) continue;
      const list = writesBySheet.get(sheetName) || [];
      list.push({ cell: shiftRef(staffCumCell, (d % profile.pagesPerSheet) * profile.pageRows), value: cum, numeric: true });
      writesBySheet.set(sheetName, list);
    }
  }

  for (const [name, writes] of writesBySheet) {
    const { sheetXml, skippedFormulaCells } = writeCells(await pkg.getText(pathOf(name)), sharedStrings, writes);
    pkg.setText(pathOf(name), sheetXml);
    for (const ref of skippedFormulaCells) warnings.push(`「${name}」の${ref}は数式のセルのため書き込みませんでした（マッピングを確認してください）。`);
  }
  if (diagonalsBySheet.size) {
    let stylesXml = await pkg.getText("xl/styles.xml");
    const cache = new Map();
    for (const [name, cells] of diagonalsBySheet) {
      const d = applyDiagonalBorders({ sheetXml: await pkg.getText(pathOf(name)), stylesXml, cells, cache });
      pkg.setText(pathOf(name), d.sheetXml);
      stylesXml = d.stylesXml;
      if (d.missing.length) warnings.push(`「${name}」で斜線を付けるセルが見つかりませんでした: ${d.missing.slice(0, 5).join("・")}${d.missing.length > 5 ? " ほか" : ""}`);
    }
    pkg.setText("xl/styles.xml", stylesXml);
  }

  // 職長サイン画像（手書印刷用と同じH列）
  let imageCounter = 0;
  let addedPng = false;
  for (const [name, images] of imagesBySheet) {
    const sheetPath = pathOf(name);
    const parts = await drawingPartsOf(pkg, sheetPath);
    if (!parts) {
      warnings.push(`「${name}」に図形パートが無いため、職長サインを貼り付けられませんでした。`);
      continue;
    }
    const sheetXml = await pkg.getText(sheetPath);
    for (const { cell, blob, company } of images) {
      imageCounter += 1;
      const mediaPath = `xl/media/ledgerSignature${imageCounter}.png`;
      const relId = `rIdLedgerSignature${imageCounter}`;
      pkg.setBytes(mediaPath, new Uint8Array(await blob.arrayBuffer()));
      addedPng = true;
      parts.drawingRelsXml = appendRelationship(parts.drawingRelsXml, {
        id: relId,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
        target: `../media/${mediaPath.split("/").pop()}`
      });
      const m = /^([A-Z]+)(\d+)$/.exec(cell);
      const col = colToIndex(m[1]) - 1;
      const row = Number(m[2]) - 1;
      parts.drawingXml = appendImageAnchorToDrawingXml(parts.drawingXml, {
        fromCellRef: cell,
        toCellRef: `${indexToCol(col + 2)}${row + 2}`,
        relationshipId: relId,
        shapeId: 20000 + imageCounter,
        shapeName: `foreman-signature-${company?.id || imageCounter}`,
        extentEmu: estimateCellExtentEmu(sheetXml, m[1], Number(m[2]))
      });
    }
    pkg.setText(parts.drawingPath, parts.drawingXml);
    pkg.setText(parts.drawingRelsPath, parts.drawingRelsXml);
  }
  if (addedPng) {
    let ct = await pkg.getText("[Content_Types].xml");
    if (!/<Default Extension="png"/i.test(ct)) ct = ct.replace("</Types>", `<Default Extension="png" ContentType="image/png"/></Types>`);
    pkg.setText("[Content_Types].xml", ct);
  }

  // 6. 数式の表示値を計算し直す（数式は残す）
  const calculator = new WorkbookCalculator(pkg);
  await calculator.init();
  for (const name of sheetNames) await calculator.writeCaches(name);
  for (const u of calculator.unsupported) warnings.push(`「${u.sheet}」${u.ref}の数式（${u.formula}）は表示値を計算できないため、Excelで開いたときの再計算に任せます。`);

  // 7. 様式シート（1日分の手書き用の白紙）は台帳には不要なので外す。
  //    台帳シートの数式が参照している場合だけ残す（#REF!防止）。
  let removedFormSheet = false;
  const formRefs = [`'${profile.formSheet.name.replace(/'/g, "''")}'!`, `${profile.formSheet.name}!`];
  let formReferenced = false;
  for (const name of sheetNames) {
    const xml = await pkg.getText(pathOf(name));
    if ([...xml.matchAll(/<f\b[^>]*>([^<]*)<\/f>/g)].some((m) => formRefs.some((r) => m[1].includes(r)))) formReferenced = true;
  }
  if (!formReferenced) {
    await pkg.removeSheet(profile.formSheet.name);
    removedFormSheet = true;
  }

  // 8. 残留情報の除去・開いたときに先頭の台帳シートを表示
  await pkg.setActiveSheet(sheetNames[0]);
  const residue = await scrubWorkbookResidue(pkg);

  const firstDate = site.startDate;
  const lastDate = addDaysIso(site.startDate, lastDayIndex);
  const filename = `${site.name || "現場"}_安全衛生作業打合日誌_台帳_${firstDate}〜${lastDate}.xlsx`;
  return {
    blob: await pkg.toCompressedBlob(),
    filename,
    sheetNames,
    pageCount: lastDayIndex + 1,
    placedCount: placements.length,
    firstDate,
    lastDate,
    warnings,
    printScale,
    dateChain,
    sanitized: { clearedSampleCells: clearedCount, removedFormSheet, ...residue }
  };
}
