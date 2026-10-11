// Interface language: the corner switch changes the cockpit's own text at once,
// with no reload and no request; the choice is kept on this device; data from
// the backend stays as received.
import { expect, test, type Request } from '@playwright/test';

test('switch to 한국어 in the corner → inbox title in Korean → kept after reload, no request made', async ({ page }) => {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'blocked' } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();

  // en by default (the browser locale is pinned to en-US).
  await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('decision-inbox-toggle').click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox.locator('.inbox-header strong')).toHaveText('Decisions');
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('2 pending');

  // The switch itself: no navigation, no request of any kind.
  const requests: Request[] = [];
  const onRequest = (r: Request) => requests.push(r);
  page.on('request', onRequest);
  let navigated = false;
  page.on('framenavigated', () => (navigated = true));
  await page.getByTestId('locale-ko').click();
  await expect(inbox.locator('.inbox-header strong')).toHaveText('결정함');
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('미결 2');
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.waitForTimeout(300);
  page.off('request', onRequest);
  expect(requests.map((r) => r.url())).toEqual([]);
  expect(navigated).toBe(false);
  // Received data is not translated: the gate's label and state stay as sent.
  await expect(page.getByTestId('inbox-row-g-publish')).toContainText('waiting_for_human');

  // Kept on this device: a reload comes back in Korean.
  await page.reload();
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('decision-inbox-toggle')).toContainText('결정함');
  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('decision-inbox').locator('.inbox-header strong')).toHaveText('결정함');
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-pressed', 'true');

  // Back to English from the same corner.
  await page.getByTestId('locale-en').click();
  await expect(page.getByTestId('decision-inbox').locator('.inbox-header strong')).toHaveText('Decisions');
});

test('settings offers the same choice (one store with the corner switch)', async ({ page }) => {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'blocked' } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-prefs').click();
  await expect(page.getByTestId('pref-locale')).toHaveValue('en');
  await page.getByTestId('pref-locale').selectOption('ko');
  await expect(page.getByTestId('settings-tab-keys')).toHaveText('단축키');
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('pref-locale').selectOption('en');
  await expect(page.getByTestId('settings-tab-keys')).toHaveText('Shortcuts');
  await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true');
});
