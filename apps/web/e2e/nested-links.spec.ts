// GF-E: a relation from a container to its own member is not drawn as a line
// (the nesting already shows where the member is) but as a '◂' chip on the
// member; hovering the chip names the relation, clicking pins the detail.
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
async function still(page: Page, ids: string[], times = 4) {
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
    .toBeGreaterThanOrEqual(times);
}

/** No personal items: a leftover sticky or box from another scenario must not lie under the aimed points. */
const EMPTY_PERSONAL = { version: 2, notes: {}, stickies: [], boxes: [], links: [] };

type Dbg = { sceneEdges: () => { from: string; to: string; type: string }[]; nestedLinks: () => Record<string, unknown[]>; chipRect: (id: string) => Rect | undefined };
const dbg = <T,>(page: Page, f: string, arg?: string) =>
  page.evaluate(([fn, a]) => ((window as unknown as { __gunnflowDebug: Record<string, (x?: string) => unknown> }).__gunnflowDebug[fn!]!(a)), [f, arg] as const) as Promise<T>;

async function open(page: Page) {
  expect((await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'nested-flow' } })).ok()).toBeTruthy();
  expect((await page.request.put('http://127.0.0.1:8787/api/personal', { data: { version: 2, notes: {}, stickies: [], boxes: [], links: [] } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
  await still(page, ['d-report', 'm1']);
}

test('a container → own-member relation: no line, one chip; hover names it, click pins it, a row selects the container', async ({ page }) => {
  await open(page);
  const edges = await dbg<{ from: string; to: string; type: string }[]>(page, 'sceneEdges');
  expect(edges.filter((e) => e.from === 'm1' && e.to === 'd-report')).toEqual([]);
  // The sibling relation inside the mission is still a line.
  expect(edges.some((e) => e.from === 't-research' && e.to === 'd-report' && e.type === 'produces')).toBe(true);
  const links = await dbg<Record<string, unknown[]>>(page, 'nestedLinks');
  expect(Object.keys(links)).toEqual(['d-report']);
  expect(links['d-report']).toEqual([{ type: 'produces', other: 'm1', direction: 'in' }]);

  const chip = (await dbg<Rect>(page, 'chipRect', 'd-report'))!;
  const at = await toClient(page, chip.x + chip.w / 2, chip.y + chip.h / 2);
  await page.mouse.move(at.x, at.y);
  const pop = page.getByTestId('nested-link-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toHaveAttribute('data-pinned', 'no');
  await expect(page.getByTestId('nested-link-0')).toContainText('produces');
  await page.mouse.click(at.x, at.y);
  await expect(pop).toHaveAttribute('data-pinned', 'yes');
  // Clicking the chip selected nothing.
  expect(await selected(page)).toBeNull();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await page.mouse.click(at.x, at.y);
  await page.getByTestId('nested-link-0').click();
  await expect.poll(() => selected(page)).toBe('m1');
  await expect(pop).toHaveCount(0);
});

test('a pinned chip popover: one Esc closes only it (the selection stays); a press on the chrome closes it; the mirror speaks the relation', async ({ page }) => {
  await open(page);
  // Keyboard and screen readers reach the relation through the node mirror.
  await expect(page.getByTestId('node-d-report')).toHaveAttribute('aria-description', /Ship Website produces this/);

  // Select another node, then pin the chip popover.
  const t = (await rectOf(page, 't-build'))!;
  const tAt = await toClient(page, t.x + t.w / 2, t.y + t.h / 2);
  await page.mouse.click(tAt.x, tAt.y);
  await expect.poll(() => selected(page)).toBe('t-build');
  // A selection grows the node and, 400 ms later, may pan it clear of the stage (240 ms): aim only once
  // the camera and the nodes have been still for longer than that.
  await still(page, ['t-build', 'd-report'], 8);
  const chip = (await dbg<Rect>(page, 'chipRect', 'd-report'))!;
  const at = await toClient(page, chip.x + chip.w / 2, chip.y + chip.h / 2);
  await page.mouse.click(at.x, at.y);
  const pop = page.getByTestId('nested-link-popover');
  await expect(pop).toHaveAttribute('data-pinned', 'yes');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  expect(await selected(page)).toBe('t-build');

  // A press outside the canvas (the sidebar) closes a pinned popover too.
  await page.mouse.click(at.x, at.y);
  await expect(pop).toHaveAttribute('data-pinned', 'yes');
  const side = (await page.getByText('Workspace', { exact: true }).first().boundingBox())!;
  await page.mouse.click(side.x + 4, side.y + 4);
  await expect(pop).toHaveCount(0);
});

