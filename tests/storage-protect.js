// 保存データの保護（navigator.storage.persist。js/storagePersist.js）を確かめる（Chromium。ブラウザの返事は差し替えて再現する）。
//   ・起動時に一度だけ persist() を求める（すでに許可されていれば求めない）
//   ・バックアップ管理の画面には、ブラウザが返した結果だけを出す（許可されていないのに「保護済み」と出さない）
//   ・ホーム画面への追加と、定期的なバックアップの案内を出す。データは移さない・消さない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

/** navigator.storage の返事を差し替える（mode: granted=すでに許可 / deny=求めても許可されない / grant=求めると許可 / none=仕組みが無い） */
const fakeStorage = (mode) => {
  window.__persistCalls = 0;
  const real = navigator.storage;
  let persisted = mode === "granted";
  const fake = mode === "none" ? undefined : {
    persisted: async () => persisted,
    persist: async () => { window.__persistCalls++; if (mode === "grant") persisted = true; return persisted; },
    estimate: async () => ({ usage: 3 * 1024 * 1024, quota: 500 * 1024 * 1024 }),
    getDirectory: real?.getDirectory?.bind(real)
  };
  Object.defineProperty(navigator, "storage", { configurable: true, get: () => fake });
};

(async () => {
  const errors = [];
  const run = async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-protect-"));
    const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
    await ctx.addInitScript(fakeStorage, mode);
    const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
    await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");
    // 現場を1件作って、保護の処理でデータが変わらないことも見る
    const before = await page.evaluate(async () => { const { createSite } = await import("/js/sites.js"); await createSite({ name: "保護の確認現場", startDate: "2026-09-01" }); return JSON.stringify((await (await import("/js/db.js")).dbGetAll("sites")).map((s) => [s.id, s.updatedAt])); });
    await page.waitForTimeout(500);
    const calls = await page.evaluate(() => window.__persistCalls);
    await page.goto(`${BASE}#/backup`); await page.waitForSelector("#storageProtection h3"); await page.waitForTimeout(300);
    const text = await page.textContent("#storageProtection");
    const cls = await page.getAttribute("#storageProtection .storage-protection-state", "class");
    const after = await page.evaluate(async () => JSON.stringify((await (await import("/js/db.js")).dbGetAll("sites")).map((s) => [s.id, s.updatedAt])));
    await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
    return { calls, text, cls, same: before === after };
  };

  let r = await run("deny");
  check("許可されないブラウザ: 起動時に persist() を1回求める", r.calls === 1, `呼び出し ${r.calls}回`);
  check("許可されないブラウザ: 「まだ許可していません」と出し、保護済みとは出さない（警告の色）", r.text.includes("まだ許可していません") && !r.text.includes("許可しています（") && r.cls.includes("is-warn"), r.text.slice(0, 80));
  check("ホーム画面への追加と、定期的なバックアップ（端末の外にも保存）を案内する", r.text.includes("ホーム画面に追加") && r.text.includes("フルバックアップを作成してダウンロード") && r.text.includes("端末の外"));
  check("使用量が分かれば表示する（3.0MB・上限の目安 500.0MB）", r.text.includes("3.0MB") && r.text.includes("500.0MB"));
  check("保護の処理では保存データ（現場）は変わらない", r.same);
  r = await run("grant");
  check("求めると許可されるブラウザ: 1回求め、「許可しています（ブラウザが返した結果）」と出す", r.calls === 1 && r.text.includes("許可しています（ブラウザが返した結果）") && r.cls.includes("is-ok"), r.text.slice(0, 60));
  check("許可されていても、故障・初期化・機種変更では消えるので定期的なバックアップが必要と出す", r.text.includes("端末の故障・初期化・機種変更"));
  r = await run("granted");
  check("すでに許可されているときは、もう一度は求めない", r.calls === 0 && r.text.includes("許可しています"));
  r = await run("none");
  check("仕組みが無いブラウザ: エラーにせず「確認できません」と出す（保護済みとは出さない）", r.text.includes("確認できません") && !r.text.includes("許可しています") && r.same);

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
