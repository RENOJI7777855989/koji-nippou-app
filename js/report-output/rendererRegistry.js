/* ==========================================================
   帳票レンダラーレジストリ
   新しい会社様式に対応する最も基本的な方法は、
   renderers/配下に新しいレンダラーファイルを追加し、
   renderers/index.jsに1行importを足すことである。
   このレジストリ自体やアダプター・オーケストレーター
   (generateReportOutput.js)は変更不要。

   Excelレンダラーのシグネチャ:
     (model: ReportOutputModel, mapping: object, companyProfile, template) => { blob: Blob, filename: string } | Promise<...>
   PDFレンダラーのシグネチャ:
     (model: ReportOutputModel, mapping: object, companyProfile, template) => Promise<{ html: string, filename: string }>
       html は印刷用の独立したHTML文書。実際のPDF化（印刷ダイアログ経由の
       PDF保存）はUI層（将来実装）が担う。
   第4引数templateは帳票テンプレートレコード全体（reportTemplates.jsの
   1件）で、sourceFileBlob等マッピング以外の情報（元.xlsxファイル本体等）が
   必要なレンダラー（例: xlsx-template-patch）のために渡している。
   ========================================================== */

const excelRenderers = new Map();
const pdfRenderers = new Map();

export function registerExcelRenderer(id, renderFn) {
  excelRenderers.set(id, renderFn);
}

export function registerPdfRenderer(id, renderFn) {
  pdfRenderers.set(id, renderFn);
}

export function getExcelRenderer(id) {
  const fn = excelRenderers.get(id);
  if (!fn) throw new Error(`未登録のExcelレンダラーです: ${id}`);
  return fn;
}

export function getPdfRenderer(id) {
  const fn = pdfRenderers.get(id);
  if (!fn) throw new Error(`未登録のPDFレンダラーです: ${id}`);
  return fn;
}

export function listExcelRendererIds() {
  return [...excelRenderers.keys()];
}

export function listPdfRendererIds() {
  return [...pdfRenderers.keys()];
}
