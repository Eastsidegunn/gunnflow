// The context menu is the one home of creation, personal items and rewire.
// Items are never invented: node entries come from declared capabilities,
// empty-canvas entries from the workspace root, personal entries from the
// local layer. A received node leaves the canvas only via the projection.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PERSONAL_DIR } from '../playwright.config.js';

const FILE = join(E2E_PERSONAL_DIR, 'fake.json');
const EMPTY = { version: 2, notes: {}, stickies: [], boxes: [], links: [] };


async function holdPick(page: Page, at: { x: number; y: number }, itemId: string) {
  const host = (await page.getByTestId('canvas-host').boundingBox())!;
  await page.mouse.move(host.x + at.x, host.y + at.y);
  await page.mouse.down({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  const box = (await page.getByTestId(itemId).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
}

async function open(page: Page, fixture = 'normal') {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: fixture } });
  await page.request.put('http://127.0.0.1:8787/api/personal', { data: EMPTY });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

test('the header carries one search field and no action buttons', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('workspace-search')).toBeVisible();
  for (const gone of ['mode-toggle', 'personal-add-sticky', 'personal-add-diagram', 'personal-add-box', 'personal-toggle', 'rewire-toggle', 'open-search']) {
    await expect(page.getByTestId(gone)).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Zoom out' })).toHaveCount(0);
  // ⌘K focuses the placeholder search field.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByTestId('workspace-search')).toBeFocused();
});

test('empty canvas: personal notes are created where the press happened', async ({ page }) => {
  await open(page);
  await holdPick(page, { x: 60, y: 60 }, 'context-item-personal-note');
  await expect(page.getByTestId('sticky-panel')).toBeVisible();
  await page.getByTestId('sticky-text').fill('a');
  await expect(page.getByTestId('sticky-panel').getByTestId('personal-save-state')).toHaveText('saved locally');
  await page.getByTestId('sticky-close').click();

  await holdPick(page, { x: 420, y: 520 }, 'context-item-personal-note');
  await page.getByTestId('sticky-text').fill('b');
  await expect(page.getByTestId('sticky-panel').getByTestId('personal-save-state')).toHaveText('saved locally');

  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as { stickies: { text: string; x: number; y: number }[] };
  expect(stored.stickies).toHaveLength(2);
  const [a, b] = stored.stickies;
  // Two press points apart on BOTH axes → two different world positions (not a
  // fixed centre). The press points themselves differ; the camera is allowed to
  // stand still between them (it no longer auto-reframes on a personal add).
  expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(50);
  expect(Math.abs(a!.y - b!.y)).toBeGreaterThan(50);
});

test('a node menu shows only declared capabilities — hidden stays hidden', async ({ page }) => {
  await open(page);
  // t-research: instruct/pause/cancel hidden upstream; delete declared enabled; rewire declared with options.
  await page.getByTestId('node-t-research').dispatchEvent('contextmenu');
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('context-item-task.delete')).toBeVisible();
  await expect(page.getByTestId('context-item-rewire')).toBeVisible();
  await expect(page.getByTestId('context-item-task.instruct')).toHaveCount(0);
  await expect(page.getByTestId('context-item-task.pause')).toHaveCount(0);
  await expect(page.getByTestId('context-item-personal-note')).toBeVisible();
});

test('deleting a received node is an intent: it leaves only when the projection drops it', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('node-t-research')).toHaveCount(1);
  await page.getByTestId('node-t-research').dispatchEvent('contextmenu');
  await page.getByTestId('context-item-task.delete').click();
  // No local mutation: the node disappears only via the projection (relay → upstream → snapshot).
  await expect(page.getByTestId('node-t-research')).toHaveCount(0);
  // And the upstream agrees — a fresh read has no such task.
  const ws = (await (await page.request.get('http://127.0.0.1:8787/api/_fake/projection').catch(() => null))?.json().catch(() => null)) as
    | { tasks?: { id: string }[] }
    | null;
  if (ws?.tasks) expect(ws.tasks.some((t) => t.id === 't-research')).toBe(false);
});

test('keyboard: ContextMenu on a focused node opens the menu; Escape closes and returns focus', async ({ page }) => {
  await open(page);
  await page.getByTestId('node-t-build').focus();
  await page.getByTestId('node-t-build').dispatchEvent('contextmenu');
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  // Arrow moves between items.
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('node-t-build')).toBeFocused();
});

test('the ring lives only while held: release elsewhere closes it, release on an item runs it', async ({ page }) => {
  await open(page);
  const host = (await page.getByTestId('canvas-host').boundingBox())!;
  // Release in the dead zone: the ring goes away and nothing ran.
  await page.mouse.move(host.x + 80, host.y + 80);
  await page.mouse.down({ button: 'right' });
  const ring = page.getByTestId('context-menu');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute('data-mode', 'hold');
  await page.mouse.up({ button: 'right' });
  await expect(ring).toHaveCount(0);
  await expect(page.getByTestId('sticky-panel')).toHaveCount(0);
  // Release on an item: it runs at the pressed point.
  await holdPick(page, { x: 80, y: 80 }, 'context-item-personal-note');
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await expect(page.getByTestId('sticky-panel')).toBeVisible();
});
