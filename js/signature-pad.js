/* ==========================================================
   手書き署名キャプチャ（外部ライブラリ不使用）
   Pointer Events APIでマウス（Windows）・指/Apple Pencil
   （iPad・iPhone）を分岐なしに統一的に扱う
   ========================================================== */

export function createSignaturePad(canvas) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let hasStroke = false;
  let lastX = 0;
  let lastY = 0;

  function setupCanvasResolution() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#222";
  }
  setupCanvasResolution();

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pointerDown(e) {
    drawing = true;
    hasStroke = true;
    canvas.setPointerCapture(e.pointerId);
    const pos = getPos(e);
    lastX = pos.x;
    lastY = pos.y;
  }

  function pointerMove(e) {
    if (!drawing) return;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x;
    lastY = pos.y;
  }

  function pointerUp(e) {
    drawing = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      // すでに解放済みの場合は無視
    }
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasStroke = false;
    },
    isEmpty() {
      return !hasStroke;
    },
    /**
     * 保存済みの署名の画像を、欄の内部の画素（canvas.width × canvas.height）いっぱいに描く。
     * 欄は手書きのために座標を画面の倍率（devicePixelRatio）で拡大しているので、その拡大を一時的に外して描く
     * （外さないと倍率が二重にかかり、iPad（倍率2）では署名が2倍に拡大されて左上の一部しか見えず、
     *   その上に書き足して保存すると元の署名の一部が失われていた。2026-10-18 修正）。
     * 描いただけでは「書いた」扱いにしない（isEmpty のまま。書き足したときだけ保存される）
     */
    showImage(image) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
    toBlob() {
      // 描画直後にtoBlob()を呼ぶと、環境によっては描画がまだ
      // コンポジット（画面反映）される前でコールバックが来ないことが
      // あるため、1フレーム待ってから呼び出す
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          canvas.toBlob(resolve, "image/png");
        });
      });
    },
    destroy() {
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
    }
  };
}
