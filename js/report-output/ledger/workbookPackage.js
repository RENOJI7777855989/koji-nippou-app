/* ==========================================================
   .xlsxパッケージ（ZIP内のパート群）をメモリ上で編集するための部品
   台帳出力・1日出力の「他工事データ除去」で使う。
   原本テンプレートのバイト列（loadZipの戻り値）は読み取り専用で、
   変更はすべてこのオブジェクトの中（modified/removed）に溜め、
   最後にtoBlob()で新しい.xlsxとして書き出す。原本は一切変更しない。

   シートの削除・複製に伴って整合を取る必要がある箇所:
     workbook.xml（<sheets>・definedNamesのlocalSheetId・activeTab）
     xl/_rels/workbook.xml.rels / [Content_Types].xml
     シート付随パート（drawing・printerSettings・comments・vmlDrawing）
     docProps/app.xml（シート名一覧）/ calcChain.xml（削除して再計算させる）
   ========================================================== */

import { loadZip, readZipEntryText, readZipEntryBytes, buildZip, buildZipCompressed } from "../../zipUtil.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELTYPE_WORKSHEET = `${REL_NS}/worksheet`;
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";

export function decodeXmlText(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXmlAttr(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "xl/worksheets/sheet2.xml" + "../drawings/drawing2.xml" → "xl/drawings/drawing2.xml" */
export function resolvePartPath(basePartPath, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = basePartPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function relsPathOf(partPath) {
  const idx = partPath.lastIndexOf("/");
  return `${partPath.slice(0, idx)}/_rels/${partPath.slice(idx + 1)}.rels`;
}

function relativeTarget(fromPartPath, toPartPath) {
  const from = fromPartPath.split("/").slice(0, -1);
  const to = toPartPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

export function parseRelationships(relsXml) {
  return [...String(relsXml || "").matchAll(/<Relationship\b([^>]*?)\/>/g)].map((m) => {
    const attr = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(m[1])?.[1] ?? null;
    return { xml: m[0], id: attr("Id"), type: attr("Type"), target: attr("Target"), targetMode: attr("TargetMode") };
  });
}

/** workbook.xmlの<definedName>を列挙（localSheetIdは数値またはnull） */
export function parseDefinedNames(workbookXml) {
  return [...workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)].map((m) => ({
    xml: m[0],
    name: decodeXmlText(/\sname="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    localSheetId: /\slocalSheetId="(\d+)"/.test(m[1]) ? Number(/\slocalSheetId="(\d+)"/.exec(m[1])[1]) : null,
    formula: decodeXmlText(m[2])
  }));
}

export class WorkbookPackage {
  constructor(zip) {
    this.zip = zip;
    this.texts = new Map(); // 読み込み済み／変更済みのテキストパート
    this.binaries = new Map(); // 変更・追加したバイナリパート
    this.dirty = new Set();
    this.removed = new Set();
  }

  static async open(arrayBuffer) {
    const pkg = new WorkbookPackage(loadZip(arrayBuffer));
    return pkg;
  }

  has(path) {
    if (this.removed.has(path)) return false;
    return this.texts.has(path) || this.binaries.has(path) || this.zip.entries.has(path);
  }

  listParts() {
    const names = new Set([...this.zip.entries.keys(), ...this.texts.keys(), ...this.binaries.keys()]);
    return [...names].filter((n) => !this.removed.has(n));
  }

  async getText(path) {
    if (this.removed.has(path)) return null;
    if (this.texts.has(path)) return this.texts.get(path);
    const text = await readZipEntryText(this.zip, path);
    if (text != null) this.texts.set(path, text);
    return text;
  }

  setText(path, text) {
    this.removed.delete(path);
    this.texts.set(path, text);
    this.dirty.add(path);
  }

  async getBytes(path) {
    if (this.removed.has(path)) return null;
    if (this.binaries.has(path)) return this.binaries.get(path);
    if (this.texts.has(path)) return new TextEncoder().encode(this.texts.get(path));
    return readZipEntryBytes(this.zip, path);
  }

  setBytes(path, bytes) {
    this.removed.delete(path);
    this.binaries.set(path, bytes);
    this.dirty.add(path);
  }

  remove(path) {
    this.removed.add(path);
    this.dirty.delete(path);
    this.texts.delete(path);
    this.binaries.delete(path);
  }

  /** 書き出し用の未圧縮のパートと、元のZIPのエントリ（削除分を除く）を集める */
  collectForBuild() {
    const entries = new Map([...this.zip.entries].filter(([name]) => !this.removed.has(name)));
    const modifications = new Map();
    for (const path of this.dirty) {
      if (this.removed.has(path)) continue;
      modifications.set(path, this.binaries.has(path) ? this.binaries.get(path) : new TextEncoder().encode(this.texts.get(path)));
    }
    return { zip: { buffer: this.zip.buffer, entries }, modifications };
  }

  /** 圧縮せずに書き出す（同期。テスト・小さな出力用） */
  toBlob() {
    const { zip, modifications } = this.collectForBuild();
    return buildZip(zip, modifications, XLSX_MIME);
  }

  /** deflate圧縮して書き出す（台帳・同梱テンプレートなど大きな出力用） */
  async toCompressedBlob() {
    const { zip, modifications } = this.collectForBuild();
    return buildZipCompressed(zip, modifications, XLSX_MIME);
  }

  /** workbook.xmlの<sheets>順に [{name, sheetId, rId, path, index}] */
  async listSheets() {
    const workbookXml = await this.getText("xl/workbook.xml");
    const rels = parseRelationships(await this.getText("xl/_rels/workbook.xml.rels"));
    const sheets = [];
    for (const m of workbookXml.matchAll(/<sheet\b([^>]*?)\/>/g)) {
      const attr = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(m[1])?.[1] ?? null;
      const rId = attr("r:id");
      const rel = rels.find((r) => r.id === rId);
      sheets.push({
        name: decodeXmlText(attr("name")),
        sheetId: Number(attr("sheetId")),
        rId,
        path: rel ? resolvePartPath("xl/workbook.xml", rel.target) : null,
        index: sheets.length
      });
    }
    return sheets;
  }

  /** シートに付随するパート（.rels経由）を{type, path, relId}で返す */
  async sheetRelatedParts(sheetPath) {
    const relsXml = await this.getText(relsPathOf(sheetPath));
    return parseRelationships(relsXml)
      .filter((r) => r.targetMode !== "External")
      .map((r) => ({ relId: r.id, type: r.type.split("/").pop(), path: resolvePartPath(sheetPath, r.target) }));
  }

  async removeContentTypeOverride(path) {
    let ct = await this.getText("[Content_Types].xml");
    ct = ct.replace(new RegExp(`<Override PartName="/${escapeRegExp(path)}"[^>]*/>`), "");
    this.setText("[Content_Types].xml", ct);
  }

  async addContentTypeOverride(path, contentType) {
    let ct = await this.getText("[Content_Types].xml");
    if (ct.includes(`PartName="/${path}"`)) return;
    ct = ct.replace("</Types>", `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`);
    this.setText("[Content_Types].xml", ct);
  }

  /** パートと、そのパートの.relsが指す内部パートを再帰的に削除（他から参照されているものは残す） */
  async removePartTree(path, keep = new Set()) {
    if (!this.has(path) || keep.has(path)) return;
    const relsPath = relsPathOf(path);
    const rels = parseRelationships(await this.getText(relsPath));
    this.remove(path);
    this.remove(relsPath);
    await this.removeContentTypeOverride(path);
    for (const rel of rels) {
      if (rel.targetMode === "External") continue;
      const child = resolvePartPath(path, rel.target);
      if (!(await this.isReferenced(child))) await this.removePartTree(child, keep);
    }
  }

  /** 残っているいずれかの.relsから参照されているか */
  async isReferenced(path) {
    for (const name of this.listParts()) {
      if (!name.endsWith(".rels")) continue;
      const owner = name.replace(/_rels\/([^/]+)\.rels$/, "$1");
      const rels = parseRelationships(await this.getText(name));
      if (rels.some((r) => r.targetMode !== "External" && resolvePartPath(owner, r.target) === path)) return true;
    }
    return false;
  }

  /**
   * シートを削除する。definedNamesのlocalSheetIdを詰め、activeTab/firstSheetを補正する。
   * 他シートから数式で参照されているシートを消すと#REF!になるため、呼び出し側で
   * 参照されていないこと（後ろのシートから順に消す等）を保証すること。
   */
  async removeSheet(name) {
    const sheets = await this.listSheets();
    const target = sheets.find((s) => s.name === name);
    if (!target) throw new Error(`シートが見つかりません: ${name}`);
    const idx = target.index;

    let workbookXml = await this.getText("xl/workbook.xml");
    workbookXml = workbookXml.replace(new RegExp(`<sheet\\b[^>]*\\sr:id="${escapeRegExp(target.rId)}"[^>]*/>`), "");
    workbookXml = workbookXml.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g, (whole, attrs, body) => {
      const m = /\slocalSheetId="(\d+)"/.exec(attrs);
      if (!m) {
        // ブック全体の名前が削除するシートを指していれば、Excelと同じく#REF!にする
        const formula = decodeXmlText(body);
        const quoted = `'${name.replace(/'/g, "''")}'!`;
        return formula.includes(quoted) || formula.startsWith(`${name}!`) ? `<definedName${attrs}>#REF!</definedName>` : whole;
      }
      const id = Number(m[1]);
      if (id === idx) return "";
      if (id > idx) return `<definedName${attrs.replace(/\slocalSheetId="\d+"/, ` localSheetId="${id - 1}"`)}>${body}</definedName>`;
      return whole;
    });
    workbookXml = workbookXml.replace(/<definedNames>\s*<\/definedNames>/, "");
    workbookXml = adjustTabIndex(workbookXml, "activeTab", idx, sheets.length - 1);
    workbookXml = adjustTabIndex(workbookXml, "firstSheet", idx, sheets.length - 1);
    this.setText("xl/workbook.xml", workbookXml);

    let wbRels = await this.getText("xl/_rels/workbook.xml.rels");
    wbRels = wbRels.replace(new RegExp(`<Relationship\\b[^>]*\\sId="${escapeRegExp(target.rId)}"[^>]*/>`), "");
    this.setText("xl/_rels/workbook.xml.rels", wbRels);

    await this.removePartTree(target.path);
    await this.syncAppSheetTitles();
  }

  /**
   * シートを複製して、afterName の直後へ挿入する。
   * 複製元のdrawing・printerSettingsは複製（同じ画像メディアは共有）、
   * comments/vmlDrawingは複製しない（複製元の吹き出しは入力補助で、台帳の値ではないため）。
   * @param {(sheetXml: string) => string} [transform] 複製後のシートXMLを書き換える関数
   */
  async cloneSheet(sourceName, newName, afterName, transform = (x) => x) {
    const sheets = await this.listSheets();
    const source = sheets.find((s) => s.name === sourceName);
    const after = sheets.find((s) => s.name === afterName);
    if (!source || !after) throw new Error(`複製元シートが見つかりません: ${sourceName}`);
    if (sheets.some((s) => s.name === newName)) throw new Error(`同名のシートが既にあります: ${newName}`);

    const newSheetPath = this.nextFreePath("xl/worksheets/sheet", ".xml");
    let sheetXml = transform(await this.getText(source.path));

    const relatedRels = parseRelationships(await this.getText(relsPathOf(source.path)));
    const newRels = [];
    for (const rel of relatedRels) {
      const kind = rel.type.split("/").pop();
      if (rel.targetMode === "External") continue;
      const srcPart = resolvePartPath(source.path, rel.target);
      if (kind === "drawing") {
        const newDrawing = this.nextFreePath("xl/drawings/drawing", ".xml");
        this.setText(newDrawing, await this.getText(srcPart));
        const srcDrawingRels = await this.getText(relsPathOf(srcPart));
        if (srcDrawingRels) {
          // 画像等は同じメディアを共有するので、相対パスを新しい図形パートから見た位置に直す
          const fixed = srcDrawingRels.replace(/Target="([^"]+)"/g, (whole, target) =>
            /^[a-z]+:/i.test(target) ? whole : `Target="${relativeTarget(newDrawing, resolvePartPath(srcPart, target))}"`
          );
          this.setText(relsPathOf(newDrawing), fixed);
        }
        await this.addContentTypeOverride(newDrawing, CT_DRAWING);
        newRels.push(`<Relationship Id="${rel.id}" Type="${rel.type}" Target="${relativeTarget(newSheetPath, newDrawing)}"/>`);
      } else if (kind === "printerSettings") {
        const newBin = this.nextFreePath("xl/printerSettings/printerSettings", ".bin");
        this.setBytes(newBin, await this.getBytes(srcPart));
        newRels.push(`<Relationship Id="${rel.id}" Type="${rel.type}" Target="${relativeTarget(newSheetPath, newBin)}"/>`);
      } else {
        // comments / vmlDrawing / その他は複製しない。シートXML側の参照要素も外す
        if (kind === "vmlDrawing") sheetXml = sheetXml.replace(new RegExp(`<legacyDrawing\\b[^>]*r:id="${escapeRegExp(rel.id)}"[^>]*/>`), "");
        continue;
      }
    }
    this.setText(newSheetPath, sheetXml);
    this.setText(
      relsPathOf(newSheetPath),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${newRels.join("")}</Relationships>`
    );
    await this.addContentTypeOverride(newSheetPath, CT_WORKSHEET);

    let wbRels = await this.getText("xl/_rels/workbook.xml.rels");
    const usedIds = new Set(parseRelationships(wbRels).map((r) => r.id));
    let n = 1;
    while (usedIds.has(`rId${n}`)) n++;
    const newRId = `rId${n}`;
    wbRels = wbRels.replace(
      "</Relationships>",
      `<Relationship Id="${newRId}" Type="${RELTYPE_WORKSHEET}" Target="${relativeTarget("xl/workbook.xml", newSheetPath)}"/></Relationships>`
    );
    this.setText("xl/_rels/workbook.xml.rels", wbRels);

    let workbookXml = await this.getText("xl/workbook.xml");
    const newSheetId = Math.max(...sheets.map((s) => s.sheetId)) + 1;
    const insertIdx = after.index + 1;
    const afterTag = new RegExp(`<sheet\\b[^>]*\\sr:id="${escapeRegExp(after.rId)}"[^>]*/>`).exec(workbookXml);
    const newTag = `<sheet name="${encodeXmlAttr(newName)}" sheetId="${newSheetId}" r:id="${newRId}"/>`;
    workbookXml = workbookXml.slice(0, afterTag.index + afterTag[0].length) + newTag + workbookXml.slice(afterTag.index + afterTag[0].length);
    // 挿入位置以降のlocalSheetIdを1つずらす
    workbookXml = workbookXml.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g, (whole, attrs, body) => {
      const m = /\slocalSheetId="(\d+)"/.exec(attrs);
      if (!m || Number(m[1]) < insertIdx) return whole;
      return `<definedName${attrs.replace(/\slocalSheetId="\d+"/, ` localSheetId="${Number(m[1]) + 1}"`)}>${body}</definedName>`;
    });
    this.setText("xl/workbook.xml", workbookXml);
    await this.syncAppSheetTitles();
    return { name: newName, path: newSheetPath, index: insertIdx };
  }

  nextFreePath(prefix, suffix) {
    const existing = new Set(this.listParts());
    let n = 1;
    while (existing.has(`${prefix}${n}${suffix}`)) n++;
    return `${prefix}${n}${suffix}`;
  }

  /** 印刷範囲（_xlnm.Print_Area）を設定する（シートローカル名） */
  async setPrintArea(sheetName, rangeRef) {
    const sheets = await this.listSheets();
    const sheet = sheets.find((s) => s.name === sheetName);
    let workbookXml = await this.getText("xl/workbook.xml");
    const quoted = `'${sheetName.replace(/'/g, "''")}'`;
    const body = `${quoted}!${rangeRef}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const xml = `<definedName name="_xlnm.Print_Area" localSheetId="${sheet.index}">${body}</definedName>`;
    const re = new RegExp(`<definedName name="_xlnm\\.Print_Area" localSheetId="${sheet.index}">[\\s\\S]*?</definedName>`);
    if (re.test(workbookXml)) workbookXml = workbookXml.replace(re, xml);
    else if (workbookXml.includes("<definedNames>")) workbookXml = workbookXml.replace("<definedNames>", `<definedNames>${xml}`);
    else workbookXml = workbookXml.replace("</sheets>", `</sheets><definedNames>${xml}</definedNames>`);
    this.setText("xl/workbook.xml", workbookXml);
  }

  async setActiveSheet(sheetName) {
    const sheets = await this.listSheets();
    const sheet = sheets.find((s) => s.name === sheetName);
    if (!sheet) return;
    let workbookXml = await this.getText("xl/workbook.xml");
    workbookXml = workbookXml.replace(/(<workbookView\b[^>]*?)\sactiveTab="\d+"/, "$1");
    workbookXml = workbookXml.replace(/(<workbookView\b[^>]*?)\sfirstSheet="\d+"/, "$1");
    workbookXml = workbookXml.replace(/<workbookView\b/, `<workbookView activeTab="${sheet.index}"`);
    this.setText("xl/workbook.xml", workbookXml);
    // 各シートの「選択中」フラグを対象シートだけにする
    for (const s of sheets) {
      let xml = await this.getText(s.path);
      const next = xml.replace(/(<sheetView\b[^>]*?)\stabSelected="1"/, "$1");
      const withSel = s.name === sheetName ? next.replace(/<sheetView\b/, '<sheetView tabSelected="1"') : next;
      if (withSel !== xml) this.setText(s.path, withSel);
    }
  }

  /** docProps/app.xmlのシート名一覧を実際の構成に合わせる（名前付き範囲の一覧も作り直す） */
  async syncAppSheetTitles() {
    const appXml = await this.getText("docProps/app.xml");
    if (!appXml) return;
    const sheets = await this.listSheets();
    const names = parseDefinedNames(await this.getText("xl/workbook.xml")).filter((d) => d.name === "_xlnm.Print_Area" && d.localSheetId != null);
    const nameTitles = names.map((d) => {
      const sheetName = sheets[d.localSheetId]?.name ?? "";
      const needsQuote = /^\d/.test(sheetName) || /[\s'!\-～()]/.test(sheetName);
      const quoted = needsQuote ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
      return `${quoted}!Print_Area`;
    });
    const titles = [...sheets.map((s) => s.name), ...nameTitles];
    const heading =
      `<HeadingPairs><vt:vector size="${nameTitles.length ? 4 : 2}" baseType="variant">` +
      `<vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant>` +
      (nameTitles.length ? `<vt:variant><vt:lpstr>名前付き一覧</vt:lpstr></vt:variant><vt:variant><vt:i4>${nameTitles.length}</vt:i4></vt:variant>` : "") +
      `</vt:vector></HeadingPairs>`;
    const parts = `<TitlesOfParts><vt:vector size="${titles.length}" baseType="lpstr">${titles.map((t) => `<vt:lpstr>${encodeXmlAttr(t)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>`;
    let next = appXml.replace(/<HeadingPairs>[\s\S]*?<\/HeadingPairs>/, heading).replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/, parts);
    if (next !== appXml) this.setText("docProps/app.xml", next);
  }

  /** calcChain.xmlを削除し、開いたときに全数式を再計算させる */
  async requestFullRecalc() {
    if (this.has("xl/calcChain.xml")) {
      this.remove("xl/calcChain.xml");
      await this.removeContentTypeOverride("xl/calcChain.xml");
      let wbRels = await this.getText("xl/_rels/workbook.xml.rels");
      wbRels = wbRels.replace(/<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/, "");
      this.setText("xl/_rels/workbook.xml.rels", wbRels);
    }
    let workbookXml = await this.getText("xl/workbook.xml");
    if (/<calcPr\b/.test(workbookXml)) {
      workbookXml = workbookXml.replace(/<calcPr\b([^>]*?)\/>/, (whole, attrs) =>
        /fullCalcOnLoad=/.test(attrs) ? whole : `<calcPr${attrs} fullCalcOnLoad="1"/>`
      );
    } else {
      workbookXml = workbookXml.replace(/(<\/definedNames>|<\/sheets>)(?![\s\S]*(<\/definedNames>))/, `$1<calcPr fullCalcOnLoad="1"/>`);
    }
    this.setText("xl/workbook.xml", workbookXml);
  }
}

function adjustTabIndex(workbookXml, attrName, removedIdx, newCount) {
  return workbookXml.replace(new RegExp(`(<workbookView\\b[^>]*\\s${attrName}=")(\\d+)(")`), (whole, pre, value, post) => {
    let v = Number(value);
    if (v > removedIdx) v -= 1;
    else if (v === removedIdx) v = Math.min(v, newCount - 1);
    return `${pre}${Math.max(0, v)}${post}`;
  });
}
