// 危険予知活動表（紙のKY活動表）の提出対象を日報の業者から自動で作る（2026-10-27。架空データ・Chromium・隔離したプロファイル）
//   ・その日の日報（通常作業の日）の業者名が、提出対象（未提出）に自動で入る。日報に業者を足せば対象も増える
//   ・監督が外した業者は、日報に残っていても再読み込みで戻らない。監督が戻せる（新しい記録・未提出から）
//   ・提出状況・提出時刻は日報と独立（日報の編集・削除・確認・署名で変わらない。KY の操作で日報も変わらない）
//   ・業者名は完全一致（前後の空白だけ除く）。現場・日付ごとに別の記録。保存に失敗したら成功したように見せない
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };
const D1 = "2026-10-01", D3 = "2026-10-03";

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ky-sync-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1180, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async ([D1, D3]) => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const co = (id, name) => ({ companyId: id, companyName: name, occupation: "塗装", plannedWorkerCount: "2", actualWorkerCount: "2", workContent: "作業" });
    const s1 = await createSite({ name: "KY連動の試験1", startDate: "2026-10-01", endDate: "2026-10-10" });
    const s2 = await createSite({ name: "KY連動の試験2", startDate: "2026-10-01", endDate: "2026-10-10" });
    const r1 = stampNew({ siteId: s1.id, date: D1, dayStatus: "work", companies: [co("a", "アオバ塗装工業"), co("b", "イズミ足場工業")] });
    const r2 = stampNew({ siteId: s1.id, date: "2026-10-02", dayStatus: "holiday", companies: [co("k", "キタノ土建")] }); // 休工日の業者は自動で入れない
    const r3 = stampNew({ siteId: s1.id, date: D3, dayStatus: "work", companies: [co("x", "アオバ塗装工業"), co("y", "アオバ塗装工業 "), co("z", "アオバ塗装"), co("w", "ｱｵﾊﾞ塗装工業")] });
    const r4 = stampNew({ siteId: s2.id, date: D1, dayStatus: "work", companies: [co("p", "アオバ塗装工業")] });
    for (const r of [r1, r2, r3, r4]) await dbPut("reports", r);
    return { s1: s1.id, s2: s2.id, r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id };
  }, [D1, D3]);

  const kyOf = (siteId, date) => page.evaluate(async ([sid, d]) => (await (await import("/js/db.js")).dbGetAll("kySubmissions", "by_siteId", sid)).filter((r) => r.date === d)
    .map((r) => ({ id: r.id, n: r.vendorName, removed: !!r.removed, submitted: !!r.submitted, at: r.submittedAt || null, hist: (r.history || []).length })), [siteId, date]);
  const active = (l) => l.filter((r) => !r.removed);
  const rows = () => page.$$eval("#siteDashboard .dash-ky-table tbody tr", (trs) => trs.map((tr) => ({ n: tr.querySelector("td b").textContent, state: tr.className.replace("ky-", ""), time: tr.querySelectorAll("td")[2].textContent.trim(), noReport: !!tr.querySelector(".dash-ky-noreport") })));
  const openDay = async (siteId, date) => {
    await page.goto(`${BASE}#/sites`); await page.waitForTimeout(150);
    await page.evaluate(([s, d]) => { window.__dashboardDate = { siteId: s, date: d }; }, [siteId, date]);
    await page.goto(`${BASE}#/sites/${siteId}`); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(700);
    await page.click("#siteDashboard .dash-tab[data-tab=manage]"); await page.waitForTimeout(200);
  };
  const reportJson = (id) => page.evaluate(async (id) => JSON.stringify(await (await import("/js/db.js")).dbGet("reports", id)), id);

  // ---- 1 日報の業者が自動で提出対象（未提出）に入る ----
  await openDay(ids.s1, D1);
  let rs = await rows();
  check("1 日報の業者（アオバ塗装工業・イズミ足場工業）が提出対象に自動で入る（未提出・提出時刻なし）", rs.map((r) => r.n).join() === "アオバ塗装工業,イズミ足場工業" && rs.every((r) => r.state === "not_submitted" && r.time === "—"), JSON.stringify(rs));
  const r1Before = await reportJson(ids.r1);
  await openDay(ids.s1, "2026-10-02");
  check("休工日の日報の業者は自動では入らない（監督が入れれば登録できる）", (await kyOf(ids.s1, "2026-10-02")).length === 0);

  // ---- 2 日報に業者を足すと提出対象にも入る ----
  await page.evaluate(async (id) => { const { updateReport } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js"); const r = await dbGet("reports", id); await updateReport(id, { companies: [...r.companies, { companyId: "c", companyName: "ウエノ建設", occupation: "足場", plannedWorkerCount: "1", actualWorkerCount: "1", workContent: "作業" }] }); }, ids.r1);
  await openDay(ids.s1, D1);
  rs = await rows();
  check("2 日報に業者（ウエノ建設）を足すと、提出対象にも入る（未提出）", rs.map((r) => r.n).join() === "アオバ塗装工業,イズミ足場工業,ウエノ建設" && rs[2].state === "not_submitted", JSON.stringify(rs));
  const r1AfterAdd = await reportJson(ids.r1);

  // ---- 3 監督が不要な業者を削除できる（業者名を確認してから） ----
  const izumi = active(await kyOf(ids.s1, D1)).find((r) => r.n === "イズミ足場工業");
  await page.click(`[data-ky-delete="${izumi.id}"]`); await page.waitForFunction(() => document.getElementById("kyDeleteDialog").open);
  const dlg = (await page.textContent("#kyDeleteDialog")).replace(/\s+/g, " ");
  await page.click("#kyDeleteConfirmBtn"); await page.waitForTimeout(600);
  rs = await rows();
  check("3 削除の確認に業者名が出て、削除すると提出対象から消える（日報の業者は消えない）", dlg.includes("「イズミ足場工業」を削除しますか？") && dlg.includes("自動では提出対象に戻りません") && !rs.some((r) => r.n === "イズミ足場工業") && JSON.parse(await reportJson(ids.r1)).companies.some((c) => c.companyName === "イズミ足場工業"), dlg);

  // ---- 4 再読み込みしても戻らない ----
  await page.reload(); await page.waitForTimeout(400); await openDay(ids.s1, D1);
  rs = await rows();
  const chips = await page.$$eval("#siteDashboard .dash-ky-removed [data-ky-add]", (bs) => bs.map((b) => b.dataset.kyAdd));
  check("4 再読み込みしても、外した業者は提出対象に戻らない（「提出対象から外した業者」に出る）", !rs.some((r) => r.n === "イズミ足場工業") && chips.join() === "イズミ足場工業" && active(await kyOf(ids.s1, D1)).length === 2, JSON.stringify({ rs, chips }));

  // ---- 5 監督が戻せる ----
  await page.click('#siteDashboard .dash-ky-removed [data-ky-add="イズミ足場工業"]'); await page.waitForTimeout(500);
  rs = await rows();
  const izumi2 = (await kyOf(ids.s1, D1)).filter((r) => r.n === "イズミ足場工業");
  check("5 外した業者を戻せる（未提出・提出時刻なし・記録は1件だけ）", rs.some((r) => r.n === "イズミ足場工業" && r.state === "not_submitted" && r.time === "—") && izumi2.length === 1 && !izumi2[0].removed && !izumi2[0].at, JSON.stringify(izumi2));

  // ---- 6 提出済みと提出時刻が保持される・未提出で消え・再提出で新しい時刻 ----
  const aoba = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業");
  await page.click(`[data-ky-id="${aoba.id}"][data-ky-state="submitted"]`); await page.waitForTimeout(400);
  const at1 = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業").at;
  await page.reload(); await page.waitForTimeout(400); await openDay(ids.s1, D1);
  rs = await rows();
  const at1b = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業").at;
  check("6 提出済みにすると時刻が記録され、再読み込みしても同じ状態・同じ時刻", !!at1 && at1 === at1b && rs.find((r) => r.n === "アオバ塗装工業").state === "submitted" && rs.find((r) => r.n === "アオバ塗装工業").time !== "—", `${at1} / ${at1b}`);
  await page.click(`[data-ky-id="${aoba.id}"][data-ky-state="not_submitted"]`); await page.waitForTimeout(400);
  const cleared = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業");
  await page.waitForTimeout(50);
  await page.click(`[data-ky-id="${aoba.id}"][data-ky-state="submitted"]`); await page.waitForTimeout(400);
  const at2 = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業").at;
  check("6 未提出に戻すと提出時刻が消え、もう一度提出済みにすると新しい時刻を記録する", !cleared.submitted && cleared.at === null && !!at2 && at2 > at1, `${at1} → ${cleared.at} → ${at2}`);

  // ---- 10 日報の確認・署名・印刷と KY は連動しない（KY の操作で日報は変わらない） ----
  check("10 KY の提出状況を変えても日報は変わらない（1文字も）", (await reportJson(ids.r1)) === r1AfterAdd && r1Before !== r1AfterAdd);
  await page.evaluate(async (id) => {
    const { setReportConfirmed } = await import("/js/reports.js"); const { saveSignature } = await import("/js/signatures.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    await setReportConfirmed(id, true); await saveSignature({ reportId: id, companyId: "c", blob: png });
  }, ids.r1);
  await openDay(ids.s1, D1);
  rs = await rows();
  check("10 日報を確認済みにし職長サインを書いても、KY は未提出のまま（ウエノ建設・イズミ足場工業）", ["ウエノ建設", "イズミ足場工業"].every((n) => rs.find((r) => r.n === n)?.state === "not_submitted"), JSON.stringify(rs));

  // ---- 7 日報の編集・削除で提出記録が消えない ----
  await page.evaluate(async (id) => { const { updateReport } = await import("/js/reports.js"); const { dbGet } = await import("/js/db.js"); const r = await dbGet("reports", id); await updateReport(id, { companies: r.companies.filter((c) => c.companyName !== "アオバ塗装工業") }); }, ids.r1);
  await openDay(ids.s1, D1);
  rs = await rows();
  const aobaAfterEdit = active(await kyOf(ids.s1, D1)).find((r) => r.n === "アオバ塗装工業");
  check("7 日報からアオバ塗装工業を外しても、KY の提出済み・提出時刻は残る（「この日の日報に無い業者」の印）", aobaAfterEdit?.submitted && aobaAfterEdit.at === at2 && rs.find((r) => r.n === "アオバ塗装工業")?.noReport === true, JSON.stringify(aobaAfterEdit));
  await page.evaluate(async (id) => (await import("/js/reports.js")).deleteReportWithAttachments(id), ids.r1);
  await openDay(ids.s1, D1);
  const afterDelete = active(await kyOf(ids.s1, D1));
  check("7 日報を削除しても、その日の KY の記録（提出状況・提出時刻）は残る", afterDelete.map((r) => r.n).sort().join() === ["アオバ塗装工業", "イズミ足場工業", "ウエノ建設"].sort().join() && afterDelete.find((r) => r.n === "アオバ塗装工業").at === at2, JSON.stringify(afterDelete));

  // ---- 8 表記が違えば別の業者（前後の空白だけ同じにする） ----
  await openDay(ids.s1, D3);
  const d3 = active(await kyOf(ids.s1, D3)).map((r) => r.n);
  check("8 業者名の表記が違えば別の業者（アオバ塗装工業／アオバ塗装／ｱｵﾊﾞ塗装工業は3件。末尾の空白だけ違う名前は同じ業者）", [...d3].sort().join() === ["アオバ塗装工業", "アオバ塗装", "ｱｵﾊﾞ塗装工業"].sort().join(), d3.join());

  // ---- 9 現場・日付ごとに別の記録 ----
  await openDay(ids.s2, D1);
  const s2d1 = active(await kyOf(ids.s2, D1));
  const s1d3aoba = active(await kyOf(ids.s1, D3)).find((r) => r.n === "アオバ塗装工業");
  check("9 別の現場の同じ日付・同じ業者名は別の記録（現場2のアオバ塗装工業は未提出）、同じ現場の別の日（10/3）も未提出", s2d1.length === 1 && s2d1[0].n === "アオバ塗装工業" && !s2d1[0].submitted && !s2d1[0].at && s1d3aoba && !s1d3aoba.submitted && !(await kyOf(ids.s2, D3)).length, JSON.stringify({ s2d1, s1d3aoba }));

  // ---- 保存に失敗したら成功したように見せない ----
  await openDay(ids.s2, D1);
  const failRec = s2d1[0];
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; window.__restorePut = () => { IDBObjectStore.prototype.put = put; }; IDBObjectStore.prototype.put = function (...a) { if (this.name === "kySubmissions") throw new DOMException("試験のための失敗", "QuotaExceededError"); return put.apply(this, a); }; });
  await page.click(`[data-ky-id="${failRec.id}"][data-ky-state="submitted"]`); await page.waitForTimeout(500);
  const msg = await page.evaluate(() => document.getElementById("message")?.textContent || document.body.innerText.slice(0, 0));
  rs = await rows();
  await page.evaluate(async (id) => { const { dbGet } = await import("/js/db.js"); const { updateReport } = await import("/js/reports.js"); const r = await dbGet("reports", id); await updateReport(id, { companies: [...r.companies, { companyId: "q", companyName: "オリーブ警備", occupation: "警備", plannedWorkerCount: "1", actualWorkerCount: "1" }] }); }, ids.r4);
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, D1); await page.waitForTimeout(700);
  const syncErr = await page.$eval("#siteDashboard", (el) => el.querySelector(".dash-ky-sync-error")?.textContent || "");
  const stored = active(await kyOf(ids.s2, D1));
  await page.evaluate(() => window.__restorePut());
  check("保存に失敗したら: 提出済みにできず（表は未提出のまま・保存も未提出）、日報の業者からの自動の作成の失敗は画面に出る", rs.find((r) => r.n === "アオバ塗装工業").state === "not_submitted" && !stored.find((r) => r.n === "アオバ塗装工業").submitted && syncErr.includes("保存に失敗") && !stored.some((r) => r.n === "オリーブ警備"), JSON.stringify({ msg, syncErr, stored }));
  await page.$eval("#siteDashboard .dash-date-input", (el, d) => { el.value = d; el.dispatchEvent(new Event("change", { bubbles: true })); }, D1); await page.waitForTimeout(700);
  check("保存できるようになれば、次に開いたときに日報の業者（オリーブ警備）が入る", active(await kyOf(ids.s2, D1)).some((r) => r.n === "オリーブ警備"));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
