// N-01 (design decision 2026-10-02): interrupts live behind a top-right toggle carrying
// their count; the list is the current truth and "Go to node" lands on it.
import { expect, test } from '@playwright/test';

test('the toggle counts current interrupts; the list goes to the node; resolution empties it', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'attention' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('notifications-count')).toHaveText('1');
  await page.getByTestId('notifications-toggle').click();
  const panel = page.getByTestId('notifications-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('notification-go-g-publish').click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 'g-publish');
  // A fixture without interrupts: count gone, panel states the quiet honestly.
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await expect(page.getByTestId('notifications-count')).toHaveCount(0);
  await page.getByTestId('notifications-toggle').click();
  await expect(page.getByTestId('notifications-panel')).toContainText('Nothing needs you right now.');
});
