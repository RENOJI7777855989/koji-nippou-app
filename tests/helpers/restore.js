// バックアップからの復元を、画面の手順どおりに行う（2026-10-18 の新しい復元の流れ）。
//   ファイルを選ぶ → 検査・復元の内容を表示 → 復元前のバックアップを作成（読み直して確認）→「保存したことを確認」→ 復元する
//   検査で問題があれば、その一覧を例外にして返す（復元しない）。選んで復元するもの（競合・復元候補）は既定で選ばない。
//   options.applyAll: true のときだけ「すべて復元する」を押す
async function restoreViaUi(page, zipPath, { applyAll = false } = {}) {
  await page.waitForSelector("#restoreFileInput");
  await page.setInputFiles("#restoreFileInput", zipPath);
  await page.waitForFunction(() => document.getElementById("backupRestoreDialog")?.open, null, { timeout: 60000 });
  const errors = await page.$eval("#restoreErrors", (el) => (el.hidden ? "" : el.textContent));
  if (errors) throw new Error(`復元の検査で問題: ${errors.replace(/\s+/g, " ").slice(0, 300)}`);
  if (applyAll && (await page.$('#restoreChoices [data-restore-all="1"]'))) await page.click('#restoreChoices [data-restore-all="1"]');
  await page.click("#restorePreBackupBtn");
  await page.waitForFunction(() => !document.getElementById("restorePreBackupConfirmLabel").hidden || /作成できませんでした/.test(document.getElementById("restorePreBackupStatus").textContent), null, { timeout: 60000 });
  const pre = await page.textContent("#restorePreBackupStatus");
  if (!/作成しました/.test(pre)) throw new Error(`復元前のバックアップ: ${pre}`);
  await page.check("#restorePreBackupConfirm");
  await page.click("#restoreApplyBtn");
  await page.waitForFunction(() => !document.getElementById("backupRestoreDialog").open || /復元できませんでした/.test(document.getElementById("restoreStatus").textContent), null, { timeout: 60000 });
  const status = await page.textContent("#restoreStatus");
  if (/復元できませんでした/.test(status)) throw new Error(status);
  return { preBackup: pre };
}
module.exports = { restoreViaUi };
