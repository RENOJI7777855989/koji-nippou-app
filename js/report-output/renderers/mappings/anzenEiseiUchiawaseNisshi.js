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
   - M2: 「気温：高　　℃:低　　℃」という定型ラベル1セル。
     日報側は気温を1値しか持たないため、高低の書き分けはせず
     ラベルごと{report.temperature}で置き換える。
   - M4: 「天候：　　　　」という定型ラベル1セル。同様に
     {report.weather}で置き換える。
   - M5〜P52: 「稼働人数」表（職種ごとの人数・累計）。M50が
     「社員」行で、現場監督（職員）はこの行を使う。同じ日に複数名の
     現場監督がいる場合があるため、日報側はsiteSupervisorNamesを
     配列で持つ。O50に当日の人数（0人なら元の空欄を維持）、P50に
     累計（その現場の全日報のsiteSupervisorNames件数を、対象日報の
     日付まで合計した延べ人数。generateReportOutput.js側で集計し
     model.report.cumulativeSiteSupervisorCountとして渡される）を書く。
     M49「警備員」・M51「計」・M52「延労働時間」の各行は対応する
     データが無いため触れない。
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
    { cell: "E4", template: "打合日：{report.date|japaneseDate}　　作業日：{report.date|japaneseDate}" },
    { cell: "M2", template: "気温：{report.temperature}" },
    { cell: "M4", template: "天候：{report.weather}" }
  ],

  // 稼働人数表「社員」行（現場監督(職員)用）。
  staffAttendance: {
    headcountCell: "O50",
    cumulativeCell: "P50"
  },

  // 稼動人数表の業種別の人数・累計（tradeAttendance.js）。行の位置と業種名は同梱の03-2（手書印刷用・台帳シート）で確認。
  // 業種名の無い行（26・31・34・40・42・47行目）は、様式に無い業種を書く空き行として使う。
  // 計（51行目）は社員を含む合計、延労働時間（52行目）は計×8時間（台帳シートの数式 O52=O51*8 と同じ）
  tradeAttendance: {
    countColumn: "O",
    cumulativeColumn: "P",
    labelColumn: "M",
    rows: [
      { row: 7, label: "鳶工事" }, { row: 8, label: "墨出し" }, { row: 9, label: "クリーニング" },
      { row: 11, label: "土工事" }, { row: 12, label: "杭打工事" }, { row: 13, label: "鉄筋工事" }, { row: 14, label: "圧接工事" },
      { row: 15, label: "型枠工事" }, { row: 16, label: "型枠解体工事" }, { row: 17, label: "コンクリート工事" }, { row: 18, label: "鉄骨工事" },
      { row: 19, label: "組積工事" }, { row: 20, label: "防水工事" }, { row: 21, label: "石工事" }, { row: 22, label: "タイル工事" },
      { row: 23, label: "木工事" }, { row: 24, label: "屋根・樋工事" }, { row: 25, label: "金属工事" }, { row: 27, label: "左官工事" },
      { row: 28, label: "木製建具工事" }, { row: 29, label: "鋼製建具工事" }, { row: 30, label: "シャッター工事" }, { row: 32, label: "ガラス工事" },
      { row: 33, label: "塗装工事" }, { row: 35, label: "軽量下地" }, { row: 36, label: "GL" }, { row: 37, label: "ボード" },
      { row: 38, label: "クロス" }, { row: 39, label: "床" }, { row: 41, label: "雑工事" }, { row: 43, label: "電気工事" },
      { row: 44, label: "給排水工事" }, { row: 45, label: "空調工事" }, { row: 46, label: "外構工事" }, { row: 48, label: "解体工事" },
      { row: 49, label: "警備員" }
    ],
    freeRows: [26, 31, 34, 40, 42, 47],
    totalRow: 51,
    laborHoursRow: 52,
    hoursPerPerson: 8
  },

  // 本日の重点指示（A40の下の41〜45行目）・作業間の連絡・調整（A46の下の47〜52行目）。1行ずつ書く
  textLines: [
    { path: "report.focusInstructions", cells: ["A41", "A42", "A43", "A44", "A45"] },
    { path: "report.workCoordination", cells: ["A47", "A48", "A49", "A50", "A51", "A52"] }
  ],

  // 資材・機材搬入（ＡＭはA36の下・ＰＭはF36の下の37〜39行目）。ダッシュボードの「本日の搬入・搬出」と同じ内容を時刻で午前・午後に分ける
  deliveriesAmPm: { amCells: ["A37", "A38", "A39"], pmCells: ["F37", "F38", "F39"], noonTime: "12:00" },

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
