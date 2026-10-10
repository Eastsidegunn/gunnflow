// Drag collision (GF-P1b B): a dropped node settles where it overlaps no other
// node (minimum gap) and no container it does not belong to; a drop in free
// space stays exactly where it was put. View state only — nothing is sent.
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

const LEAVES = ['t-research', 't-draft', 't-build', 't-test', 'd-report'];
const GAP = 16;
const near = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

async function leftDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

test('a node dropped onto another settles beside it: no two nodes overlap or crowd, no request', async ({ page }) => {
  await open(page);
  const a = (await rectOf(page, 't-build'))!;
  const b = (await rectOf(page, 't-draft'))!;
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  // Drop t-build squarely on top of t-draft (a little offset).
  await leftDrag(page, await toClient(page, a.x + a.w / 2, a.y + a.h / 2), await toClient(page, b.x + b.w / 2 + 20, b.y + b.h / 2 + 10));
  await still(page, LEAVES);
  const rects = await Promise.all(LEAVES.map((id) => rectOf(page, id)));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      expect(near(rects[i]!, rects[j]!, GAP - 0.5), `${LEAVES[i]} and ${LEAVES[j]} are clear of each other`).toBe(false);
  // It settled near where it was dropped, not back at its start.
  const placed = rects[LEAVES.indexOf('t-build')]!;
  expect(Math.hypot(placed.x - b.x, placed.y - b.y)).toBeLessThan(Math.hypot(a.x - b.x, a.y - b.y) + b.w);
  expect(requests).toEqual([]);
});

test('a drop in free space inside its own container stays exactly where it was put', async ({ page }) => {
  await open(page);
  const a = (await rectOf(page, 't-test'))!;
  const g = (await rectOf(page, 'm1'))!;
  const cam = await camera(page);
  // Below every member, still well inside the page: the container grows to hold it.
  const target = { x: a.x, y: g.y + g.h + 120 };
  const dx = target.x - a.x;
  const dy = target.y - a.y;
  const from = await toClient(page, a.x + a.w / 2, a.y + a.h / 2);
  await leftDrag(page, from, { x: from.x + dx * cam.zoom, y: from.y + dy * cam.zoom });
  await still(page, LEAVES);
  const placed = (await rectOf(page, 't-test'))!;
  expect(placed.x).toBeCloseTo(target.x, 0);
  expect(placed.y).toBeCloseTo(target.y, 0);
});
