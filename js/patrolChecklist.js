/* ==========================================================
   巡回点検記録の項目マスタ
   ここで定義するkeyが、日報フォームの入力項目と帳票マッピング
   （js/report-output/renderers/mappings/配下）を結びつける唯一の
   識別子になる。項目文言はどのExcel様式に合わせて書き換えるにせよ、
   keyだけは変えない（マッピング側もこのkeyで参照しているため）。
   ========================================================== */

export const PATROL_CHECKLIST_ITEMS = [
  { key: "morningMeeting", category: "管理", label: "安全朝礼・KY活動" },
  { key: "qualificationCheck", category: "管理", label: "資格確認・就業制限" },
  { key: "warningSigns", category: "管理", label: "標識（注意・立入禁止等）" },
  { key: "helmetWear", category: "管理", label: "保護帽（具）安全着用" },
  { key: "workLeaderCheck", category: "管理", label: "作業主任者の確認" },

  { key: "tidyPassage", category: "環境", label: "整理整頓（通路,不要材）" },
  { key: "restArea", category: "環境", label: "休憩所,詰所,便所等" },

  { key: "scaffoldBridge", category: "仮設設備", label: "足場,桟橋" },
  { key: "liftingEquipment", category: "仮設設備", label: "昇降設備" },
  { key: "fallingObjectPrevention", category: "仮設設備", label: "飛来落下防止設備" },

  { key: "fallProtectionHarness", category: "墜落防止", label: "高所作業の安全帯着用" },
  { key: "workPlatformHandrail", category: "墜落防止", label: "作業床,手摺" },
  { key: "openingUsage", category: "墜落防止", label: "開口部　開口部使用・復旧" },
  { key: "safetyNet", category: "墜落防止", label: "親綱・安全ネット" },

  { key: "machineryPermit", category: "建設機械関連", label: "持込許可の届出" },
  { key: "legalInspection", category: "建設機械関連", label: "法定定期点検" },
  { key: "licenseQualification", category: "建設機械関連", label: "免許・資格" },
  { key: "wireAuxiliary", category: "建設機械関連", label: "ワイヤー・補助具" },
  { key: "restrictedEntry", category: "建設機械関連", label: "立入禁止・制限" },
  { key: "slingSignal", category: "建設機械関連", label: "作業状態　玉掛用具,合図" },

  { key: "formworkSupport", category: "崩壊防止", label: "型枠支保工" },
  { key: "earthRetaining", category: "崩壊防止", label: "土止め，切梁，矢板" },
  { key: "excavationSlope", category: "崩壊防止", label: "掘削・勾配等" },

  { key: "panelEarthing", category: "電気", label: "分電盤，取扱者,アース" },
  { key: "secondaryWiring", category: "電気", label: "二次配線・電路表示" },
  { key: "exposedWire", category: "電気", label: "電線（充電部の露出）" },
  { key: "overheadLineProtection", category: "電気", label: "架空線の養生" },

  { key: "fireHandling", category: "火災", label: "作業場の火気取扱" },
  { key: "fireExtinguisher", category: "火災", label: "消火・避難器具" },
  { key: "gasCylinder", category: "火災", label: "ガスボンベ類,付属品" },

  { key: "wasteHandling", category: "その他", label: "汚物処理,手洗場等" },
  { key: "garbageVentilation", category: "その他", label: "ゴミの持ち帰り,換気" },
  { key: "enclosureEntrance", category: "その他", label: "仮囲い,出入口" }
];

export const PATROL_STATUS_OPTIONS = [
  { value: "", label: "未確認" },
  { value: "good", label: "良" },
  { value: "bad", label: "否" },
  { value: "na", label: "該当なし" }
];
