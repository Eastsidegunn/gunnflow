// WP-Q3: settings as an overlay panel; in the View section (backend tabs from
// the wiring file names, kinds inside) a task state's tone changed and saved
// recolours the canvas at once, lands in 90-user.json and survives a reload.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_WIRING_DIR } from '../playwright.config.js';
const ACCENT = '#4da3ff';
const DANGER = '#ff5d5d';

const USER_FILE = join(E2E_WIRING_DIR, '90-user.json');
const tone = (page: Page, id: string) =>
  page.evaluate((nodeId) => (window as unknown as { __gunnflowDebug: { nodeStyle: (i: string) => { tone: string } | undefined } }).__gunnflowDebug.nodeStyle(nodeId)?.tone, id);

test.afterEach(async ({ request }) => {
  await request.delete('http://127.0.0.1:8787/api/wiring/user');
});

test('settings View tab: task · running tone saved → canvas recoloured at once → in 90-user.json → kept after reload', async ({ page }) => {
  await page.request.delete('http://127.0.0.1:8787/api/wiring/user');
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect.poll(() => tone(page, 't-build')).toBe(ACCENT);

  await page.getByTestId('settings-open').click();
  const screen = page.getByTestId('settings-screen');
  await expect(screen).toBeVisible();
  // The overlay's backdrop covers the whole viewport (the panel sits inside it).
  const box = (await screen.boundingBox())!;
  const vp = page.viewportSize()!;
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, vp.width, vp.height]);
  // No wiring files in the e2e dir → the only backend tab is the built-in default.
  await expect(page.getByTestId('settings-src-default')).toHaveAttribute('aria-selected', 'true');
  const task = page.getByTestId('kind-task');
  await expect(task).toBeVisible();
  await expect(task.getByTestId('state-task-running')).toContainText('default');
  // The colour wheel writes a hex literal (the same value the danger token resolves to).
  await page.getByTestId('tone-task-running').fill(DANGER);
  await expect(task.getByTestId('prov-render-running')).toContainText('my settings');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status')).toHaveText('saved · applied');

  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  await expect.poll(() => tone(page, 't-build')).toBe(DANGER);
  expect(existsSync(USER_FILE)).toBe(true);
  expect(JSON.parse(readFileSync(USER_FILE, 'utf8'))).toMatchObject({ render: { running: { glyph: '▶', tone: DANGER } } });

  await page.reload();
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect.poll(() => tone(page, 't-build')).toBe(DANGER);
});
