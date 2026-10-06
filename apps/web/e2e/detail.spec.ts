// On-demand node detail: opening a node's panel fetches /api/node/:id/detail
// and shows the items as claim-grade plain text; a node without detail shows
// no section at all (404 stays silent).
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', {
    data: { name },
  });
  expect(res.ok()).toBeTruthy();
}

async function open(page: Page, fixture: string) {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

/** Mirror buttons are visually hidden under the canvas; click them directly. */
async function clickNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).dispatchEvent('click');
}

test('task detail: t-build shows its progress item on demand', async ({ page }) => {
  await open(page, 'attention');
  await clickNode(page, 't-build');
  await expect(page.getByTestId('node-detail-section')).toBeVisible();
  await expect(page.getByTestId('node-detail-item-0')).toContainText('progress');
  await expect(page.getByTestId('node-detail-item-0')).toContainText('41/42 tests');
  // Received text is a claim, graded as such.
  await expect(page.getByTestId('node-detail-item-0')).toHaveAttribute('data-grade', 'claim');
});

test('gate detail: g-publish shows the backend recommendation', async ({ page }) => {
  await open(page, 'attention');
  await clickNode(page, 'g-publish');
  await expect(page.getByTestId('node-detail-section')).toBeVisible();
  await expect(page.getByTestId('node-detail-section')).toContainText('recommendation');
  await expect(page.getByTestId('node-detail-section')).toContainText('Approve after reviewing the evidence.');
});

test('a node without detail shows no section — 404 stays silent', async ({ page }) => {
  await open(page, 'attention');
  await clickNode(page, 't-draft');
  await expect(page.getByTestId('node-stage')).toBeVisible();
  await expect(page.getByTestId('node-detail-loading')).toHaveCount(0);
  await expect(page.getByTestId('node-detail-section')).toHaveCount(0);
  await expect(page.getByTestId('node-detail-unsupported')).toHaveCount(0);
});
