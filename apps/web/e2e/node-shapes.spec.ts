// Node shapes (GF-P1b D): a wiring file gives kinds a shape and size; the
// canvas sizes, outlines and hit-tests nodes by it, draws a band container,
// and previews where a drag will settle. The simulator's kinds stand in for
// any vocabulary — the engine reads none of them.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_WIRING_DIR } from '../playwright.config.js';

const WIRING_FILE = join(E2E_WIRING_DIR, '50-shapes.json');
const WIRING = {
  version: '0.1.0',
  kinds: {
    task: { shape: 'circle' },
    gate: { shape: 'diamond', size: 1.2 },
    deliverable: { shape: 'pill' },
    mission: { shape: 'band' },
  },
};
test.beforeEach(() => {
  mkdirSync(E2E_WIRING_DIR, { recursive: true });
  writeFileSync(WIRING_FILE, JSON.stringify(WIRING));
});
test.afterEach(() => {
  rmSync(WIRING_FILE, { force: true });
});

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

type Preview = { shape: string; x: number; y: number; w: number; h: number }[];
const preview = (page: Page) => page.evaluate(() => (window as unknown as { __gunnflowDebug: { dropPreview: () => Preview } }).__gunnflowDebug.dropPreview());

async function open(page: Page, fixture: string) {
  expect((await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: fixture } })).ok()).toBeTruthy();
  expect((await page.request.put('http://127.0.0.1:8787/api/personal', { data: { version: 2, notes: {}, stickies: [], boxes: [], links: [] } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('wiring-files-loaded')).toHaveText('1');
  await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
  await still(page, ['t-build', 't-draft', 'd-report']);
}

test('kinds take their shape sizes: a circle task (title beside it), a pill deliverable; nothing is sent', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => { if (!r.url().includes('/api/')) return; if (r.method() !== 'GET') requests.push(r.url()); });
  await open(page, 'normal');
  const t = (await rectOf(page, 't-build'))!;
  // Circle 56 + title room 132 wide, 56 high (tier 1 — nothing selected).
  expect(t.h).toBeCloseTo(56, 0);
  expect(t.w).toBeCloseTo(188, 0);
  const d = (await rectOf(page, 'd-report'))!;
  expect(d.h).toBeCloseTo(56, 0);
  expect(d.w).toBeCloseTo(200, 0);
  expect(requests).toEqual([]);
});

test("a diamond's corner is empty canvas; its centre is the node", async ({ page }) => {
  await open(page, 'gates');
  await still(page, ['g-publish']);
  const g = (await rectOf(page, 'g-publish'))!;
  // The corner of the diamond's square: not the node — the click clears (selects nothing).
  const corner = await toClient(page, g.x + g.w * 0.08, g.y + g.h * 0.08);
  await page.mouse.click(corner.x, corner.y);
  expect(await selected(page)).not.toBe('g-publish');
  const centre = await toClient(page, g.x + g.w / 2, g.y + g.h / 2);
  await page.mouse.click(centre.x, centre.y);
  await expect.poll(() => selected(page)).toBe('g-publish');
});

test('dragging onto another node previews where it will settle; releasing lands exactly there', async ({ page }) => {
  await open(page, 'normal');
  const a = (await rectOf(page, 't-build'))!;
  const b = (await rectOf(page, 't-draft'))!;
  const from = await toClient(page, a.x + 28, a.y + a.h / 2);
  const to = await toClient(page, b.x + 34, b.y + b.h / 2 + 6);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  // Held on top of t-draft: the preview shows a circle somewhere clear of it.
  await expect.poll(async () => (await preview(page)).length).toBe(1);
  const [ghost] = await preview(page);
  expect(ghost!.shape).toBe('circle');
  await page.mouse.up();
  await expect.poll(async () => (await preview(page)).length).toBe(0);
  await still(page, ['t-build']);
  const landed = (await rectOf(page, 't-build'))!;
  expect(landed.x).toBeCloseTo(ghost!.x, 0);
  expect(landed.y).toBeCloseTo(ghost!.y, 0);
});
