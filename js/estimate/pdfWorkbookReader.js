/* ==========================================================
   PDF積算書のテキスト抽出（pdf.jsをオフライン同梱で使用: js/vendor/pdfjs/）
   Excelリーダー(excelWorkbookReader.js)と同じ{maxRow, maxCol, cells}
   形式を返すことで、excelEstimateParser.js（列マッピング・数値パース・
   要確認フラグ）とjs/ui/estimate-import-view.jsのUIロジックをそのまま
   流用できるようにしている。
   PDFはExcelと違いセル参照を持たないため、文字の座標からy方向に「行」、
   x方向に「列」を推定する（視覚的な位置に基づくヒューリスティック）。
   誤検出はあり得るため、保存前に必ずプレビューで確認する前提とする。
   ========================================================== */

import { colIndexToLetters } from "./excelWorkbookReader.js";
import { normalizeKangxiRadicals } from "./kangxiRadicalNormalize.js";

let pdfjsPromise = null;

/** pdf.js本体を遅延ロードする。estimateSourceViewer.js（元ページの画像描画）とも共有する */
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("../vendor/pdfjs/pdf.min.mjs").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

/** x座標が近く連続する文字断片を1つのセルにまとめる（pdf.jsがフォント切替等で1文字列を分割することがあるため） */
function mergeLineIntoCells(fragments, mergeGapThreshold) {
  const cells = [];
  let current = null;
  for (const frag of fragments) {
    if (current && frag.x - current.endX <= mergeGapThreshold) {
      current.text += frag.text;
      current.endX = Math.max(current.endX, frag.x + frag.width);
    } else {
      current = { text: frag.text, startX: frag.x, endX: frag.x + frag.width };
      cells.push(current);
    }
  }
  return cells;
}

/** ページ全体のセル開始x座標を集計し、近い位置同士を1つの「列」としてまとめる */
function detectColumnBands(cells, bandTolerance) {
  const xs = [...new Set(cells.map((c) => Math.round(c.startX)))].sort((a, b) => a - b);
  const bands = [];
  for (const x of xs) {
    const band = bands.find((b) => Math.abs(b.center - x) <= bandTolerance);
    if (band) {
      band.center = (band.center * band.count + x) / (band.count + 1);
      band.count++;
    } else {
      bands.push({ center: x, count: 1 });
    }
  }
  return bands.map((b) => b.center).sort((a, b) => a - b);
}

function nearestBandIndex(bands, x) {
  let best = 0;
  let bestDist = Infinity;
  bands.forEach((b, i) => {
    const dist = Math.abs(b - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** getTextContent()が返す文字断片から{maxRow, maxCol, cells}を組み立てる */
function buildLayoutFromTextContent(items) {
  const fragments = items
    .map((item) => ({
      text: normalizeKangxiRadicals(item.str),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: item.height || Math.abs(item.transform[3]) || 10
    }))
    .filter((f) => f.text.trim() !== "");

  if (fragments.length === 0) {
    throw new Error("このPDFにはテキスト情報がありません（スキャン画像PDFの可能性があります）");
  }

  const heights = fragments.map((f) => f.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const rowTolerance = medianHeight * 0.5;
  const mergeGapThreshold = medianHeight * 0.6;
  const bandTolerance = Math.max(10, medianHeight * 1.2);

  // PDF座標はy軸が下から上へ増加するため、y降順(=上から下)→x昇順で並べる
  fragments.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const frag of fragments) {
    const line = lines.find((l) => Math.abs(l.y - frag.y) <= rowTolerance);
    if (line) line.fragments.push(frag);
    else lines.push({ y: frag.y, fragments: [frag] });
  }
  lines.sort((a, b) => b.y - a.y);
  lines.forEach((l) => l.fragments.sort((a, b) => a.x - b.x));

  const lineCells = lines.map((l) => mergeLineIntoCells(l.fragments, mergeGapThreshold));
  const bands = detectColumnBands(lineCells.flat(), bandTolerance);

  const cells = new Map();
  lineCells.forEach((rowCells, rowIdx) => {
    const rowNum = rowIdx + 1;
    const textByCol = new Map();
    rowCells.forEach((cell) => {
      const colIdx = nearestBandIndex(bands, cell.startX);
      const existing = textByCol.get(colIdx);
      textByCol.set(colIdx, existing ? `${existing} ${cell.text}` : cell.text);
    });
    textByCol.forEach((text, colIdx) => {
      cells.set(`${colIndexToLetters(colIdx + 1)}${rowNum}`, { text, styleIndex: 0 });
    });
  });

  return { maxRow: lines.length, maxCol: bands.length, cells };
}

/** pdf.jsでPDFドキュメントを開く。日本語CMap・標準フォントの解決先は常に同じなので一箇所にまとめる */
async function openPdfDocument(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  const cMapUrl = new URL("../vendor/pdfjs/cmaps/", import.meta.url).href;
  const standardFontDataUrl = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href;
  return pdfjsLib.getDocument({ data: arrayBuffer, cMapUrl, cMapPacked: true, standardFontDataUrl }).promise;
}

/**
 * PDFのArrayBufferを解析し、ページ一覧と、指定ページのセルレイアウトを
 * 読み取れるハンドルを返す（excelWorkbookReader.jsのreadWorkbook()と同じ形状）。
 * @returns {{ sheetNames: string[], readSheet: (pageLabel: string) => Promise<object> }}
 */
export async function readPdf(arrayBuffer) {
  const pdf = await openPdfDocument(arrayBuffer);
  const sheetNames = Array.from({ length: pdf.numPages }, (_, i) => `${i + 1}ページ`);

  return {
    sheetNames,
    async readSheet(pageLabel) {
      const pageNum = sheetNames.indexOf(pageLabel) + 1;
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      return buildLayoutFromTextContent(textContent.items);
    }
  };
}

/**
 * PDFの指定ページ（"1ページ"等、readPdf()のsheetNamesと同じ形式のラベル）を
 * canvasに描画し、PNGのdata URLとして返す。Phase5の出典ページ表示で使用する。
 */
export async function renderPdfPageImage(blob, pageLabel, scale = 1.5) {
  const arrayBuffer = await blob.arrayBuffer();
  const pdf = await openPdfDocument(arrayBuffer);
  const requestedPage = parseInt(String(pageLabel).replace(/[^0-9]/g, ""), 10) || 1;
  const pageNumber = Math.max(1, Math.min(pdf.numPages, requestedPage));

  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}
