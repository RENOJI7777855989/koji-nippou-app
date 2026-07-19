/* ==========================================================
   「安全衛生作業打合日誌」帳票用のマッピング定義（データ）
   このファイルはレイアウト解釈の結果を持つ設定値であり、
   レンダラー(excelXlsxTemplate.js)のロジックは一切含まない。
   別会社の様式に対応する場合は、このファイルと同じ形の
   マッピングオブジェクトを新しいxlsxテンプレートと一緒に
   reportTemplatesレコードのmappingフィールドへ登録すればよく、
   レンダラー側のコード変更は不要。

   対象シート「手書印刷用」の構造（元ファイルを解析して確認済み）:
   - E2: 「工事名：（空欄）」という1セルの定型ラベル
   - E4: 「打合日：年月日（）　作業日：年月日（）」という
         2つの日付が同居する1セルの定型ラベル
   - A7〜H34（28行）: 協力会社ごとの記入欄
     A=協力会社名 B=職種 C=予定人数 D=実績人数
     E=作業内容 G=作業及び安全に関する指示・注意事項
     H=職長印/サイン（画像を貼り付ける列）
   - ユーザー指示により、1社ごとに1行空欄を残す（rowStep: 2）。
     A7に1社目、A9に2社目…という配置になり、A8・A10…は元の空欄の
     まま何も書き込まない。この結果、最大記入可能数は28行÷2=14社。
   - 「職長名」を書く欄はこのテンプレートに存在しないため未使用。
     名前欄のある様式を追加する場合は、columnsに
     foremanName: "セル列" を1行足すだけでよい。
   - I7〜L39: 巡回点検記録。J列(結合J:K)に点検項目文言、L列がその行の
     状況記入欄（○=良好／×=不良、の手書き想定）。項目キーは
     js/patrolChecklist.jsのPATROL_CHECKLIST_ITEMSと1:1対応させてある。
   - F41: 「・巡回点検項目に対する是正指示」ラベル(F40)直下の空欄
     （コメント記入欄）。
   - 「巡回者」の氏名を書ける専用欄はこのテンプレートに存在しない
     （N1/O1/P1は所長／主任／工事担当者の印鑑欄で、氏名記入には
     幅・用途とも不適のため転記対象から除外している）。
   ========================================================== */

export const ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING = {
  sheetName: "手書印刷用",

  // 「シートを1ページに合わせる」拡大縮小印刷を有効にする（ユーザー許可済みの
  // 唯一の例外的な印刷設定変更）。セル・行高さ・列幅・結合・余白は変更しない。
  // 元テンプレートのpageSetupにfitToWidth/fitToHeightが無い場合のみ適用される。
  fitToPage: { width: 1, height: 1 },

  // ラベル文字列＋空欄が1セルに同居している項目は、テンプレート文字列で
  // 元のラベルを保ったまま値だけを差し込む（{フィールドパス|フォーマッタ}）
  templates: [
    { cell: "E2", template: "工事名：{site.name}" },
    { cell: "E4", template: "打合日：{report.date|japaneseDate}　　作業日：{report.date|japaneseDate}" }
  ],

  // 協力会社ごとの繰り返し欄。company-table開始行から1社1行で埋める。
  companiesTable: {
    startCell: "A7",
    maxRows: 28, // テンプレートの罫線がA7〜A34までしか無いための上限
    rowStep: 2, // 1社ごとに1行空けて記入する（A7,A9,A11...）
    columns: {
      name: "A",
      occupation: "B",
      plannedWorkerCount: { column: "C", numeric: true },
      actualWorkerCount: { column: "D", numeric: true },
      workContent: "E",
      safetyNotes: "G"
      // foremanName: "X" ← 名前欄のある様式ではここに列を追加する
    },
    signatureColumn: "H" // company.signature.blob があればこの列へ画像を貼る
  },

  // 巡回点検記録。未確認（""）の項目は元の空欄のまま何も書き込まない。
  patrolChecklist: {
    goodMark: "○",
    badMark: "×",
    naMark: "－",
    commentCell: "F41",
    itemCells: {
      morningMeeting: "L7",
      qualificationCheck: "L8",
      warningSigns: "L9",
      helmetWear: "L10",
      workLeaderCheck: "L11",
      tidyPassage: "L12",
      restArea: "L13",
      scaffoldBridge: "L14",
      liftingEquipment: "L15",
      fallingObjectPrevention: "L16",
      fallProtectionHarness: "L17",
      workPlatformHandrail: "L18",
      openingUsage: "L19",
      safetyNet: "L20",
      machineryPermit: "L21",
      legalInspection: "L22",
      licenseQualification: "L23",
      wireAuxiliary: "L24",
      restrictedEntry: "L25",
      slingSignal: "L26",
      formworkSupport: "L27",
      earthRetaining: "L28",
      excavationSlope: "L29",
      panelEarthing: "L30",
      secondaryWiring: "L31",
      exposedWire: "L32",
      overheadLineProtection: "L33",
      fireHandling: "L34",
      fireExtinguisher: "L35",
      gasCylinder: "L36",
      wasteHandling: "L37",
      garbageVentilation: "L38",
      enclosureEntrance: "L39"
    }
  }
};
