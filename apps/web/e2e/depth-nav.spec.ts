// 조망 ① → 선택 ② → 작업 ③: one continuum. ③ entry = Enter while the stage is
// open, and the stage button — one path (a canvas double-click frames the view).
// ③ has NO context strip (design review ②): the work content fills the
// screen; Esc is the only way back, ③ → ② (selection intact) → ①.
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, fixture: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: fixture } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

/** Mirror buttons are visually hidden under the canvas; click them directly. */
async function clickNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).dispatchEvent('click');
}

/** Where the canvas draws a node right now (dev debug hook), in client coordinates. */
async function drawnCenter(page: Page, id: string) {
  return page.evaluate((nodeId) => {
    const dbg = (window as unknown as {
      __gunnflowDebug: { nodeRect: (id: string) => { x: number; y: number; w: number; h: number } | undefined; camera: () => { x: number; y: number; zoom: number } };
    }).__gunnflowDebug;
    const r = dbg.nodeRect(nodeId);
    if (!r) return null;
    const cam = dbg.camera();
    const host = document.querySelector('[data-testid="canvas-host"] canvas')!.getBoundingClientRect();
    return {
      x: host.left + host.width / 2 + (r.x + r.w / 2 - cam.x) * cam.zoom,
      y: host.top + host.height / 2 + (r.y + r.h / 2 - cam.y) * cam.zoom,
    };
  }, id);
}

test('click → ② → Enter → ③ fills the screen (no strip) → Esc → ② → other node → Enter → its ③ → Esc → ② → Esc → ①', async ({ page }) => {
  await open(page, 'normal');
  // COLD click: no pre-selection, no settle wait — the stage is an overlay (the canvas never reflows).
  const pt = await drawnCenter(page, 't-research');
  expect(pt).not.toBeNull();
  await page.mouse.click(pt!.x, pt!.y);
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-research');
  await page.keyboard.press('Enter');

  // ③: the work content owns the screen — no strip, no ◀조망, no chips.
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Research');
  await expect(page.getByTestId('work-strip')).toHaveCount(0);
  await expect(page.getByTestId('work-back')).toHaveCount(0);
  await expect(page.locator('[data-testid^="work-neighbor-"]')).toHaveCount(0);
  // No carried queue → no floating queue chip either.
  await expect(page.getByTestId('work-queue')).toHaveCount(0);

  // Esc: the ONLY way back — ③ → ② with the selection intact; canvas and stage return.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-inspector')).toBeHidden();
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-research');

  // The grammar still moves sideways through ②: select another node, Enter → ITS ③.
  await clickNode(page, 't-build');
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-build');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Web Build');

  // Esc: ③ → ② (selection kept), Esc: ② → ① (selection cleared, stage leaves).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-build');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('node-stage')).toBeHidden();
});

test('right-edge node: a cold click lands on IT (Enter → its ③); a plain selection pans it clear of the stage', async ({ page }) => {
  await open(page, 'normal');
  // t-test sits in the last layer — under the stage region at ①-fit zoom.
  const pt = await drawnCenter(page, 't-test');
  expect(pt).not.toBeNull();
  await page.mouse.click(pt!.x, pt!.y);
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-test');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Test');

  // Back at ② the selected node must end up visible BESIDE the stage: the
  // camera pans it clear (overlap + margin), node geometry untouched.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-test');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dbg = (window as unknown as {
            __gunnflowDebug: { nodeRect: (id: string) => { x: number; w: number } | undefined; camera: () => { x: number; zoom: number } };
          }).__gunnflowDebug;
          const r = dbg.nodeRect('t-test');
          if (!r) return Number.POSITIVE_INFINITY;
          const cam = dbg.camera();
          const c = document.querySelector('[data-testid="canvas-host"] canvas')!.getBoundingClientRect();
          const stageW = Math.min(620, Math.max(360, c.width * 0.4));
          const nodeRight = c.width / 2 + (r.x + r.w - cam.x) * cam.zoom;
          return nodeRight - (c.width - stageW); // ≤ 0 = clear of the stage region
        }),
      { timeout: 3000 },
    )
    .toBeLessThanOrEqual(0);
});

test('② stage: Enter and the 들어가기 button are the same ③ entry', async ({ page }) => {
  await open(page, 'normal');
  await clickNode(page, 't-build');
  const stage = page.getByTestId('node-stage');
  await expect(stage).toBeVisible();
  await expect(stage.getByTestId('node-stage-title')).toHaveText('Web Build');
  await expect(stage.getByTestId('node-stage-state')).toContainText('task · running');

  // Enter while the stage is open.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('work-surface')).toBeVisible();
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('canvas-host')).toBeVisible();

  // The prominent stage button.
  await page.getByTestId('stage-enter').click();
  await expect(page.getByTestId('work-surface')).toBeVisible();
  await expect(page.getByTestId('task-inspector')).toBeVisible();
});
