// Dynamic-view P3: selecting a node grows it to the tier-3 size (1.6×, theme
// tierScale) with a cleared margin, neighbours settle overlap-free, and moving
// the focus elsewhere returns it symmetrically — all read off the drawn rects
// (the same interpolated geometry hit-testing uses).
import { expect, test, type Page } from '@playwright/test';

interface DrawnRect { x: number; y: number; w: number; h: number }

const BASE_W = 200; // theme geometry.node.w; tier3 = ×1.6 (geometry.tierScale)
const LEAVES = ['t-research', 't-draft', 't-build', 't-test', 'd-report'];

const rect = (page: Page, id: string) =>
  page.evaluate(
    (nid) => (window as unknown as { __gunnflowDebug: { nodeRect: (id: string) => DrawnRect | undefined } }).__gunnflowDebug.nodeRect(nid),
    id,
  );

const overlaps = (a: DrawnRect, b: DrawnRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('P3 space: focus grows 1.6×, settles overlap-free, and returns on refocus', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
  await expect.poll(async () => (await rect(page, 't-build'))?.w).toBe(BASE_W);

  // Select → the box animates to the tier-3 size (geometry is a layout input, not a repaint trick).
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await expect.poll(async () => (await rect(page, 't-build'))?.w, { timeout: 5_000 }).toBe(BASE_W * 1.6);

  // Settled state is overlap-free across every drawn node (P1 invariant extended to push-aside).
  const rects = new Map<string, DrawnRect>();
  for (const id of LEAVES) rects.set(id, (await rect(page, id))!);
  for (const [ia, a] of rects) {
    for (const [ib, b] of rects) {
      if (ia < ib) expect(overlaps(a, b), `${ia} overlaps ${ib}`).toBe(false);
    }
  }

  // Moving the focus is symmetric: the old focus returns to its base size, the new one grows.
  await page.getByTestId('node-t-draft').dispatchEvent('click');
  await expect.poll(async () => (await rect(page, 't-draft'))?.w, { timeout: 5_000 }).toBe(BASE_W * 1.6);
  await expect.poll(async () => (await rect(page, 't-build'))?.w, { timeout: 5_000 }).toBe(BASE_W);
});
