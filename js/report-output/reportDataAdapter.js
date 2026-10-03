/* ==========================================================
   帳票用データモデルへの変換（アダプター層）
   sites/reports/photos/signatures等の内部データ構造と、
   帳票テンプレートが参照するフィールド名を分離するための唯一の
   接続点。将来 日報データ側のフィールド名や構造が変わっても、
   ここだけを直せば全テンプレートに影響が及ばないようにする。
   逆にテンプレート側は、ここで定義した帳票用データモデルの
   フィールド名（site.name, report.date 等）だけを参照し、
   内部データ構造を直接参照してはならない。
   ========================================================== */

function mapCompany(c, signature) {
  return {
    id: c.companyId || "",
    name: c.companyName || "",
    occupation: c.occupation || "",
    plannedWorkerCount: c.plannedWorkerCount || "",
    actualWorkerCount: c.actualWorkerCount || "",
    machinery: c.machinery || "",
    workContent: c.workContent || "",
    safetyNotes: c.safetyNotes || "",
    foremanName: c.foremanName || "",
    // 業者ごとの職長サイン（未署名ならnull）。帳票テンプレート側は
    // company.signature.blobの有無だけを見れば済むようにしてある。
    signature: signature ? { blob: signature.imageBlob, signedAt: signature.signedAt || "" } : null
  };
}

function mapPhoto(p) {
  return { id: p.id, blob: p.blob, mimeType: p.mimeType, caption: p.caption || "" };
}

function mapSignature(s) {
  return {
    role: s.role,
    roleLabel: s.roleLabel || "",
    companyId: s.companyId || "",
    blob: s.imageBlob,
    signedAt: s.signedAt || ""
  };
}

function mapCompanyProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name || "",
    memo: profile.memo || "",
    logoBlob: profile.logoBlob || null,
    logoMimeType: profile.logoMimeType || "",
    hankoBlob: profile.hankoBlob || null,
    hankoMimeType: profile.hankoMimeType || ""
  };
}

import { staffHeadcountForDay } from "../dashboard/dailyFlow.js";

/**
 * 日報1件分の帳票用データモデルを組み立てる。
 * 引数はすべて既存データ層（sites.js/reports.js/photos.js/signatures.js/
 * company-profiles.js）が返す生のレコードをそのまま渡す。
 * cumulativeSiteSupervisorCountは、現場の全日報から集計した「現場監督の
 * 延べ人数（各日報のsiteSupervisorNames件数の合計、この日報の日付まで）」
 * を呼び出し側（generateReportOutput.js）で計算して渡す。ここでは集計を
 * 行わない（このアダプターは1件の日報の変換に閉じているため）。
 */
export function buildReportOutputModel({ site, report, photos = [], signatures = [], companyProfile = null, cumulativeSiteSupervisorCount = null, attendance = null }) {
  const foremanSignatureByCompanyId = new Map(
    signatures.filter((s) => s.role === "foreman" && s.companyId).map((s) => [s.companyId, s])
  );

  return {
    generatedAt: new Date().toISOString(),
    site: {
      id: site?.id || "",
      name: site?.name || "",
      clientName: site?.clientName || "",
      address: site?.address || "",
      startDate: site?.startDate || "",
      endDate: site?.endDate || ""
    },
    report: {
      id: report?.id || "",
      date: report?.date || "",
      weather: report?.weather || "",
      temperature: report?.temperature ? `${report.temperature}℃` : "",
      workerCountTotal: report?.workerCountTotal || "",
      tomorrowPlan: report?.tomorrowPlan || "",
      remarks: report?.remarks || "",
      // 本日の重点指示・作業間の連絡・調整（03-2の同名の欄。日誌の入力項目）
      // 日の状態（"work"/"nowork"/"office"/"holiday"。無ければ通常作業）。作業なし・事務作業日・休工日は稼動人数表に数えない
      dayStatus: ["nowork", "office", "holiday", "rain"].includes(report?.dayStatus) ? report.dayStatus : "work",
      focusInstructions: report?.focusInstructions || "",
      workCoordination: report?.workCoordination || "",
      // 搬入・搬出（03-2の「資材・機材搬入（ＡＭ／ＰＭ）」へ、ダッシュボードと同じく搬入・搬出の両方を書く。direction の無い行は搬入）
      deliveries: (report?.deliveries || []).map((d) => ({ direction: d.direction === "out" ? "out" : "in", time: d.time || "", item: d.item || "", quantity: d.quantity || "", vendor: d.vendor || "", status: d.status || "" })),
      patrolInspectorName: report?.patrolInspectorName || "",
      // 巡回点検の各項目キー→ステータス("good"/"bad"/"na")のマップ。
      // キーはjs/patrolChecklist.jsのPATROL_CHECKLIST_ITEMSと対応する。
      patrolChecklist: report?.patrolChecklist || {},
      patrolComment: report?.patrolComment || "",
      // 現場監督（職員）氏名の一覧。同じ日に複数名が現場にいる場合があるため
      // 単一の名前ではなく配列で持つ。件数が帳票側の稼働人数表・
      // 現場監督(社員)行の「人数」欄への反映で使う。
      siteSupervisorNames: report?.siteSupervisorNames || [],
      // 稼動人数表の「社員」行（O50）に書く監督・職員の人数（dailyFlow.js の staffHeadcountForDay。
      // 監督・職員の稼働人数→未入力なら現場監督の氏名の数、休工日は0人）。業者の行（現場作業員）には混ぜない
      siteSupervisorCount: staffHeadcountForDay(report) ?? 0,
      staffWork: report?.staffWork || "",
      rainCancelledWork: report?.rainCancelledWork || "",
      rainReason: report?.rainReason || "",
      cumulativeSiteSupervisorCount
    },
    companies: (report?.companies || []).map((c) => mapCompany(c, foremanSignatureByCompanyId.get(c.companyId))),
    // 稼動人数表（業種別の累計）用: 現場の日報全体（業種の行の割り当て）と、その日までの日報（累計）。
    // 呼び出し側（generateReportOutput.js）で集めて渡す。無ければ稼動人数表の業種別は書かない
    attendance,
    photos: photos.map(mapPhoto),
    signatures: signatures.map(mapSignature),
    companyProfile: mapCompanyProfile(companyProfile)
  };
}
