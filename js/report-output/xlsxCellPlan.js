/* ==========================================================
   マッピング（templates/companiesTable/patrolChecklist）から
   「どのセルに何を書き込むか」を計算する共通ロジック。
   Excelバイナリへの書き込み(excelXlsxTemplate.js)とPDF-HTML化
   (companyPdfFromXlsx.js)の両方がこの計画（プラン）を消費する。
   セル位置の解釈をここ1箇所に集約することで、Excel出力とPDF出力の
   セル割り当てがずれることを防ぐ。
   ========================================================== */

import { renderTemplateString } from "./xlsxTemplateEngine.js";
import { assignTradeRows, buildTradeAttendanceWrites } from "./tradeAttendance.js";

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
    const assignment = model.attendance.assignment || assignTradeRows(trade, model.attendance.siteReports || []);
    const r = buildTradeAttendanceWrites(trade, {
      assignment,
      // 作業なし・休工日の日報は、その日の人数に数えない（累計はそれまでの通常作業の日の合計）
      todayCompanies: (model.report.dayStatus || "work") === "work" ? model.companies || [] : [],
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
  }

  return { cellWrites, images, fitToPage: cfg.fitToPage || null, sheetName: cfg.sheetName, warnings };
}

function parseCellRefRow(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`不正なセル参照です: ${ref}`);
  return { row: Number(m[2]) - 1 };
}
