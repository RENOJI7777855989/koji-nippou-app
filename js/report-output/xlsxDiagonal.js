/* ==========================================================
   出力用の複製のセルに、Excelの罫線としての「斜線」（左上→右下）を付ける（DOM非依存・文字列処理）
   03-2の巡回点検の欄（休工日・作業なし・事務作業日で点検記録が無い日）に使う。
   ・セルの今の書式（xf: フォント・塗り・配置・罫線）をそのまま複製し、罫線だけ「今の罫線＋斜線」に
     したものを styles.xml の末尾に足して、そのセルの s 属性を付け替える。元の書式・他のセルは変えない。
   ・同じ元の書式からは1回だけ作る（同じ書式の33セルなら、追加は罫線1つ・書式1つ）。
   ・セルの値・結合・行・列・数式には触れない。原本テンプレートは変更しない（出力の複製だけ）。
   ========================================================== */

const DIAGONAL_XML = '<diagonal style="thin"><color indexed="64"/></diagonal>';

function sectionOf(xml, tag) {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
  if (!open) return null;
  const close = xml.indexOf(`</${tag}>`, open.index);
  if (close < 0) return null;
  return { start: open.index, openEnd: open.index + open[0].length, close, end: close + tag.length + 3, openTag: open[0] };
}

function childElements(inner, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*\\/>|<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g");
  return inner.match(re) || [];
}

/** 罫線の要素に斜線（左上→右下）を足す（今の上下左右の罫線はそのまま） */
export function addDiagonalDown(borderXml) {
  let x = borderXml;
  // <border/>（空）の場合は中身を作る
  if (/^<border\b[^>]*\/>$/.test(x)) x = x.replace(/\/>$/, "><left/><right/><top/><bottom/><diagonal/></border>");
  x = x.replace(/^<border\b([^>]*)>/, (m, attrs) => `<border${attrs.replace(/\s+diagonal(Up|Down)="[^"]*"/g, "")} diagonalDown="1">`);
  if (/<diagonal\b[^>]*\/>|<diagonal\b[^>]*>[\s\S]*?<\/diagonal>/.test(x)) x = x.replace(/<diagonal\b[^>]*\/>|<diagonal\b[^>]*>[\s\S]*?<\/diagonal>/, DIAGONAL_XML);
  else if (/<bottom\b[^>]*\/>|<\/bottom>/.test(x)) x = x.replace(/(<bottom\b[^>]*\/>|<\/bottom>)/, `$1${DIAGONAL_XML}`);
  else x = x.replace(/<\/border>$/, `${DIAGONAL_XML}</border>`);
  return x;
}

/** シートのセルの s 属性（書式番号）。セルが無ければ null */
function cellStyleIndex(sheetXml, ref) {
  const m = new RegExp(`<c r="${ref}"(\\s[^>]*)?\\/?>`).exec(sheetXml);
  if (!m) return null;
  const s = /\ss="(\d+)"/.exec(m[1] || "");
  return s ? Number(s[1]) : 0;
}

function setCellStyleIndex(sheetXml, ref, index) {
  return sheetXml.replace(new RegExp(`<c r="${ref}"((?:\\s[^>]*?)?)(\\/?)>`), (m, attrs, slash) => {
    const a = /\ss="\d+"/.test(attrs) ? attrs.replace(/\ss="\d+"/, ` s="${index}"`) : `${attrs} s="${index}"`;
    return `<c r="${ref}"${a}${slash}>`;
  });
}

/**
 * 指定したセルに斜線を付ける。
 * @param {{sheetXml: string, stylesXml: string, cells: string[], cache?: Map<number, number>}} p
 *   cache: 元の書式番号 → 斜線つきの書式番号（同じブックの複数シートで使い回す）
 * @returns {{sheetXml: string, stylesXml: string, applied: string[], missing: string[], cache: Map<number, number>}}
 */
export function applyDiagonalBorders({ sheetXml, stylesXml, cells, cache = new Map() }) {
  const applied = [];
  const missing = [];
  let sx = sheetXml;
  let st = stylesXml;
  for (const ref of cells) {
    const sIndex = cellStyleIndex(sx, ref);
    if (sIndex == null) { missing.push(ref); continue; }
    let newIndex = cache.get(sIndex);
    if (newIndex == null) {
      const xfsSec = sectionOf(st, "cellXfs");
      const bordersSec = sectionOf(st, "borders");
      if (!xfsSec || !bordersSec) { missing.push(ref); continue; }
      const xfs = childElements(st.slice(xfsSec.openEnd, xfsSec.close), "xf");
      const borders = childElements(st.slice(bordersSec.openEnd, bordersSec.close), "border");
      const xf = xfs[sIndex];
      if (!xf) { missing.push(ref); continue; }
      const borderId = Number((/\sborderId="(\d+)"/.exec(xf) || [])[1] || 0);
      const newBorder = addDiagonalDown(borders[borderId] || "<border/>");
      const newBorderId = borders.length;
      let newXf = /\sborderId="\d+"/.test(xf) ? xf.replace(/\sborderId="\d+"/, ` borderId="${newBorderId}"`) : xf.replace(/^<xf\b/, `<xf borderId="${newBorderId}"`);
      newXf = /\sapplyBorder="[^"]*"/.test(newXf) ? newXf.replace(/\sapplyBorder="[^"]*"/, ' applyBorder="1"') : newXf.replace(/^<xf\b/, '<xf applyBorder="1"');
      newIndex = xfs.length;
      // borders の末尾に追加（count も更新）→ cellXfs の末尾に追加（borders は cellXfs より前にあるので先に処理しても位置はずれない）
      const bOpen = bordersSec.openTag.replace(/\scount="\d+"/, ` count="${borders.length + 1}"`);
      st = st.slice(0, bordersSec.start) + bOpen + st.slice(bordersSec.openEnd, bordersSec.close) + newBorder + st.slice(bordersSec.close);
      const xs = sectionOf(st, "cellXfs");
      const xOpen = xs.openTag.replace(/\scount="\d+"/, ` count="${xfs.length + 1}"`);
      st = st.slice(0, xs.start) + xOpen + st.slice(xs.openEnd, xs.close) + newXf + st.slice(xs.close);
      cache.set(sIndex, newIndex);
    }
    sx = setCellStyleIndex(sx, ref, newIndex);
    applied.push(ref);
  }
  return { sheetXml: sx, stylesXml: st, applied, missing, cache };
}
