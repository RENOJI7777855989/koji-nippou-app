/* ==========================================================
   進捗率のスライダー（iPadで指で操作する。0〜100%・1%刻み）
   保存する値は従来どおり数値の入力欄（input type=number）にあり、スライダーはその入力欄を
   書き換えるだけ（保存・確認の処理は入力欄を読む）。入力欄が空なら「未入力」と大きく表示し、
   スライダーは薄く表示する（未入力を0%として扱わない。スライダーを動かすか±1・数字を入れたときだけ入る）。
   ========================================================== */

/**
 * @param {HTMLInputElement} input 進捗率の入力欄（空欄＝未入力）
 * @returns {{sync: () => void}} 入力欄の値をプログラムで変えたあとに呼ぶ
 */
export function attachProgressSlider(input) {
  if (!input || input._progressSlider) return input?._progressSlider;
  const box = document.createElement("div");
  box.className = "progress-slider";
  box.innerHTML = `
    <div class="progress-slider-value" aria-live="polite"></div>
    <div class="progress-slider-row">
      <button type="button" class="secondary-btn progress-step" data-step="-1" aria-label="1%減らす">−1</button>
      <input type="range" class="progress-range" min="0" max="100" step="1" aria-label="進捗率（スライダー）">
      <button type="button" class="secondary-btn progress-step" data-step="1" aria-label="1%増やす">＋1</button>
    </div>
    <button type="button" class="link-btn progress-clear">未入力に戻す</button>`;
  input.insertAdjacentElement("afterend", box);
  const range = box.querySelector(".progress-range");
  const valueEl = box.querySelector(".progress-slider-value");
  const clearBtn = box.querySelector(".progress-clear");

  const current = () => {
    const raw = input.value.trim();
    if (raw === "" || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 0 && n <= 100 ? n : null;
  };
  const sync = () => {
    const v = current();
    const unset = input.value.trim() === "";
    box.classList.toggle("is-unset", unset);
    valueEl.textContent = unset ? "未入力" : v == null ? "—" : `${v}%`;
    if (v != null) range.value = String(v);
    else if (unset) range.value = "0";
    clearBtn.hidden = unset;
    const disabled = input.disabled;
    range.disabled = disabled;
    box.querySelectorAll("button").forEach((b) => (b.disabled = disabled));
  };
  const setValue = (v) => {
    input.value = String(Math.max(0, Math.min(100, Math.round(v))));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    sync();
  };
  range.addEventListener("input", () => setValue(Number(range.value)));
  box.addEventListener("click", (e) => {
    const step = e.target.closest(".progress-step");
    if (step) {
      const v = current();
      // 未入力のときに±1を押した場合は、その値（0%または1%）から始める（未入力を勝手に0%にはしない＝押したときだけ入る）
      setValue((v ?? 0) + (v == null ? Math.max(0, Number(step.dataset.step)) : Number(step.dataset.step)));
      return;
    }
    if (e.target.closest(".progress-clear")) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      sync();
    }
  });
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  const api = { sync };
  input._progressSlider = api;
  sync();
  return api;
}
