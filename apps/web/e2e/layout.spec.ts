// WP-L: the layered engine loads lazily in a worker and takes over from the fallback.
import { expect, test } from '@playwright/test';

for (const fixture of ['normal', 'large']) {
  test(`layout: the layered pass replaces the fallback (${fixture})`, async ({ page }) => {
    await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: fixture } });
    await page.goto('/');
    await expect(page.getByTestId('live-dot')).toBeVisible();
    await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
    // Chrome stays responsive after the pass.
    await page.getByTestId('lens-blocked').click();
    await expect(page.getByTestId('lens-blocked')).toHaveClass(/active/);
  });
}

test('layout: once the user has moved the view, the layered pass does not re-frame it', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'large' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('canvas-host').hover();
  const camera = () =>
    page.evaluate(() => (window as unknown as { __gunnflowDebug: { camera: () => { x: number; y: number; zoom: number } } }).__gunnflowDebug.camera());
  const cam0 = await camera();
  await page.mouse.wheel(0, -240); // wheel zoom-in is a user camera move
  // A wheel notch animates to its step: read the camera once that move has landed.
  let last = JSON.stringify(await camera());
  let same = 0;
  await expect
    .poll(async () => {
      const cur = JSON.stringify(await camera());
      same = cur === last ? same + 1 : 0;
      last = cur;
      return same;
    }, { intervals: [100] })
    .toBeGreaterThanOrEqual(4);
  const before = await camera();
  // Zoomed at the view's centre: the centre stayed — a re-frame during the wait would have moved it.
  expect(before.x).toBeCloseTo(cam0.x, 6);
  expect(before.y).toBeCloseTo(cam0.y, 6);
  expect(before.zoom).toBeGreaterThan(cam0.zoom);
  await expect(page.getByTestId('layout-source')).toHaveText('layered', { timeout: 15_000 });
  await page.waitForTimeout(300);
  expect(await camera()).toEqual(before);
});
