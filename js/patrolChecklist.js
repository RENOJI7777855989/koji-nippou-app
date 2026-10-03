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

/* ----------------------------------------------------------
   巡回点検の状況（表示・帳票の出力時に判定する。DBには書き込まない）
   優先順: ①実際の点検記録（○×－のどれか、または是正指示）があればそれを出す（日の状態に関係なく）
           ②記録が無く、休工日・作業なし（現場作業なし）・事務作業日 → 未実施（03-2では巡回点検の欄を斜線）
           ③日報そのものが無い → 記録なし（未実施とは判定しない。03-2も斜線にしない）
           ④通常作業で記録が無い → 未記入
   ×や是正指示は「要確認」とし、対応状況（対応済み・未対応など）は推測しない（DBに無い）。
   ---------------------------------------------------------- */
const PATROL_NOT_DONE_LABELS = { nowork: "未実施（現場作業なし）", office: "未実施（事務作業日）", holiday: "未実施（休工日）", rain: "未実施（雨天作業不可日）" };
const nonWorkDayStatus = (report) => (["nowork", "office", "holiday", "rain"].includes(report?.dayStatus) ? report.dayStatus : null);

/** 実際の巡回点検の記録があるか（○・×・－のどれか、または是正指示） */
export function hasPatrolRecord(report) {
  const answers = report?.patrolChecklist || {};
  return PATROL_CHECKLIST_ITEMS.some((i) => ["good", "bad", "na"].includes(answers[i.key])) || !!String(report?.patrolComment || "").trim();
}

/**
 * その日の巡回点検の状況
 * @returns {{state: "none"|"notdone"|"blank"|"done"|"attention", label: string}}
 *   none=記録なし（日報なし） / notdone=未実施（休工日等） / blank=未記入（通常作業で記録なし） / done=実施 / attention=要確認（×または是正指示）
 */
export function patrolStatusOf(report) {
  if (!report) return { state: "none", label: "記録なし" };
  if (hasPatrolRecord(report)) {
    const answers = report.patrolChecklist || {};
    const bad = PATROL_CHECKLIST_ITEMS.some((i) => answers[i.key] === "bad");
    return bad || String(report.patrolComment || "").trim() ? { state: "attention", label: "要確認" } : { state: "done", label: "実施" };
  }
  const st = nonWorkDayStatus(report);
  if (st) return { state: "notdone", label: PATROL_NOT_DONE_LABELS[st] };
  return { state: "blank", label: "未記入" };
}

/** 03-2の巡回点検の欄を斜線にするか（休工日・現場作業なし・雨天作業不可日・事務作業日で、実際の点検記録が無い日だけ。日報なしは対象外） */
export const patrolSlashApplies = (report) => !!report && !!nonWorkDayStatus(report) && !hasPatrolRecord(report);
