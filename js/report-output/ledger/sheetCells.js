/* ==========================================================
   シートXMLのセルを正規表現で走査・書き換えする部品（DOM非依存）
   台帳出力・他工事データ除去・数式の表示値計算で共有する。
   セル要素以外（行の高さ・書式・結合・印刷設定など）には触れない。
   ========================================================== */

import { decodeXmlText } from "./workbookPackage.js";

export const CELL_RE = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function indexToCol(index) {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** sharedStrings.xmlの各<si>を表示文字列（ふりがな<rPh>を除く）の配列で返す */
export function parseSharedStringsXml(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => {
    const body = (m[1] || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join("");
  });
}

/**
 * セル要素1つを解析する。
 * @returns {{col, row, attrs, body, style, type, formula: {text, shared, si, ref}|null, value: string|null}}
 */
export function parseCell(match, sharedStrings) {
  const [, col, rowText, attrs, body = ""] = match;
  const type = /\st="(\w+)"/.exec(attrs)?.[1] ?? null;
  const style = /\ss="(\d+)"/.exec(attrs)?.[1] ?? null;
  let formula = null;
  const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
  if (fm) {
    formula = {
      text: fm[2] != null ? decodeXmlText(fm[2]) : "",
      shared: /\st="shared"/.test(fm[1]),
      si: /\ssi="(\d+)"/.exec(fm[1])?.[1] ?? null,
      ref: /\sref="([^"]+)"/.exec(fm[1])?.[1] ?? null
    };
  }
  let value = null;
  if (type === "inlineStr") {
    value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join("");
  } else {
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    if (v != null) value = type === "s" ? sharedStrings[Number(v)] ?? "" : decodeXmlText(v);
  }
  return { col, row: Number(rowText), attrs, body, style, type, formula, value };
}

/** シートXML中の全セルをMap<"A1", parsedCell>で返す */
export function readSheetCells(sheetXml, sharedStrings) {
  const cells = new Map();
  for (const m of sheetXml.matchAll(CELL_RE)) {
    const cell = parseCell(m, sharedStrings);
    cells.set(`${cell.col}${cell.row}`, cell);
  }
  return cells;
}

/**
 * 全セルを走査し、置換関数が返した文字列でセル要素を差し替える（undefinedなら元のまま）。
 * @param {(cell: object, original: string) => string|undefined} replacer
 */
export function mapSheetCells(sheetXml, sharedStrings, replacer) {
  return sheetXml.replace(CELL_RE, (...args) => {
    const original = args[0];
    const cell = parseCell(args, sharedStrings);
    const next = replacer(cell, original);
    return next === undefined ? original : next;
  });
}

/** 値を消した空セル（書式sは維持） */
export function emptyCellXml(cell) {
  return cell.style != null ? `<c r="${cell.col}${cell.row}" s="${cell.style}"/>` : `<c r="${cell.col}${cell.row}"/>`;
}

/** シートXMLで参照されている共有文字列のインデックス集合 */
export function collectSharedStringRefs(sheetXml, into = new Set()) {
  for (const m of sheetXml.matchAll(/<c r="[A-Z]+\d+"[^>]*?\st="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>/g)) into.add(Number(m[1]));
  return into;
}
