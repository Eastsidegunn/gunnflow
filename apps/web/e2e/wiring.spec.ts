// WP-K: with an empty wiring/ directory the default config is in use, and the summary says so.
import { expect, test } from '@playwright/test';

test('empty wiring directory: default config, nothing loaded or rejected', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.request.delete('http://127.0.0.1:8787/api/wiring/user');
  const files = await page.request.get('http://127.0.0.1:8787/api/wiring');
  expect(await files.json()).toEqual([]);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('wiring-state')).toHaveText('ok (5 kinds)');
  await expect(page.getByTestId('wiring-files-loaded')).toHaveText('0');
  await expect(page.getByTestId('wiring-files-rejected')).toHaveText('0');
});
