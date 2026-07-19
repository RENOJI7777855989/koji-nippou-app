# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 開発ルール（重要）

このプロジェクトでは日本語で開発する。説明・質問・コード中のコメント・コミットメッセージ・ドキュメントは日本語で書くこと。

## 概要

工事日報アプリ — ビルド不要・外部依存なしの静的1ページWebアプリ。現場の日報（日付・工事名・天気・業者ごとの作業内容・明日の予定）を入力し、ブラウザの `localStorage` に保存する。保存済み日報は一覧表示・削除ができる。

## 開発方針（ユーザー指定）

- UIを完成させる
- Windows・iPad・iPhoneで利用できるようにする（レスポンシブレイアウト、タップ操作を考慮）
- データを安全に保存できるようにする（現状はlocalStorageのみ。将来的にエクスポート/インポート等を追加予定）
- 会社指定のExcel様式に後から対応できる設計にする（様式は未提供のため、現時点では様式に依存しない内部データ構造を維持すること）
- PDF印刷機能を追加できるようにする（現時点では未実装。将来 `@media print` や印刷/PDF出力機能を追加する前提でデータ層とUI層を分離してある）

開発はフェーズ制で進めている：①UI改善（一覧・削除・入力チェック・レスポンシブ） → ②データ保存の安全性向上（エクスポート/インポート等） → ③出力基盤の整備（印刷CSSなど） → ④PDF出力 → ⑤Excel様式対応（様式受領後）。

## 実行方法

ビルド／開発サーバーの仕組みはない。`index.html` をブラウザで直接開くか、`file://` 制限に当たる場合は `python3 -m http.server` 等で配信する。

テスト・リンター・パッケージマネージャは未設定。

## アーキテクチャ

3ファイル構成、フレームワークなし：

- `index.html` — フォーム本体（日付・工事名・天気・明日の予定）と、業者行を動的追加する空の `#companiesContainer`、保存済み日報一覧を表示する `#reportList` を持つ。
- `script.js` — 6セクション構成（ファイル冒頭のコメント参照）。
  - **データ層**（`loadReports` / `saveReports` / `addReport` / `deleteReport`）が `localStorage`（キー: `dailyReports`）への読み書きを一手に担う。画面ロジックはこの層を経由してのみデータへアクセスする。将来Excel出力や保存先変更を行う際は、この層だけを差し替えれば済むように分離してある。
  - 各日報オブジェクトは `id`（`crypto.randomUUID` ベース）を持つ。一覧描画・削除は配列のインデックスではなく `id` で行う。
  - `addCompanyRow()` が業者ブロックをテンプレート文字列で生成し `#companiesContainer` に追加する。業者名などのデータはフォーム送信時に `.company-row` 内のクラス名（`.companyName` / `.workerCount` / `.workContent` / `.safetyNotes`）から読み出す。`name`/`id` 属性ではなくクラス名に依存しているため、業者欄にフィールドを追加する場合もこのパターンを踏襲すること。
  - ユーザー入力を `innerHTML` で一覧表示に埋め込むため `escapeHtml()` を必ず通す。
  - 保存前に日付・工事名の必須チェックを行い（`validateForm`）、保存成功後はフォームを初期状態にリセットする（`resetForm`）。
- `style.css` — プレーンCSS。700px未満はスマホ想定の1カラム、700px以上でフォームを2カラム化（iPad想定）、900px以上でさらに幅を拡張（Windows/PC想定）。

現時点で未実装：日報データのエクスポート/インポート、印刷・PDF出力、Excel様式へのマッピング（様式は後日提供予定のため保留中）。

## 帳票出力（Excel・PDF）の設計

`js/report-output/` に、会社（提出先の元請）ごとに異なるExcel/PDF様式へ対応するための出力基盤がある。会社指定の様式は未受領のため、実際のレイアウトはまだ実装しておらず、今後テンプレートを追加するだけで対応できる構成のみを用意してある。

- **日報データと帳票レイアウトの分離**: `reportDataAdapter.js` の `buildReportOutputModel()` が、`sites.js`/`reports.js`/`photos.js`/`signatures.js` の内部データ構造を、帳票テンプレートだけが参照する中立なデータモデル（`site.name` / `report.date` / `companies[].name` 等）に変換する。テンプレートはこのモデルのフィールド名だけを参照し、内部データ構造を直接参照してはならない。内部データ構造が変わってもここだけ直せばよい。
- **会社プロファイル**（`companyProfiles.js`、IndexedDB `companyProfiles` ストア）: 提出先の元請ごとに、ロゴ・印影（Blob）と既定テンプレートIDを保持する。`sites`/`reports` ストアとは独立しており、既存の現場・日報データやUIには一切変更を加えていない。
- **帳票テンプレート**（`reportTemplates.js`、IndexedDB `reportTemplates` ストア）: 1レコードが「会社プロファイルID・形式(excel/pdf)・使用するレンダラーID・マッピング（データ項目→Excelセル or PDFレイアウト設定）」を持つ。マッピングをコードではなくデータとして持たせているため、将来の設定画面からセル対応などを変更できる。
- **レンダラーレジストリ**（`rendererRegistry.js`）: `registerExcelRenderer(id, fn)` / `registerPdfRenderer(id, fn)` で実際の生成処理を登録する。新しい会社様式を追加する場合、`renderers/` 配下に新しいレンダラーファイルを1つ追加し `renderers/index.js` に1行importを足すだけでよく、アダプター・レジストリ・オーケストレーターは変更不要。
  - 既定Excelレンダラー（`renderers/excelDefault.js`, id: `default-csv`）: セル参照文字列（例: `B2`）とデータ項目のマッピングからグリッドを組み立てCSVを出力する暫定実装。外部依存なし方針のため、真の`.xlsx`バイナリ生成（OOXML/zip）は未実装。マッピング形式自体は`.xlsx`実装に差し替えてもそのまま使える設計にしてある。
  - 既定PDFレンダラー（`renderers/pdfDefault.js`, id: `default-print-html`）: 印刷用HTML文書を組み立てるだけの実装。実際のPDF化（印刷ダイアログ経由の保存）は将来のUI層（フェーズ④）が担う。
- **オーケストレーター**（`generateReportOutput.js`）: `generateReportOutput({ reportId, format, companyProfileId, templateId })` が唯一の公開エントリーポイント。会社プロファイル・テンプレートが未登録でも組み込みの汎用テンプレートにフォールバックするため、様式整備前でも動作する。将来のUI（出力ボタン等）はこの関数と `report-output/index.js` が再エクスポートするCRUD関数だけを呼べばよい。

この基盤の追加にあたり、`sites.js`/`reports.js`/`photos.js`/`signatures.js`/`js/ui/`配下・`index.html` は一切変更していない（`db.js`へのストア追加のみ、既存ストアには影響しない）。
