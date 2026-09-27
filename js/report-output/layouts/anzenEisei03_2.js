/* ==========================================================
   レイアウトプロファイル: 03-2 安全衛生作業打合日誌（6ヶ月分）
   現時点で使う標準書式。会社側で書式が更新された場合は、テンプレートを
   差し替えたうえで、セル位置が変わったときだけマッピング（このプロファイルの
   参照先のmappings/*.js）を直せばよい。
   ========================================================== */

import { registerLayoutProfile } from "../layoutProfiles.js";
import { ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING } from "../renderers/mappings/anzenEiseiUchiawaseNisshi.js";
import { ANZEN_EISEI_LEDGER_MAPPING } from "../renderers/mappings/anzenEiseiLedger.js";

export const ANZEN_EISEI_03_2_LAYOUT_ID = "anzen-eisei-03-2";

registerLayoutProfile({
  id: ANZEN_EISEI_03_2_LAYOUT_ID,
  label: "安全衛生作業打合日誌（03-2）",
  dailyMapping: ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING,
  ledgerMapping: ANZEN_EISEI_LEDGER_MAPPING,
  // 1日分の様式シート（マッピングのsheetName）がある.xlsxをこの様式とみなす
  detect: ({ sheetNames }) => sheetNames.includes(ANZEN_EISEI_UCHIAWASE_NISSHI_MAPPING.sheetName)
});
