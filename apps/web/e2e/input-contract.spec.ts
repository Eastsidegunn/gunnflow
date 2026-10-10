// Input contract (docs/ui-requirements §5.6): each pointer button has one job on
// the canvas, whatever lies under it. Left = the element, middle drag = the view,
// wheel = zoom, right = the menu. Moving the view sends nothing over the network.
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
  await still(page, ['t-build', 'm1']);
}

/** Records every request the page makes from now on. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => seen.push(`${r.method()} ${r.url()}`));
  return seen;
}

/** A middle-button drag from `from` by (dx, dy) client pixels. */
async function middleDrag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
}

test('middle drag on a node moves the view only: the node stays put, nothing is selected, no request', async ({ page }) => {
  await open(page);
  const r = (await rectOf(page, 't-build'))!;
  const at = await toClient(page, r.x + r.w / 2, r.y + r.h / 2);
  const cam0 = await camera(page);
  const requests = recordRequests(page);
  await middleDrag(page, at, 120, 60);
  const cam1 = await camera(page);
  expect(cam1.zoom).toBe(cam0.zoom);
  // Panning by (dx, dy) screen pixels moves the camera by (-dx, -dy) / zoom in world units.
  expect(cam1.x).toBeCloseTo(cam0.x - 120 / cam0.zoom, 1);
  expect(cam1.y).toBeCloseTo(cam0.y - 60 / cam0.zoom, 1);
  expect(await rectOf(page, 't-build')).toEqual(r);
  expect(await selected(page)).toBeNull();
  expect(requests).toEqual([]);
});

test('middle drag inside a container pans (the container is not dragged); a middle click selects nothing', async ({ page }) => {
  await open(page);
  // A point inside the mission's container that no member node covers: just inside its top-left corner.
  const g = (await rectOf(page, 'm1'))!;
  expect(g, 'the container is drawn').not.toBeNull();
  const at = await toClient(page, g.x + 6, g.y + 6);
  const members = await Promise.all(['t-research', 't-draft', 't-build'].map((id) => rectOf(page, id)));
  const cam0 = await camera(page);
  await middleDrag(page, at, -80, 40);
  const cam1 = await camera(page);
  expect(cam1.x).toBeCloseTo(cam0.x + 80 / cam0.zoom, 1);
  expect(cam1.y).toBeCloseTo(cam0.y - 40 / cam0.zoom, 1);
  expect(await Promise.all(['t-research', 't-draft', 't-build'].map((id) => rectOf(page, id)))).toEqual(members);

  // A middle click (no movement) on a node neither selects it nor clears a selection.
  const b = (await rectOf(page, 't-build'))!;
  const nodeAt = await toClient(page, b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.click(nodeAt.x, nodeAt.y, { button: 'middle' });
  expect(await selected(page)).toBeNull();
  await page.mouse.click(nodeAt.x, nodeAt.y);
  expect(await selected(page)).toBe('t-build');
  const emptyAt = await toClient(page, g.x + 6, g.y + 6);
  await page.mouse.click(emptyAt.x, emptyAt.y, { button: 'middle' });
  expect(await selected(page)).toBe('t-build');
});

test('left drag on a node moves the node, not the view; the wheel zooms; neither sends a request', async ({ page }) => {
  await open(page);
  const r = (await rectOf(page, 't-build'))!;
  const at = await toClient(page, r.x + r.w / 2, r.y + r.h / 2);
  const cam0 = await camera(page);
  const requests = recordRequests(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 50, at.y + 30, { steps: 6 });
  await page.mouse.up();
  const moved = (await rectOf(page, 't-build'))!;
  expect(moved.x).toBeCloseTo(r.x + 50 / cam0.zoom, 0);
  expect(moved.y).toBeCloseTo(r.y + 30 / cam0.zoom, 0);
  expect(await camera(page)).toEqual(cam0);

  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(cam0.zoom);
  expect(requests).toEqual([]);
});
