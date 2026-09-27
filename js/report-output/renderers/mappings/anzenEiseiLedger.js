/* ==========================================================
   「安全衛生作業打合日誌（6ヶ月分）」の台帳シート用マッピング（データ）
   手書印刷用シートのマッピング（anzenEiseiUchiawaseNisshi.js）とは
   ヘッダーの構造が違うため流用しない。原本の台帳シート「1～20」を
   解析して確認した内容（推測なし）:

   ■ 台帳の起点（先頭の台帳シート1頁目だけにある入力欄）
     F2 … 工事名の値（E2は「工事名：」ラベル）。2頁目以降は =$F$2、
           後続シートは ='1～20'!$F$2:$H$2 の数式で自動表示される
     G4 … 作業日（日付シリアル値）。2頁目以降は「前頁のG＋1」の数式
     E4 … 打合日（日付シリアル値）。2頁目以降は「前頁のG」の数式
           ＝打合日は作業日の前日。原本の記入例もE4=G4−1だった
     → 起点の3セルに書くだけで、全頁の工事名・日付が数式で決まる。
       2頁目以降の日付・工事名のセルは数式なので一切書き込まない。

   ■ 各頁（1頁＝52行。頁内の行位置で指定。出力時に頁の先頭行ぶんずらす）
     J2 … 「気温：高　℃ :低　℃」ラベル1セル。日報の気温は1値なので
           「気温：23℃」のように置き換える。高低2値を持つようになったら
           template を "気温：高{report.temperatureHigh} :低{report.temperatureLow}"
           に替え、requires に両方を書けばよい（コード変更不要）
     J4 … 「天候：」ラベル1セル
     A7〜H34 … 協力会社欄（手書印刷用と同じ位置・同じ1社1行空け）
     L7〜L39 … 巡回点検の状況欄、F41 … 是正指示（手書印刷用と同じ位置）
     O50 … 稼働人数「社員」行の人数。P50（累計）は「O50＋前頁のP50」の
           数式なので書き込まない（数式が累計を計算する）

   requires に挙げた値が空の日は、そのセルを書き換えず原本のラベルを残す。
   数式が入っているセルは、マッピングで指定されていても書き込まない
   （出力処理側で検査し、警告として報告する）。
   ========================================================== */

import { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING } from "./anzenEiseiUchiawaseNisshi.js";

const FORM = ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING;

export const ANZEN_EISEI_LEDGER_MAPPING = {
  kind: "ledger",

  anchor: {
    projectNameCell: "F2",
    projectNameTemplate: "{site.name}",
    workDateCell: "G4",
    meetingDateCell: "E4",
    meetingDateOffsetDays: -1
  },

  page: {
    templates: [
      { cell: "J2", template: "気温：{report.temperature}", requires: ["report.temperature"] },
      { cell: "J4", template: "天候：{report.weather}", requires: ["report.weather"] }
    ],
    // 本文の配置は手書印刷用と同じ（原本で位置・文言の一致を確認済み）
    companiesTable: FORM.companiesTable,
    patrolChecklist: FORM.patrolChecklist,
    staffAttendance: { headcountCell: FORM.staffAttendance.headcountCell }
  }
};
