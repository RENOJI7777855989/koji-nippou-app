/* ==========================================================
   数式の表示値（キャッシュ<v>）の再計算（数式<f>は一切変更しない）
   Excelは開いたときに再計算する（fullCalcOnLoad）が、LibreOfficeの
   既定設定や、アプリ内のPDF化（セルの値をそのまま描画）はキャッシュ値を
   そのまま表示するため、前の工事の工事名・日付・累計が残ってしまう。
   そこで、テンプレートに実際に使われている範囲の数式だけを評価できる
   小さな計算器を持ち、表示値を正しい値に置き換える。

   対応する式（台帳テンプレートで使われているもの）:
     セル参照（シート名付き・$付き）、範囲（暗黙の交差で1セルに解決）、
     数値・文字列定数、+ - * /、比較 = <> < > <= >=、&、
     IF(条件,真,偽)、SUM(範囲…)、#REF!等のエラー値
   これ以外の関数が出てきた場合は、その数式のキャッシュ値は変更せず
   unsupportedとして報告する（推測で値を作らない）。
   ========================================================== */

import { parseSharedStringsXml, readSheetCells, mapSheetCells, colToIndex, indexToCol } from "./sheetCells.js";
import { escapeXmlText } from "../xlsxTemplateEngine.js";

class FormulaError {
  constructor(code) {
    this.code = code;
  }
}
const ERR_VALUE = new FormulaError("#VALUE!");
const ERR_REF = new FormulaError("#REF!");
class Unsupported extends Error {}

const REF_RE = /((?:'(?:[^']|'')+'|[^\s'!(),=+\-*/&<>":$]+)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g;

/** 共有数式の親の式を、子セルの位置へずらす（$付きの軸はずらさない） */
export function shiftFormula(text, dRow, dCol) {
  if (!dRow && !dCol) return text;
  let out = "";
  // 文字列定数の中はずらさない
  const parts = text.split(/("(?:[^"]|"")*")/);
  for (const part of parts) {
    if (part.startsWith('"')) {
      out += part;
      continue;
    }
    out += part.replace(REF_RE, (whole, prefix = "", colAbs, col, rowAbs, row) => {
      const newCol = colAbs ? col : indexToCol(colToIndex(col) + dCol);
      const newRow = rowAbs ? row : String(Number(row) + dRow);
      return `${prefix}${colAbs}${newCol}${rowAbs}${newRow}`;
    });
  }
  return out;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += text[j++];
      }
      tokens.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const err = /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.exec(text.slice(i));
    if (err) {
      tokens.push({ t: "err", v: new FormulaError(err[0]) });
      i += err[0].length;
      continue;
    }
    const ref = /^((?:'(?:[^']|'')+'|[^\s'!(),=+\-*/&<>":$]+)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(?![\d(A-Za-z_])/.exec(text.slice(i));
    if (ref) {
      let sheet = null;
      if (ref[1]) {
        const raw = ref[1].slice(0, -1);
        sheet = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
      }
      tokens.push({ t: "ref", sheet, a: ref[2].replace(/\$/g, ""), b: ref[3] ? ref[3].replace(/\$/g, "") : null });
      i += ref[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      tokens.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const fn = /^([A-Z][A-Z0-9.]*)\(/.exec(text.slice(i));
    if (fn) {
      tokens.push({ t: "fn", v: fn[1] });
      i += fn[1].length;
      continue;
    }
    const op = /^(<>|<=|>=|[+\-*/=<>&(),])/.exec(text.slice(i));
    if (op) {
      tokens.push({ t: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new Unsupported(`解釈できない式: ${text}`);
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expectOp = (v) => {
    const tok = next();
    if (!tok || tok.t !== "op" || tok.v !== v) throw new Unsupported(`「${v}」が必要です`);
  };

  function comparison() {
    let left = concat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) {
      const op = next().v;
      left = { k: "bin", op, left, right: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (peek()?.t === "op" && peek().v === "&") {
      next();
      left = { k: "bin", op: "&", left, right: additive() };
    }
    return left;
  }
  function additive() {
    let left = term();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      left = { k: "bin", op, left, right: term() };
    }
    return left;
  }
  function term() {
    let left = unary();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = next().v;
      left = { k: "bin", op, left, right: unary() };
    }
    return left;
  }
  function unary() {
    if (peek()?.t === "op" && (peek().v === "-" || peek().v === "+")) {
      const op = next().v;
      const operand = unary();
      return op === "-" ? { k: "neg", operand } : operand;
    }
    return primary();
  }
  function primary() {
    const tok = next();
    if (!tok) throw new Unsupported("式が途中で終わっています");
    if (tok.t === "num") return { k: "val", v: tok.v };
    if (tok.t === "str") return { k: "val", v: tok.v };
    if (tok.t === "err") return { k: "val", v: tok.v };
    if (tok.t === "ref") return { k: "ref", sheet: tok.sheet, a: tok.a, b: tok.b };
    if (tok.t === "fn") {
      expectOp("(");
      const args = [];
      if (!(peek()?.t === "op" && peek().v === ")")) {
        args.push(comparison());
        while (peek()?.t === "op" && peek().v === ",") {
          next();
          args.push(comparison());
        }
      }
      expectOp(")");
      return { k: "fn", name: tok.v, args };
    }
    if (tok.t === "op" && tok.v === "(") {
      const inner = comparison();
      expectOp(")");
      return inner;
    }
    throw new Unsupported("解釈できない記号です");
  }

  const ast = comparison();
  if (pos !== tokens.length) throw new Unsupported("式の末尾を解釈できません");
  return ast;
}

function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { col: colToIndex(m[1]), row: Number(m[2]) };
}

function toNumber(v) {
  if (v instanceof FormulaError) return v;
  if (v == null || v === "") return v === "" ? ERR_VALUE : 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? ERR_VALUE : n;
}

function compare(op, a, b) {
  const norm = (v) => (v == null ? null : typeof v === "string" ? v.toLowerCase() : v);
  let x = norm(a);
  let y = norm(b);
  if (x == null) x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  if (y == null) y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  if (typeof x !== typeof y) {
    // Excelの型順: 数値 < 文字列 < 論理値
    const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    const d = rank(x) - rank(y);
    return { "=": false, "<>": true, "<": d < 0, ">": d > 0, "<=": d < 0, ">=": d > 0 }[op];
  }
  return { "=": x === y, "<>": x !== y, "<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y }[op];
}

/**
 * ブック全体の計算器。シートXMLは必要になった時点で読み込む。
 */
export class WorkbookCalculator {
  constructor(pkg) {
    this.pkg = pkg;
    this.sheets = null;
    this.sharedStrings = null;
    this.cellsBySheet = new Map();
    this.memo = new Map();
    this.unsupported = [];
  }

  async init() {
    this.sheets = await this.pkg.listSheets();
    this.sharedStrings = parseSharedStringsXml(await this.pkg.getText("xl/sharedStrings.xml"));
    for (const sheet of this.sheets) await this.loadSheet(sheet.name);
  }

  async loadSheet(name) {
    const sheet = this.sheets.find((s) => s.name === name);
    const cells = readSheetCells(await this.pkg.getText(sheet.path), this.sharedStrings);
    // 共有数式を展開して、各セルの式テキストを確定させる
    const masters = new Map();
    for (const [ref, cell] of cells) {
      if (cell.formula?.shared && cell.formula.ref && cell.formula.text) masters.set(cell.formula.si, { ...splitRef(ref), text: cell.formula.text });
    }
    for (const [ref, cell] of cells) {
      if (!cell.formula) continue;
      if (cell.formula.shared && !cell.formula.text) {
        const master = masters.get(cell.formula.si);
        const { row, col } = splitRef(ref);
        cell.expanded = master ? shiftFormula(master.text, row - master.row, col - master.col) : null;
      } else {
        cell.expanded = cell.formula.text;
      }
    }
    this.cellsBySheet.set(name, cells);
  }

  /** 値のあるセルを入れ替えたあと、該当シートを読み直す */
  async reloadSheet(name) {
    this.memo.clear();
    await this.loadSheet(name);
  }

  rawValue(cell) {
    if (cell.value == null) return null;
    if (cell.type === "s" || cell.type === "inlineStr" || cell.type === "str") return cell.value;
    if (cell.type === "b") return cell.value === "1";
    if (cell.type === "e") return new FormulaError(cell.value);
    const n = Number(cell.value);
    return Number.isNaN(n) ? cell.value : n;
  }

  valueOf(sheetName, ref, stack = new Set()) {
    const key = `${sheetName}!${ref}`;
    if (this.memo.has(key)) return this.memo.get(key);
    const cells = this.cellsBySheet.get(sheetName);
    if (!cells) return ERR_REF;
    const cell = cells.get(ref);
    if (!cell) return null;
    if (!cell.formula) return this.rawValue(cell);
    if (stack.has(key)) throw new Unsupported(`循環参照: ${key}`);
    stack.add(key);
    let result;
    if (cell.expanded == null) {
      result = this.rawValue(cell); // 展開できない共有数式は元のキャッシュのまま
    } else {
      const ast = parse(tokenize(cell.expanded));
      const at = splitRef(ref);
      result = this.evaluate(ast, sheetName, at, stack);
    }
    stack.delete(key);
    if (result === null) result = 0; // 空セルを参照した数式はExcelでは0と表示される
    this.memo.set(key, result);
    return result;
  }

  rangeCells(node, sheetName) {
    const target = node.sheet ?? sheetName;
    const a = splitRef(node.a);
    const b = splitRef(node.b ?? node.a);
    const out = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push({ sheet: target, ref: `${indexToCol(c)}${r}` });
    }
    return out;
  }

  evaluate(node, sheetName, at, stack) {
    switch (node.k) {
      case "val":
        return node.v;
      case "neg": {
        const v = toNumber(this.evaluate(node.operand, sheetName, at, stack));
        return v instanceof FormulaError ? v : -v;
      }
      case "ref": {
        const target = node.sheet ?? sheetName;
        if (!this.cellsBySheet.has(target)) return ERR_REF;
        if (!node.b) return this.valueOf(target, node.a, stack);
        // 範囲を1つの値として使う場合は暗黙の交差（同じ行・同じ列のセル）
        const a = splitRef(node.a);
        const b = splitRef(node.b);
        if (a.row === b.row && at.col >= Math.min(a.col, b.col) && at.col <= Math.max(a.col, b.col)) {
          return this.valueOf(target, `${indexToCol(at.col)}${a.row}`, stack);
        }
        if (a.col === b.col && at.row >= Math.min(a.row, b.row) && at.row <= Math.max(a.row, b.row)) {
          return this.valueOf(target, `${indexToCol(a.col)}${at.row}`, stack);
        }
        return ERR_VALUE;
      }
      case "bin": {
        const l = this.evaluate(node.left, sheetName, at, stack);
        const r = this.evaluate(node.right, sheetName, at, stack);
        if (l instanceof FormulaError) return l;
        if (r instanceof FormulaError) return r;
        if (node.op === "&") return `${l ?? ""}${r ?? ""}`;
        if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) return compare(node.op, l, r);
        const x = toNumber(l);
        const y = toNumber(r);
        if (x instanceof FormulaError) return x;
        if (y instanceof FormulaError) return y;
        if (node.op === "+") return x + y;
        if (node.op === "-") return x - y;
        if (node.op === "*") return x * y;
        if (y === 0) return new FormulaError("#DIV/0!");
        return x / y;
      }
      case "fn": {
        if (node.name === "IF") {
          const cond = this.evaluate(node.args[0], sheetName, at, stack);
          if (cond instanceof FormulaError) return cond;
          const truthy = typeof cond === "string" ? null : Boolean(toNumber(cond));
          if (truthy === null) return ERR_VALUE;
          const branch = truthy ? node.args[1] : node.args[2];
          if (!branch) return truthy;
          const v = this.evaluate(branch, sheetName, at, stack);
          return v === null ? 0 : v;
        }
        if (node.name === "SUM") {
          let total = 0;
          for (const arg of node.args) {
            if (arg.k === "ref") {
              for (const { sheet, ref } of this.rangeCells(arg, sheetName)) {
                const v = this.valueOf(sheet, ref, stack);
                if (v instanceof FormulaError) return v;
                if (typeof v === "number") total += v;
              }
            } else {
              const v = toNumber(this.evaluate(arg, sheetName, at, stack));
              if (v instanceof FormulaError) return v;
              total += v;
            }
          }
          return total;
        }
        throw new Unsupported(`未対応の関数: ${node.name}`);
      }
      default:
        throw new Unsupported("未対応の式");
    }
  }

  /**
   * 指定シートの全数式の表示値を計算し直し、シートXMLへ書き戻す（<f>はそのまま）。
   * 計算できなかった数式は元のキャッシュ値を残し、this.unsupportedに記録する。
   */
  async writeCaches(sheetName) {
    const sheet = this.sheets.find((s) => s.name === sheetName);
    const xml = await this.pkg.getText(sheet.path);
    const cells = this.cellsBySheet.get(sheetName);
    const next = mapSheetCells(xml, this.sharedStrings, (cell, original) => {
      if (!cell.formula) return undefined;
      const ref = `${cell.col}${cell.row}`;
      let value;
      try {
        value = this.valueOf(sheetName, ref);
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        this.unsupported.push({ sheet: sheetName, ref, formula: cells.get(ref)?.expanded, reason: e.message });
        return undefined;
      }
      const fXml = /<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(original)[0];
      const baseAttrs = cell.attrs.replace(/\st="\w+"/, "");
      if (value instanceof FormulaError) return `<c r="${ref}"${baseAttrs} t="e">${fXml}<v>${escapeXmlText(value.code)}</v></c>`;
      if (typeof value === "number") return `<c r="${ref}"${baseAttrs}>${fXml}<v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${ref}"${baseAttrs} t="b">${fXml}<v>${value ? 1 : 0}</v></c>`;
      return `<c r="${ref}"${baseAttrs} t="str">${fXml}<v>${escapeXmlText(value)}</v></c>`;
    });
    if (next !== xml) this.pkg.setText(sheet.path, next);
  }
}
