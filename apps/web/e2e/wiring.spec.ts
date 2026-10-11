// WP-K: with an empty wiring/ directory the summary says what is in use — in fake mode, only the
// simulator's own layer (served by the BFF ahead of the directory), nothing loaded from the directory.
import { expect, test } from '@playwright/test';
import { SIMULATOR_WIRING, SIMULATOR_WIRING_FILE } from '@gunnflow-testing/fake-contracts';

test('empty wiring directory: only the simulator layer, nothing else loaded or rejected', async ({ page }) => {
  await page.request.post('/api/_fake/fixture', { data: { name: 'normal' } });
  await page.request.delete('/api/wiring/user');
  const files = await page.request.get('/api/wiring');
  expect(await files.json()).toEqual([{ file: SIMULATOR_WIRING_FILE, config: SIMULATOR_WIRING }]);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('wiring-state')).toHaveText('ok (5 kinds)');
  await expect(page.getByTestId('wiring-files-loaded')).toHaveText('1');
  await expect(page.getByTestId('wiring-files-rejected')).toHaveText('0');
});
