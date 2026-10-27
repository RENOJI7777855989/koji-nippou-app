/* ==========================================================
   マッピング（templates/companiesTable/patrolChecklist）から
   「どのセルに何を書き込むか」を計算する共通ロジック。
   Excelバイナリへの書き込み(excelXlsxTemplate.js)とPDF-HTML化
   (companyPdfFromXlsx.js)の両方がこの計画（プラン）を消費する。
   セル位置の解釈をここ1箇所に集約することで、Excel出力とPDF出力の
   セル割り当てがずれることを防ぐ。
   ========================================================== */

import { renderTemplateString } from "./xlsxTemplateEngine.js";
import { assignTradeRowsForDay, buildTradeAttendanceWrites } from "./tradeAttendance.js";
import { patrolSlashApplies } from "../patrolChecklist.js";
import { DAY_STATUSES, dayStatusOf } from "../dashboard/dailyFlow.js";
import { expandRange } from "./xlsxAlign.js";

/**
 * @returns {{
 *   cellWrites: Array<{cell: string, value: string, numeric: boolean}>,
 *   images: Array<{cell: string, blob: Blob, company: object}>,
 *   fitToPage: object|null,
 *   sheetName: string,
 *   warnings: string[]
 * }}
 */
export function buildXlsxCellPlan(model, cfg) {
  const cellWrites = [];
  const images = [];
  const diagonalCells = []; // 斜線にするセル（巡回点検の欄。出力時に罫線として付ける。xlsxDiagonal.js）
  const warnings = [];

  (cfg.templates || []).forEach(({ cell, template }) => {
    cellWrites.push({ cell, value: renderTemplateString(template, model), numeric: false });
  });

  const table = cfg.companiesTable;
  if (table) {
    const companies = model.companies || [];
    const maxRows = table.maxRows || companies.length;
    const rowStep = table.rowStep || 1;
    const maxCompanies = Math.floor((maxRows - 1) / rowStep) + 1;
    if (companies.length > maxCompanies) {
      const overflowMsg = `帳票テンプレート「${cfg.sheetName}」は${maxCompanies}社までのため、業者${companies.length}件のうち${companies.length - maxCompanies}件が出力されません。`;
      console.warn(overflowMsg);
      warnings.push(overflowMsg);
    }

    const { row: startRow0 } = parseCellRefRow(table.startCell);

    for (let i = 0; i < Math.min(companies.length, maxCompanies); i++) {
      const company = companies[i];
      const rowNum = startRow0 + i * rowStep + 1;

      for (const [fieldKey, colDef] of Object.entries(table.columns || {})) {
        const colLetter = typeof colDef === "string" ? colDef : colDef.column;
        const numeric = typeof colDef === "object" && !!colDef.numeric;
        const value = company[fieldKey];
        if (value === "" || value == null) continue;
        cellWrites.push({ cell: `${colLetter}${rowNum}`, value, numeric });
      }

      if (table.signatureColumn && company.signature?.blob) {
        images.push({ cell: `${table.signatureColumn}${rowNum}`, blob: company.signature.blob, company });
      }
    }
  }

  // 日の状態（現場作業なし・休工日・雨天作業不可日・事務作業日）を、協力会社欄の決まった業者の行（03-2は2業者目）の
  // 作業内容の欄に書く（2026-10-27。利用者の指定）。表示名は日報カレンダーと同じ（dailyFlow.js の DAY_STATUSES）。
  // その欄に業者の作業内容があれば消さずに、後ろへ全角の空白で区切って足す。雨天作業不可日の中止作業・理由、事務作業日の内容は、
  // 同じ業者の欄の下の行（03-2は E10。業者の欄は2行で、間に罫線が無い）に書く（1行に詰めると欄の幅を超えるため）。通常作業の日は書かない
  const note = cfg.dayStatusNote;
  if (note && table) {
    const { label, detail } = dayStatusNoteText(model.report, note);
    const colDef = table.columns?.[note.field];
    const col = typeof colDef === "string" ? colDef : colDef?.column;
    if (label && col) {
      const row = parseCellRefRow(table.startCell).row + 1 + (note.companyIndex || 0) * (table.rowStep || 1);
      const put = (cell, text) => {
        const existing = cellWrites.find((w) => w.cell === cell);
        if (existing) existing.value = `${existing.value}　${text}`;
        else cellWrites.push({ cell, value: text, numeric: false });
      };
      put(`${col}${row}`, label);
      if (detail) put(`${col}${row + (note.detailRowOffset ?? 1)}`, detail);
    }
  }

  // 稼働人数表の「現場監督(社員)」行。人数欄には当日在席した現場監督の
  // 人数（同じ日に複数名いる場合はその件数）、累計欄には現場の全日報から
  // 合計した延べ人数（呼び出し側で計算済み）を書く。当日データが無い
  // （0人）場合は人数欄は元の空欄を維持し書き込まない。
  const staffAttendance = cfg.staffAttendance;
  if (staffAttendance) {
    if (staffAttendance.headcountCell && model.report.siteSupervisorCount > 0) {
      cellWrites.push({ cell: staffAttendance.headcountCell, value: model.report.siteSupervisorCount, numeric: true });
    }
    if (staffAttendance.cumulativeCell && model.report.cumulativeSiteSupervisorCount != null) {
      cellWrites.push({ cell: staffAttendance.cumulativeCell, value: model.report.cumulativeSiteSupervisorCount, numeric: true });
    }
  }

  // 稼動人数表の業種別の人数・累計・計・延労働時間（tradeAttendance.js）。台帳シートは累計等が数式なので人数と業種名だけ
  const trade = cfg.tradeAttendance;
  if (trade && model.attendance) {
    // 作業なし・休工日の日報は、その日の人数に数えない（累計はそれまでの通常作業の日の合計）
    const todayCompanies = (model.report.dayStatus || "work") === "work" ? model.companies || [] : [];
    // 台帳は頁をまたいで同じ行にする割り当てを渡す。1日分は、その日に稼働した業種を先に空き行へ（assignTradeRowsForDay）
    const assignment = model.attendance.assignment || assignTradeRowsForDay(trade, { todayCompanies, historyReports: model.attendance.historyReports || [] });
    const r = buildTradeAttendanceWrites(trade, {
      assignment,
      todayCompanies,
      historyReports: model.attendance.historyReports || [],
      supervisorsToday: model.report.siteSupervisorCount || 0,
      supervisorsCumulative: model.report.cumulativeSiteSupervisorCount || 0,
      cumulative: trade.cumulative !== false,
      writeLabels: trade.cumulative !== false // 台帳は最初の頁にだけ書く（renderLedgerWorkbook.js）
    });
    cellWrites.push(...r.writes);
    warnings.push(...r.warnings);
  }

  // 複数行の文章（本日の重点指示・作業間の連絡・調整）を、様式の罫線の行ごとに1行ずつ書く。
  // 行が足りなければ、残りは最後の行につなげる（消さない）
  for (const { path, cells } of cfg.textLines || []) {
    const text = String(path.split(".").reduce((o, k) => o?.[k], model) || "").trim();
    if (!text) continue;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = lines.slice(0, cells.length - 1);
    const rest = lines.slice(cells.length - 1);
    if (rest.length) out.push(rest.join("　"));
    out.forEach((line, i) => cellWrites.push({ cell: cells[i], value: line, numeric: false }));
  }

  // 資材・機材搬入（ＡＭ／ＰＭ）: ダッシュボードの「本日の搬入・搬出」と同じ内容（搬入・搬出の両方、中止も含む）を、
  // 時刻で午前・午後に分けて1件1行で書く（「時刻 搬入/搬出 品名 数量（業者）」、中止は末尾に「（中止）」）。
  // 行が足りなければ最後の行に「ほかn件」
  const dl = cfg.deliveriesAmPm;
  if (dl && Array.isArray(model.report.deliveries)) {
    const items = [...model.report.deliveries].sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time || "").localeCompare(b.time || ""));
    const line = (d) =>
      [d.time, d.direction === "out" ? "搬出" : "搬入", [d.item, d.quantity].filter(Boolean).join(" ")].filter(Boolean).join(" ") +
      (d.vendor ? `（${d.vendor}）` : "") +
      (d.status === "cancelled" ? "（中止）" : "");
    const put = (list, cells) => {
      const shown = list.slice(0, cells.length);
      shown.forEach((d, i) => cellWrites.push({ cell: cells[i], value: line(d), numeric: false }));
      if (list.length > cells.length) {
        const last = cells.length - 1;
        cellWrites[cellWrites.length - 1] = { cell: cells[last], value: `${line(list[last])}　ほか${list.length - cells.length}件`, numeric: false };
        warnings.push(`搬入・搬出が${list.length}件あり、様式の${cells.length}行に収まらないため「ほか${list.length - cells.length}件」と書きました`);
      }
    };
    const noon = dl.noonTime || "12:00";
    put(items.filter((d) => d.time && d.time < noon), dl.amCells);
    put(items.filter((d) => !d.time || d.time >= noon), dl.pmCells);
  }

  const patrolChecklist = cfg.patrolChecklist;
  if (patrolChecklist) {
    const marks = {
      good: patrolChecklist.goodMark ?? "○",
      bad: patrolChecklist.badMark ?? "×",
      na: patrolChecklist.naMark ?? "－"
    };
    const answers = model.report.patrolChecklist || {};
    for (const [itemKey, cellRef] of Object.entries(patrolChecklist.itemCells || {})) {
      const mark = marks[answers[itemKey]];
      if (!mark) continue;
      cellWrites.push({ cell: cellRef, value: mark, numeric: false });
    }
    if (patrolChecklist.commentCell && model.report.patrolComment) {
      cellWrites.push({ cell: patrolChecklist.commentCell, value: model.report.patrolComment, numeric: false });
    }
    // 休工日・作業なし・事務作業日で実際の点検記録が無い日は、巡回点検の欄（○×のセル）を斜線にする。
    // 「未実施」の文字は書かない。日報が無い日（この関数は呼ばれない）・記録がある日・通常作業の日は斜線にしない
    if (patrolSlashApplies(model.report)) diagonalCells.push(...(patrolChecklist.slashCells || Object.values(patrolChecklist.itemCells || {})));
  }

  // 中央揃え・右揃えにするセル（出力時に書式として付ける。xlsxAlign.js）
  const centerCells = (cfg.centerAlignRanges || []).flatMap(expandRange);
  const rightCells = (cfg.rightAlignRanges || []).flatMap(expandRange);
  return { cellWrites, images, diagonalCells, centerCells, rightCells, fitToPage: cfg.fitToPage || null, sheetName: cfg.sheetName, warnings };
}

/**
 * 日の状態の表示の文字。label＝「【現場作業なし】」など（日報カレンダーと同じ表示名）、detail＝雨天作業不可日の中止作業・理由、
 * 事務作業日の内容（無ければ ""）。通常作業・知らない値の日は label も ""
 */
export function dayStatusNoteText(report, note) {
  const status = dayStatusOf(report);
  if (!(note?.statuses || []).includes(status)) return { label: "", detail: "" };
  const label = `【${DAY_STATUSES.find((s) => s.value === status).label}】`;
  const one = (v) => String(v || "").replace(/\s*\r?\n\s*/g, "　").trim();
  const parts = [];
  if (status === "rain") {
    if (one(report.rainCancelledWork)) parts.push(`中止作業：${one(report.rainCancelledWork)}`);
    if (one(report.rainReason)) parts.push(`理由：${one(report.rainReason)}`);
  }
  // 事務作業日の内容は、登録画面の「連絡事項・事務作業の内容」（remarks）。無ければ監督・職員の作業内容（staffWork）
  if (status === "office" && one(report.remarks || report.staffWork)) parts.push(`内容：${one(report.remarks || report.staffWork)}`);
  return { label, detail: parts.join("　") };
}

function parseCellRefRow(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`不正なセル参照です: ${ref}`);
  return { row: Number(m[2]) - 1 };
}
