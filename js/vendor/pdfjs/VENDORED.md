# pdf.js（ベンダリング）

積算PDFのテキスト抽出（`js/estimate/pdfWorkbookReader.js`）に使用する、Mozilla製 [pdf.js](https://github.com/mozilla/pdf.js) の同梱コピー。

- パッケージ: `pdfjs-dist`
- バージョン: 6.2.108
- 取得元: `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/`
- ライセンス: Apache License 2.0（`LICENSE`ファイル参照）

外部依存なし方針のため、npm経由でのビルド時解決ではなく静的ファイルとして同梱している。実行時にCDN・外部サーバーへは一切アクセスしない。

含まれるファイル:
- `pdf.min.mjs` / `pdf.worker.min.mjs` — 本体・Web Worker（テキスト抽出のみ使用。描画・注釈・フォームは未使用）
- `cmaps/` — 埋め込みでない日本語フォント等の文字コード解決に必要な外部CMap
- `standard_fonts/` — フォールバック用の標準14フォントメトリクス

更新する場合は、上記バージョン番号を変えて同じ手順（本体・Worker・cmaps・standard_fonts・LICENSEを取得）を繰り返す。
