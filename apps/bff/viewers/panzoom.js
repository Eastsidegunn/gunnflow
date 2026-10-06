// Read-only pan (drag) and zoom (wheel) over one element. Nothing else.
export function panZoom(stage, content) {
  let x = 0;
  let y = 0;
  let k = 1;
  const apply = () => {
    content.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  };
  const fit = () => {
    const box = content.getBoundingClientRect();
    const view = stage.getBoundingClientRect();
    const w = box.width / k;
    const h = box.height / k;
    k = Math.min(1.5, Math.max(0.1, Math.min((view.width - 32) / w, (view.height - 32) / h)));
    x = (view.width - w * k) / 2;
    y = (view.height - h * k) / 2;
    apply();
  };
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nk = Math.min(8, Math.max(0.05, k * f));
      x = px - ((px - x) * nk) / k;
      y = py - ((py - y) * nk) / k;
      k = nk;
      apply();
    },
    { passive: false },
  );
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, x, y };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    x = drag.x + e.clientX - drag.sx;
    y = drag.y + e.clientY - drag.sy;
    apply();
  });
  stage.addEventListener('pointerup', () => (drag = null));
  stage.addEventListener('dblclick', fit);
  content.style.transformOrigin = '0 0';
  fit();
}

/** The diagram source the isolated origin embedded after verifying its digest. */
export function embeddedSource() {
  return JSON.parse(document.getElementById('gunnflow-source').textContent);
}

export function showError(message) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.dataset.state = 'error';
  document.body.dataset.rendered = 'error';
}
