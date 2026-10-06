// 「📋 前の日報から作成」（新規の日報だけ）を確かめる（架空データ・Chromium）。
//   ・この日付より前で一番新しい日報の継続情報（業者・工種・作業内容・安全注意事項・使用機械・連絡事項・流れ）だけを入れる
//   ・その日の実績（人数・作業時間・請求人工・職長名・署名・写真・天気・気温・進捗率・巡回点検・搬入搬出・監督/職員・日の状態など）は入れない
//   ・コピー後に業者・作業内容・安全注意事項を追加・削除・編集できる。保存しても元の日報は1文字も変わらない
//   ・同じ日に日報が複数あれば、どれをコピーするか選ぶ（自動で選ばない）
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const BASE = "http://localhost:8934/index.html";
const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-prev-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE); await page.waitForSelector("#view-site-list:not([hidden])");

  const ids = await page.evaluate(async () => {
    const { createSite } = await import("/js/sites.js"); const { dbPut } = await import("/js/db.js"); const { stampNew } = await import("/js/utils.js");
    const { saveSignature } = await import("/js/signatures.js"); const { addPhoto } = await import("/js/photos.js");
    const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 20; c.height = 10; c.getContext("2d").fillRect(2, 2, 8, 4); c.toBlob(res, "image/png"); });
    const site = await createSite({ name: "前日コピーの確認現場", startDate: "2026-09-01", endDate: "2026-12-20" });
    const co = (id, name, trade, content, safety, machinery, n, billing) => ({ companyId: id, companyName: name, occupation: trade, workContent: content, safetyNotes: safety, machinery, plannedWorkerCount: n, actualWorkerCount: n, workHours: "08:00～17:00", billingManDays: billing, foremanName: "職長" + id });
    const src = stampNew({ siteId: site.id, date: "2026-09-05", dayStatus: "work", weather: "曇り", temperature: "22", progressPercent: 45, siteSupervisorNames: ["監督A"], staffCount: 2, staffWork: "書類",
      companies: [co("a", "○○建設", "内装", "天井下地施工", "脚立使用時の転倒防止", "高所作業車", "4", "4"), co("b", "△△設備", "設備", "配管施工", "上下作業の禁止", "", "2", ""), co("c", "□□電気", "電気", "ボード張り", "感電防止", "", "3", "3.5")],
      timeline: [{ id: "t1", time: "08:00", kind: "chorei", title: "朝礼", status: "done", note: "全員参加" }, { id: "t2", time: "09:30", kind: "uchiawase", title: "設備打合せ", status: "done", note: "メモ" }, { id: "t3", time: "17:00", kind: "workend", title: "作業終了", status: "plan", note: "" }],
      deliveries: [{ id: "d1", direction: "in", time: "10:00", item: "石膏ボード", vendor: "○○運送", status: "done" }],
      patrolChecklist: { morningMeeting: "good", scaffoldBridge: "bad" }, patrolComment: "手すり補修", remarks: "第三者災害に注意", tomorrowPlan: "天井ボード", focusInstructions: "重点", workCoordination: "調整" });
    await dbPut("reports", src);
    for (const cid of ["a", "b", "c"]) await saveSignature({ reportId: src.id, companyId: cid, blob: png });
    await addPhoto(src.id, site.id, new File([png], "p.png", { type: "image/png" }));
    // 同じ日（9/2）に日報が2件
    const dupA = stampNew({ siteId: site.id, date: "2026-09-02", dayStatus: "work", companies: [co("x", "甲工業", "塗装", "下塗り", "", "", "2", "")], remarks: "甲の連絡" });
    await new Promise((r) => setTimeout(r, 20));
    const dupB = stampNew({ siteId: site.id, date: "2026-09-02", dayStatus: "work", companies: [co("y", "乙工業", "防水", "防水下地", "", "", "1", "")], remarks: "乙の連絡" });
    await dbPut("reports", dupA); await dbPut("reports", dupB);
    return { siteId: site.id, src: src.id, dupA: dupA.id, dupB: dupB.id };
  });
  const snap = (id) => page.evaluate(async (x) => { const { dbGet } = await import("/js/db.js"); const { listSignaturesByReport } = await import("/js/signatures.js"); const { listPhotosByReport } = await import("/js/photos.js"); return JSON.stringify([await dbGet("reports", x), (await listSignaturesByReport(x)).map((s) => [s.id, s.updatedAt]), (await listPhotosByReport(x)).map((p) => [p.id, p.updatedAt])]); }, id);
  const srcBefore = await snap(ids.src);
  const newForm = async (date) => { await page.goto(`${BASE}#/sites`); await page.waitForSelector("#view-site-list:not([hidden])"); await page.goto(`${BASE}#/sites/${ids.siteId}/report/new?date=${date}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(500); };
  const rows = () => page.$$eval(".company-row", (rs) => rs.map((r) => ({ name: r.querySelector(".companyName").value, trade: r.querySelector(".occupation").value, content: r.querySelector(".workContent").value, safety: r.querySelector(".safetyNotes").value, machinery: r.querySelector(".machinery").value, planned: r.querySelector(".plannedWorkerCount").value, actual: r.querySelector(".actualWorkerCount").value, hours: r.querySelector(".workHours").value, billing: r.querySelector(".billingManDays").value, foreman: r.querySelector(".foremanName").value, copied: r.classList.contains("is-copied") })));

  // ===== 1・2 ボタン =====
  await newForm("2026-09-06");
  const info = await page.textContent("#copyPrevInfo");
  check("1・2 新規の日報に「📋 前の日報から作成」が出て、前の日報の日付（2026/09/05）を表示", await page.isVisible("#copyPrevBtn") && !(await page.isDisabled("#copyPrevBtn")) && info.includes("2026/09/05"), info);

  // ===== 3・4・5 コピー =====
  await page.click("#copyPrevBtn"); await page.waitForTimeout(300);
  let r = await rows();
  check("4 業者・工種・作業内容・安全注意事項・使用機械がコピーされる（3行）", r.map((x) => `${x.name}/${x.trade}/${x.content}/${x.safety}/${x.machinery}`).join(" | ") === "○○建設/内装/天井下地施工/脚立使用時の転倒防止/高所作業車 | △△設備/設備/配管施工/上下作業の禁止/ | □□電気/電気/ボード張り/感電防止/" && r.every((x) => x.copied), JSON.stringify(r.map((x) => x.name)));
  check("5 その日の実績はコピーしない（予定・実績人数・作業時間・請求人工・職長名は空）", r.every((x) => x.planned === "" && x.actual === "" && x.hours === "" && x.billing === "" && x.foreman === ""), JSON.stringify(r.map((x) => [x.planned, x.actual, x.hours, x.billing, x.foreman])));
  const form = await page.evaluate(() => ({
    remarks: document.getElementById("remarks").value, tomorrow: document.getElementById("tomorrowPlan").value, focus: document.getElementById("focusInstructions").value, coord: document.getElementById("workCoordination").value,
    weather: document.getElementById("weather").value, temp: document.getElementById("temperature").value, progress: document.getElementById("progressPercent").value, day: document.getElementById("dayStatus").value,
    staff: document.getElementById("staffCount").value, staffWork: document.getElementById("staffWork").value, sup: document.querySelectorAll(".siteSupervisorNameInput").length, patrolComment: document.getElementById("patrolComment").value,
    patrol: [...document.querySelectorAll("#patrolChecklistContainer select")].map((s) => s.value), deliveries: document.querySelectorAll(".delivery-row").length,
    flows: [...document.querySelectorAll("#timelineContainer .timeline-row")].map((x) => `${x.querySelector(".flowTime").value}|${x.querySelector(".flowKind").value}|${x.querySelector(".flowTitle").value}|${x.querySelector(".flowStatus").value}|${x.querySelector(".flowNote").value}`),
    sigs: [...document.querySelectorAll(".signatureSignedAt")].map((x) => x.textContent).join(""), photos: document.querySelectorAll("#photoGrid .photo-tile").length, notice: document.getElementById("copyPrevNotice").textContent
  }));
  check("4 連絡事項はコピーする", form.remarks === "第三者災害に注意");
  check("5 天気・気温・進捗率・日の状態・監督/職員・巡回点検・是正指示・搬入搬出・署名・写真・明日の予定・重点指示・連絡調整はコピーしない（新規の初期値のまま）", form.weather === "晴れ" && form.temp === "" && form.progress === "" && form.day === "work" && form.staff === "" && form.staffWork === "" && form.sup === 0 && form.patrolComment === "" && form.patrol.every((v) => v === "good") && form.deliveries === 0 && form.sigs === "" && form.photos === 0 && form.tomorrow === "" && form.focus === "" && form.coord === "", JSON.stringify({ ...form, patrol: undefined, flows: undefined }));
  check("4・5 流れは前の日報の時刻・種別・内容だけ（状態は「予定」に戻し、メモは入れない）", form.flows.join(",") === "08:00|chorei|朝礼|plan|,09:30|uchiawase|設備打合せ|plan|,17:00|workend|作業終了|plan|", form.flows.join(","));
  check("「前の日報からコピーしました」と、入れなかった項目を表示", form.notice.includes("2026/09/05 の日報からコピーしました") && form.notice.includes("人数・作業時間"), form.notice);

  // ===== 6〜11 編集・追加・削除 =====
  await page.locator(".company-row").nth(1).locator(".removeCompanyBtn").click(); // △△設備（配管施工・完了）を削除
  await page.click("#addCompanyBtn");
  const nr = page.locator(".company-row").last();
  await nr.locator(".companyName").fill("××工業"); await nr.locator(".occupation").fill("床"); await nr.locator(".workContent").fill("床仕上げ"); await nr.locator(".safetyNotes").fill("搬入時の第三者災害防止");
  await page.locator(".company-row").nth(0).locator(".safetyNotes").fill("脚立使用時の転倒防止\n上下作業の禁止"); // 安全注意事項を追加
  await page.locator(".company-row").nth(1).locator(".safetyNotes").fill(""); // □□電気の安全注意事項を削除
  for (const [i, n] of [[0, "5"], [1, "2"], [2, "1"]]) { const rr = page.locator(".company-row").nth(i); await rr.locator(".actualWorkerCount").fill(n); await rr.locator(".workStart").selectOption("08:00"); }
  await page.selectOption("#weather", "晴れ"); await page.fill("#progressPercent", "48"); await page.locator("#progressPercent").dispatchEvent("input");
  await page.click("#reportSaveBtn"); await page.waitForSelector("#view-site-detail:not([hidden])"); await page.waitForTimeout(400);
  const msg = await page.textContent("#message");
  const saved = await page.evaluate(async (sid) => (await (await import("/js/reports.js")).listReportsBySite(sid)).find((x) => x.date === "2026-09-06"), ids.siteId);
  check("3・6 翌日（9/6）の日報として保存できる（日付・別の日報）", saved && saved.id !== ids.src && saved.date === "2026-09-06");
  check("7・8 業者の削除（△△設備）・追加（××工業／床）ができる", saved.companies.map((c) => `${c.companyName}/${c.occupation}`).join(",") === "○○建設/内装,□□電気/電気,××工業/床", saved.companies.map((c) => c.companyName).join(","));
  check("9・10 作業内容の削除（配管施工）・追加（床仕上げ）・継続（天井下地施工・ボード張り）", saved.companies.map((c) => c.workContent).join(",") === "天井下地施工,ボード張り,床仕上げ");
  check("11 安全注意事項の追加（上下作業の禁止）・削除（□□電気）・追加（××工業）", saved.companies[0].safetyNotes === "脚立使用時の転倒防止\n上下作業の禁止" && saved.companies[1].safetyNotes === "" && saved.companies[2].safetyNotes === "搬入時の第三者災害防止");
  check("当日の値（実績人数・作業時間・進捗率）は今日入力したもの。請求人工は空のまま（前の日報から写さない・人数から作らない）", saved.companies.map((c) => `${c.actualWorkerCount}/${c.workHours}/${c.billingManDays}`).join(",") === "5/08:00～17:00/,2/08:00～17:00/,1/08:00～17:00/" && saved.progressPercent === 48 && saved.weather === "晴れ" && !saved.deliveries.length);
  check("業者の行は新しいid（前の日報の署名と結び付かない）・署名と写真は0件", saved.companies.every((c) => !["a", "b", "c"].includes(c.companyId)) && (await page.evaluate(async (id) => (await (await import("/js/signatures.js")).listSignaturesByReport(id)).length + (await (await import("/js/photos.js")).listPhotosByReport(id)).length, saved.id)) === 0);
  check("保存のメッセージに前の日報との違い（業者の行 継続2・追加1・削除1）", msg.includes("前の日報（2026/09/05）から: 業者の行 継続2・追加1・削除1"), msg);

  // ===== 12 元の日報は変わらない =====
  check("12 元の日報（9/5）は1文字も変わらない（業者・流れ・人数・請求人工・署名・写真も）", (await snap(ids.src)) === srcBefore);

  // ===== 同じ日に複数の日報 → 選ぶ =====
  await newForm("2026-09-03");
  const info2 = await page.textContent("#copyPrevInfo");
  await page.click("#copyPrevBtn"); await page.waitForTimeout(300);
  const choices = await page.$$eval("#copyPrevChoices [data-copy-from]", (bs) => bs.map((b) => b.textContent));
  const before3 = await rows();
  check("同じ日（9/2）に日報が2件 → 自動で選ばず、2件を並べて選ばせる（押す前は何も入らない）", info2.includes("2件") && choices.length === 2 && choices[0].includes("甲工業") && choices[1].includes("乙工業") && before3.length === 1 && before3[0].name === "", choices.join(" / "));
  await page.click(`#copyPrevChoices [data-copy-from="${ids.dupB}"]`); await page.waitForTimeout(300);
  const r3 = await rows();
  check("選んだ日報（乙工業）だけをコピーする（まとめない）", r3.length === 1 && r3[0].name === "乙工業" && (await page.inputValue("#remarks")) === "乙の連絡");
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");

  // ===== 前の日報が無い日・編集画面 =====
  await newForm("2026-09-01");
  check("前の日報が無い日はボタンを押せず、その旨を表示", (await page.isDisabled("#copyPrevBtn")) && (await page.textContent("#copyPrevInfo")).includes("前の日報がありません"));
  await page.click("#reportCancelBtn"); await page.waitForSelector("#view-site-detail:not([hidden])");
  await page.goto(`${BASE}#/sites/${ids.siteId}/report/${ids.src}`); await page.waitForSelector("#view-report-form:not([hidden])"); await page.waitForTimeout(400);
  check("既存の日報の編集画面には「前の日報から作成」を出さない", !(await page.isVisible("#copyPrevBtn")));
  // 前の日報からコピーせずに作る通常の新規日報は従来どおり（流れの初期値8件・巡回点検は良）
  await newForm("2026-09-10");
  const plain = await page.evaluate(() => ({ flows: document.querySelectorAll("#timelineContainer .timeline-row").length, patrol: [...document.querySelectorAll("#patrolChecklistContainer select")].every((s) => s.value === "good"), rows: document.querySelectorAll(".company-row").length }));
  check("13 コピーしない通常の新規日報は従来どおり（流れの初期値8件・巡回点検「良」・業者1行）", plain.flows === 8 && plain.patrol && plain.rows === 1, JSON.stringify(plain));

  check("ページエラーが無い", errors.length === 0, errors.slice(0, 2).join(" / "));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
