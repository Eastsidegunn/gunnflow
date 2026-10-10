// Zoom ladder (GF-P1b C): the wheel moves the zoom in close geometric steps
// with "fits on screen" anchors, so the same notches back return the same
// view; the steps show as a tick scale; double-click on empty canvas goes one
// anchor out; Alt/pinch zoom freely. View state only — nothing is sent.
import { expect, test, type Page } from '@playwright/test';

type Rect = { x: number; y: number; w: number; h: number };
type Debug = {
  camera: () => { x: number; y: number; zoom: number };
  selectedId: () => string | null;
  nodeRect: (id: string) => Rect | undefined;
};
type W = { __gunnflowDebug: Debug };
const camera = (page: Page) => page.evaluate(() => (window as unknown as W).__gunnflowDebug.camera());
const selected = (page: Page) => page.evaluate(() => (window as unknown as W).__gunnflowDebug.selectedId());
const rectOf = (page: Page, id: string) =>
  page.evaluate((nodeId) => (window as unknown as W).__gunnflowDebug.nodeRect(nodeId) ?? null, id);

/** A world point → client coordinates, through the current camera. */
async function toClient(page: Page, wx: number, wy: number) {
  const cam = await camera(page);
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  return { x: host.x + host.width / 2 + (wx - cam.x) * cam.zoom, y: host.y + host.height / 2 + (wy - cam.y) * cam.zoom };
}

/** Polls until the camera and the given node rects stop changing (layout passes and fits have landed). */
async function still(page: Page, ids: string[]) {
  const read = async () => JSON.stringify([await camera(page), ...(await Promise.all(ids.map((id) => rectOf(page, id))))]);
  let last = await read();
  let same = 0;
  await expect
    .poll(
      async () => {
        const cur = await read();
        same = cur === last ? same + 1 : 0;
        last = cur;
        return same;
      },
      { intervals: [100], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(4);
}

/** No personal items: a leftover sticky or box from another scenario must not lie under the aimed points. */
const EMPTY_PERSONAL = { version: 2, notes: {}, stickies: [], boxes: [], links: [] };

async function open(page: Page) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  expect(res.ok()).toBeTruthy();
  expect((await page.request.put('http://127.0.0.1:8787/api/personal', { data: EMPTY_PERSONAL })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  // The layered pass replaces the first layout with an animated move: measure only after it has landed.
  await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
  await still(page, ['t-build', 'm1']);
}

/** Waits until a zoom move has landed (the camera stops changing). */
async function landed(page: Page) {
  await still(page, []);
  return camera(page);
}
const ticks = (page: Page) =>
  page.locator('[data-testid="zoom-ladder"] .zoom-tick').evaluateAll((els) =>
    els.map((e) => ({ zoom: Number((e as HTMLElement).dataset.zoom), anchor: e.classList.contains('anchor') })),
  );

/** One wheel notch (a line-mode-sized pixel delta) at the client point. */
async function notch(page: Page, at: { x: number; y: number }, dir: 1 | -1) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, dir > 0 ? -100 : 100);
  await page.waitForTimeout(60);
}

test('the same notches in and back out return exactly the same view; nothing is sent', async ({ page }) => {
  await open(page);
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  const at = { x: host.x + host.width * 0.4, y: host.y + host.height * 0.45 };
  const cam0 = await landed(page);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  for (let i = 0; i < 4; i++) await notch(page, at, 1);
  const zoomedIn = await landed(page);
  expect(zoomedIn.zoom).toBeGreaterThan(cam0.zoom);
  for (let i = 0; i < 4; i++) await notch(page, at, -1);
  const back = await landed(page);
  expect(back.zoom).toBeCloseTo(cam0.zoom, 9);
  expect(back.x).toBeCloseTo(cam0.x, 6);
  expect(back.y).toBeCloseTo(cam0.y, 6);
  expect(requests).toEqual([]);
});

test('every zoom the wheel lands on is a tick of the scale; the scale has 12–16 steps and marks anchors', async ({ page }) => {
  await open(page);
  const t = await ticks(page);
  expect(t.length).toBeGreaterThanOrEqual(12);
  expect(t.length).toBeLessThanOrEqual(16);
  expect(t.some((x) => x.anchor)).toBe(true);
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  const at = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  await notch(page, at, 1);
  await notch(page, at, 1);
  const z = (await landed(page)).zoom;
  expect((await ticks(page)).some((x) => Math.abs(x.zoom - z) < 1e-3)).toBe(true);
  await expect(page.getByTestId('zoom-current')).toHaveAttribute('data-zoom', z.toFixed(4));
});

test('double-click on empty canvas goes one anchor out; Alt+wheel zooms freely off the ladder', async ({ page }) => {
  await open(page);
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  const center = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  const cam0 = await landed(page);
  // An empty spot just outside the mission container's box (above its top-left corner); zooming at it keeps it on screen.
  const g = (await rectOf(page, 'm1'))!;
  const empty = await toClient(page, g.x + 4, g.y - 24);
  // Past the whole-graph anchor (its stickiness costs a notch) up to the top of the ladder.
  for (let i = 0; i < 12; i++) await notch(page, empty, 1);
  const inZoom = (await landed(page)).zoom;
  expect(inZoom).toBeGreaterThan(cam0.zoom);
  await page.mouse.dblclick(empty.x, empty.y);
  const out = (await landed(page)).zoom;
  expect(out).toBeLessThan(inZoom);
  const anchors = (await ticks(page)).filter((x) => x.anchor).map((x) => x.zoom);
  expect(anchors.some((a) => Math.abs(a - out) < 1e-3)).toBe(true);
  // Nothing was selected or opened by the double-click on empty canvas.
  expect(await selected(page)).toBeNull();

  // Alt+wheel: a free factor, not a ladder step.
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Alt');
  const free = (await landed(page)).zoom;
  expect(free).not.toBeCloseTo(out, 6);
  expect((await ticks(page)).some((x) => Math.abs(x.zoom - free) < 1e-4)).toBe(false);
});

/** The canvas area left of the stage (40 % clamped 360..620 px), in client coordinates. */
async function visibleLeft(page: Page) {
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  const stageW = Math.min(620, Math.max(360, host.width * 0.4));
  return { left: host.x, right: host.x + host.width - stageW, top: host.y, bottom: host.y + host.height };
}
async function clientRect(page: Page, id: string) {
  const r = (await rectOf(page, id))!;
  const a = await toClient(page, r.x, r.y);
  const b = await toClient(page, r.x + r.w, r.y + r.h);
  return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}

test('double-click on a container frames it beside the stage with a margin, on a ladder step; no work surface opens', async ({ page }) => {
  await open(page);
  const host = (await page.locator('[data-testid="canvas-host"] canvas').boundingBox())!;
  const center = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  for (let i = 0; i < 4; i++) await notch(page, center, -1);
  const out = (await landed(page)).zoom;
  const g = (await rectOf(page, 'm1'))!;
  const inGroup = await toClient(page, g.x + 6, g.y + 6);
  await page.mouse.dblclick(inGroup.x, inGroup.y);
  const fitted = await landed(page);
  expect(fitted.zoom).toBeGreaterThan(out);
  expect((await ticks(page)).some((x) => Math.abs(x.zoom - fitted.zoom) < 1e-3)).toBe(true);
  // The container sits wholly inside the area left of the stage.
  const area = await visibleLeft(page);
  const box = await clientRect(page, 'm1');
  expect(box.left).toBeGreaterThanOrEqual(area.left - 1);
  expect(box.right).toBeLessThanOrEqual(area.right + 1);
  expect(box.top).toBeGreaterThanOrEqual(area.top - 1);
  expect(box.bottom).toBeLessThanOrEqual(area.bottom + 1);
  await expect(page.getByTestId('task-inspector')).toHaveCount(0);
});

test('double-click on a leaf frames it with its one-hop neighbours, on a ladder step; Enter opens its work surface', async ({ page }) => {
  await open(page);
  // t-research links to t-draft, t-build and d-report (normal fixture).
  const r = (await rectOf(page, 't-research'))!;
  const at = await toClient(page, r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.dblclick(at.x, at.y);
  const cam = await landed(page);
  expect((await ticks(page)).some((x) => Math.abs(x.zoom - cam.zoom) < 1e-3)).toBe(true);
  const area = await visibleLeft(page);
  for (const id of ['t-research', 't-draft', 't-build', 'd-report']) {
    const b = await clientRect(page, id);
    expect(b.left, `${id} left`).toBeGreaterThanOrEqual(area.left - 1);
    expect(b.right, `${id} right`).toBeLessThanOrEqual(area.right + 1);
    expect(b.top, `${id} top`).toBeGreaterThanOrEqual(area.top - 1);
    expect(b.bottom, `${id} bottom`).toBeLessThanOrEqual(area.bottom + 1);
  }
  await expect(page.getByTestId('task-inspector')).toHaveCount(0);
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-research');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('task-inspector')).toBeVisible();
});

test('a cold double-click on a right-edge node (under where the stage appears) frames it; it never opens the work surface', async ({ page }) => {
  await open(page);
  // t-test sits in the last layer — under the stage region at the first fit.
  const r = (await rectOf(page, 't-test'))!;
  const at = await toClient(page, r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.dblclick(at.x, at.y);
  const cam = await landed(page);
  expect((await ticks(page)).some((x) => Math.abs(x.zoom - cam.zoom) < 1e-3)).toBe(true);
  await expect(page.getByTestId('task-inspector')).toHaveCount(0);
  const area = await visibleLeft(page);
  // t-test and its neighbour t-build are both left of the stage.
  for (const id of ['t-test', 't-build']) {
    const b = await clientRect(page, id);
    expect(b.left, `${id} left`).toBeGreaterThanOrEqual(area.left - 1);
    expect(b.right, `${id} right`).toBeLessThanOrEqual(area.right + 1);
  }
});

