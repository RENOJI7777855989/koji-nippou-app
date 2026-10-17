// 全テストを順に実行し、成功数／総数を正確に集計する（2026-10-17。node tests/run-all.js）。
//   ・各テストの最後の集計行（「n/m passed」「合計 m件中 失敗 f件」「合計 m 件 / 成功 n 件 / 失敗 f 件」）から成功数と総数を読む
//   ・成功数と総数が一致しない・失敗が1件でもある・集計行が読めない・終了コードが0でない、のどれかなら、そのファイルは失敗
//   ・「passed」という文字の有無では判定しない（「21/22 passed」も失敗）
//   ・失敗したファイルは [FAIL] の行をそのまま表示する。全部成功したときだけ「全テスト合格」と出し、終了コード0で終わる
//   ・使い方: node tests/run-all.js [ファイル名の一部 ...]（指定したテストだけ実行）。環境変数はそのまま各テストへ渡す
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const filters = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "run-all.js").filter((f) => !filters.length || filters.some((x) => f.includes(x))).sort();

/** テストの出力から成功数・総数・失敗数を読む（最後に出てきた集計行を使う。読めなければ null） */
function parseSummary(out) {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    let m = l.match(/(\d+)\/(\d+) passed/);
    if (m) return { passed: Number(m[1]), total: Number(m[2]), failed: Number(m[2]) - Number(m[1]), note: l.includes("未確認") ? l.slice(l.indexOf("passed") + 6).trim() : "" };
    m = l.match(/合計 (\d+) 件 \/ 成功 (\d+) 件 \/ 失敗 (\d+) 件/);
    if (m) return { passed: Number(m[2]), total: Number(m[1]), failed: Number(m[3]), note: "" };
    m = l.match(/合計 (\d+)件中 失敗 (\d+)件/);
    if (m) return { passed: Number(m[1]) - Number(m[2]), total: Number(m[1]), failed: Number(m[2]), note: "" };
  }
  return null;
}

const results = [];
for (const f of files) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", env: process.env, timeout: 15 * 60 * 1000, maxBuffer: 1 << 28 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const sum = parseSummary(out);
  const ok = !!sum && r.status === 0 && sum.failed === 0 && sum.passed === sum.total && sum.total > 0;
  const fails = out.split("\n").filter((l) => /^\[(FAIL|失敗)\]/.test(l.trim()));
  const errLine = !sum ? (out.split("\n").filter((l) => /Error|error/.test(l)).slice(0, 2).join(" / ") || "集計行が読めません") : "";
  results.push({ file: f, ok, passed: sum?.passed ?? null, total: sum?.total ?? null, exit: r.status, seconds: Math.round((Date.now() - start) / 1000), note: sum?.note || "", fails, errLine });
  const shown = sum ? `${sum.passed}/${sum.total}` : "集計なし";
  console.log(`${ok ? "合格" : "失敗"}  ${f}: ${shown}（終了コード ${r.status}・${Math.round((Date.now() - start) / 1000)}秒）${sum?.note ? ` ${sum.note}` : ""}`);
  if (!ok) { for (const l of fails) console.log(`      ${l.trim().slice(0, 300)}`); if (errLine) console.log(`      ${errLine.slice(0, 300)}`); }
}

const bad = results.filter((r) => !r.ok);
const checks = results.reduce((s, r) => s + (r.total || 0), 0);
const passedChecks = results.reduce((s, r) => s + (r.passed || 0), 0);
console.log(`\nファイル: 合格 ${results.length - bad.length}／${results.length}　確認項目: 成功 ${passedChecks}／${checks}`);
console.log(bad.length ? `失敗したファイル: ${bad.map((r) => r.file).join(", ")}（全テスト合格ではありません）` : "全テスト合格（すべてのファイルで成功数＝総数・失敗0・終了コード0）");
if (process.env.TEST_OUT_DIR) { try { fs.mkdirSync(process.env.TEST_OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.TEST_OUT_DIR, "run-all.json"), JSON.stringify(results, null, 1)); } catch { /* 記録できなくても結果は上に出ている */ } }
process.exit(bad.length ? 1 : 0);
