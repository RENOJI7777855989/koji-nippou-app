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

/**
 * 日報1件分の帳票用データモデルを組み立てる。
 * 引数はすべて既存データ層（sites.js/reports.js/photos.js/signatures.js/
 * company-profiles.js）が返す生のレコードをそのまま渡す。
 * cumulativeSiteSupervisorCountは、現場の全日報から集計した「現場監督の
 * 延べ人数（各日報のsiteSupervisorNames件数の合計、この日報の日付まで）」
 * を呼び出し側（generateReportOutput.js）で計算して渡す。ここでは集計を
 * 行わない（このアダプターは1件の日報の変換に閉じているため）。
 */
export function buildReportOutputModel({ site, report, photos = [], signatures = [], companyProfile = null, cumulativeSiteSupervisorCount = null }) {
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
      patrolInspectorName: report?.patrolInspectorName || "",
      // 巡回点検の各項目キー→ステータス("good"/"bad"/"na")のマップ。
      // キーはjs/patrolChecklist.jsのPATROL_CHECKLIST_ITEMSと対応する。
      patrolChecklist: report?.patrolChecklist || {},
      patrolComment: report?.patrolComment || "",
      // 現場監督（職員）氏名の一覧。同じ日に複数名が現場にいる場合があるため
      // 単一の名前ではなく配列で持つ。件数が帳票側の稼働人数表・
      // 現場監督(社員)行の「人数」欄への反映で使う。
      siteSupervisorNames: report?.siteSupervisorNames || [],
      siteSupervisorCount: (report?.siteSupervisorNames || []).filter((n) => n && n.trim()).length,
      cumulativeSiteSupervisorCount
    },
    companies: (report?.companies || []).map((c) => mapCompany(c, foremanSignatureByCompanyId.get(c.companyId))),
    photos: photos.map(mapPhoto),
    signatures: signatures.map(mapSignature),
    companyProfile: mapCompanyProfile(companyProfile)
  };
}
