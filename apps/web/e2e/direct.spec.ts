// The direct wire end to end: browser → BFF (`direct`) → the simulator's
// direct-wire reference server, with no adapter in between.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_WIRING_DIR } from '../playwright.config.js';

test.use({ baseURL: 'http://127.0.0.1:5174' });

test('direct: nodes stream in, an intent relays, and the effect returns as upstream state', async ({ page }) => {
  const reset = await page.request.post('http://127.0.0.1:8791/_fake/fixture', { data: { name: 'normal' } });
  expect(reset.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  const panel = page.getByTestId('node-stage');
  await expect(panel).toContainText('task · running');
  await page.getByTestId('generic-send-task.pause').click();
  await expect(panel).toContainText('task · paused');
  // Artifact bytes come through the direct wire to the isolated origin (:8798), digest-confirmed.
  const frame = page.getByTestId('generic-viewer-isolated-art-build-report');
  expect(await frame.getAttribute('src')).toMatch(/^http:\/\/127\.0\.0\.1:8798\/artifact\/art-build-report\/[0-9a-f]{64}$/);
  await expect(frame).toHaveAttribute('data-status', 'confirmed');
});

test('direct: a backend outage shows as "backend unreachable"; when it returns the instrument is live again with a new snapshot', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8791/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('node-g-publish')).toHaveCount(0);
  // The reference server goes away for a while and comes back on another fixture.
  await page.request.post('http://127.0.0.1:8791/_fake/restart', { data: { downMs: 3000, fixture: 'gates' } });
  const unreachable = page.getByTestId('backend-unreachable');
  await expect(unreachable).toBeVisible({ timeout: 5000 });
  await expect(unreachable).toContainText('backend unreachable since');
  await expect(page.getByTestId('live-dot')).toBeHidden();
  // Nodes stay (the last known state), not wiped.
  await expect(page.getByTestId('node-t-build')).toHaveCount(1);
  await expect(page.getByTestId('live-dot')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('node-g-publish')).toHaveCount(1);
});

test('direct: the ↻ refresh pulls both legs — safe while unreachable, and brings a fresh snapshot', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8791/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.request.post('http://127.0.0.1:8791/_fake/restart', { data: { downMs: 1500, fixture: 'gates' } });
  await expect(page.getByTestId('backend-unreachable')).toBeVisible({ timeout: 5000 });
  // Pressed during the outage: nothing breaks, the reason is shown.
  await page.getByTestId('refresh-backend').click();
  await expect(page.getByTestId('refresh-backend')).toHaveText('↻', { timeout: 10_000 });
  await page.waitForTimeout(1600);
  // Back up: a refresh reconnects at once (no waiting for the retry delay) with the new snapshot.
  await page.getByTestId('refresh-backend').click();
  await expect(page.getByTestId('live-dot')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('node-g-publish')).toHaveCount(1);
});

test('direct: the wire sends no counts — "need you" and the inbox total are counted from received attention (view)', async ({ page }) => {
  // Every cause of the 'inbox' fixture mapped to interrupt, each in its own group (the simulator's words; the engine reads none).
  const file = join(E2E_WIRING_DIR, '50-direct-needs-you.json');
  mkdirSync(E2E_WIRING_DIR, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: '0.1.0',
      attention: [
        { match: { cause: 'waiting_for_human' }, mechanism: 'interrupt', group: 'Decide' },
        { match: { cause: 'needs_hands' }, mechanism: 'interrupt', group: 'Do' },
        { match: { cause: 'flagged' }, mechanism: 'interrupt', group: 'Blocked' },
      ],
    }),
  );
  try {
    await page.request.post('http://127.0.0.1:8791/_fake/fixture', { data: { name: 'inbox' } });
    await page.goto('/');
    await expect(page.getByTestId('live-dot')).toBeVisible();
    // 'inbox': one waiting decision, two hands-on requests, one flagged task — four nodes.
    const strip = page.getByTestId('strip-needsyou');
    await expect(strip).toHaveText('◆ 4 need you');
    await expect(strip).toHaveAttribute('data-source', 'view');
    await expect(page.getByTestId('decision-inbox-total')).toHaveText('4');
    await expect(page.getByTestId('decision-inbox-groups')).toHaveText('Decide 1 · Do 2 · Blocked 1');
    await expect(page.getByTestId('decision-inbox-toggle')).toHaveText('결정함4 (Decide 1 · Do 2 · Blocked 1)');
    await expect(page.getByTestId('decision-inbox-toggle')).toHaveAttribute('aria-label', '결정함: 4 (Decide 1 · Do 2 · Blocked 1)');
    await page.screenshot({ path: test.info().outputPath('needs-you-direct.png') });
  } finally {
    rmSync(file, { force: true });
  }
});
