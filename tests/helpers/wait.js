// Playwrightの page.waitForFunction は、判定関数が async（Promiseを返す）だと結果を待たずに
// 「成立」とみなしてしまう（Promiseが真と判定されるため）。IndexedDB等の非同期の状態を待つときはこちらを使う。
async function waitForAsync(page, fn, arg, { timeout = 15000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > end) throw new Error(`待ち時間切れ（${timeout}ms）: ${fn.toString().slice(0, 100)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
module.exports = { waitForAsync };
