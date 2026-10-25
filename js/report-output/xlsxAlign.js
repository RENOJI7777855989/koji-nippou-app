/* ==========================================================
   出力用の複製のセルを、上下・左右とも中央揃えにする（DOM非依存・文字列処理。2026-10-25）
   03-2の稼動人数表（職種・人数・累計・計・延労働時間）と巡回点検の点検項目に使う。
   ・セルの今の書式（xf: フォント・塗り・罫線・配置）をそのまま複製し、配置だけ「横・縦とも中央」にしたものを styles.xml の
     末尾に足して、そのセルの s 属性を付け替える（xlsxDiagonal.js の斜線と同じ方式）。縦書き・折り返しなどの他の配置はそのまま。
   ・セルの値・結合・行・列・罫線・文字の大きさ・数式には触れない。原本テンプレートは変更しない（出力の複製だけ）。
   ========================================================== */

import { sectionOf, childElements } from "./xlsxDiagonal.js";

/** xf の配置を横・縦とも中央にする（字下げは中央揃えでは使われないので外す） */
export function centerXf(xf) {
  const align = (attrs) => {
    let a = attrs.replace(/\s(horizontal|vertical|indent)="[^"]*"/g, "");
    return `<alignment${a} horizontal="center" vertical="center"/>`;
  };
  let x = /<alignment\b/.test(xf)
    ? xf.replace(/<alignment\b([^>]*?)\s*\/>|<alignment\b([^>]*)>[\s\S]*?<\/alignment>/, (m, a1, a2) => align(a1 ?? a2 ?? ""))
    : /\/>$/.test(xf)
      ? xf.replace(/\s*\/>$/, `>${align("")}</xf>`)
      : xf.replace(/^(<xf\b[^>]*>)/, `$1${align("")}`);
  x = /\sapplyAlignment="[^"]*"/.test(x) ? x.replace(/\sapplyAlignment="[^"]*"/, ' applyAlignment="1"') : x.replace(/^<xf\b/, '<xf applyAlignment="1"');
  return x;
}

/**
 * 指定したセルを中央揃えにする。
 * @param {{sheetXml: string, stylesXml: string, cells: string[], cache?: Map<number, number>}} p
 *   cache: 元の書式番号 → 中央揃えの書式番号（同じブックの複数シートで使い回す）
 * @returns {{sheetXml: string, stylesXml: string, applied: string[], missing: string[], cache: Map<number, number>}}
 */
export function applyCenterAlignment({ sheetXml, stylesXml, cells, cache = new Map() }) {
  const want = new Set(cells);
  const applied = [];
  let st = stylesXml;
  // シートを1回だけ走査して、対象のセルの書式番号を付け替える（台帳は頁が多いので、セルごとにシート全体を探さない）
  const sx = sheetXml.replace(/<c r="([A-Z]+\d+)"((?:\s[^>]*?)?)(\/?)>/g, (m, ref, attrs, slash) => {
    if (!want.has(ref)) return m;
    const sIndex = Number((/\ss="(\d+)"/.exec(attrs) || [])[1] || 0);
    let newIndex = cache.get(sIndex);
    if (newIndex == null) {
      const xfsSec = sectionOf(st, "cellXfs");
      if (!xfsSec) return m;
      const xfs = childElements(st.slice(xfsSec.openEnd, xfsSec.close), "xf");
      const xf = xfs[sIndex];
      if (!xf) return m;
      newIndex = xfs.length;
      const xOpen = xfsSec.openTag.replace(/\scount="\d+"/, ` count="${xfs.length + 1}"`);
      st = st.slice(0, xfsSec.start) + xOpen + st.slice(xfsSec.openEnd, xfsSec.close) + centerXf(xf) + st.slice(xfsSec.close);
      cache.set(sIndex, newIndex);
    }
    want.delete(ref);
    applied.push(ref);
    const a2 = /\ss="\d+"/.test(attrs) ? attrs.replace(/\ss="\d+"/, ` s="${newIndex}"`) : `${attrs} s="${newIndex}"`;
    return `<c r="${ref}"${a2}${slash}>`;
  });
  return { sheetXml: sx, stylesXml: st, applied, missing: [...want], cache };
}

/** "J7:K39" のような範囲をセルの一覧にする（行・列の順） */
export function expandRange(range) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) return [];
  const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const letters = (n) => { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const c1 = col(m[1]), r1 = Number(m[2]), c2 = col(m[3] || m[1]), r2 = Number(m[4] || m[2]);
  const out = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push(`${letters(c)}${r}`);
  return out;
}
