// WP-N: the personal layer — a node note and a canvas sticky, saved to the
// local personal file and back after a reload; shown in the personal grade.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PERSONAL_DIR } from '../playwright.config.js';

const FILE = join(E2E_PERSONAL_DIR, 'fake.json');

async function holdPick(page: Page, at: { x: number; y: number }, itemId: string) {
  const host = (await page.getByTestId('canvas-host').boundingBox())!;
  await page.mouse.move(host.x + at.x, host.y + at.y);
  await page.mouse.down({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  const box = (await page.getByTestId(itemId).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
}
const EMPTY = { version: 2, notes: {}, stickies: [], boxes: [], links: [] };
test('personal note and sticky: saved locally, back after a reload, never part of the workspace', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  expect((await page.request.put('http://127.0.0.1:8787/api/personal', { data: EMPTY })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();

  // A note on a node, in the personal grade.
  await page.getByTestId('node-t-build').dispatchEvent('click');
  const note = page.getByTestId('personal-note');
  await expect(note).toHaveAttribute('data-grade', 'personal');
  await expect(note).toContainText('never sent');
  await page.getByTestId('personal-note-text').fill('Ask about the flaky auth test\nbefore Friday');
  await expect(note.getByTestId('personal-save-state')).toHaveText('saved locally');

  // A sticky on the canvas.
  await page.getByTestId('node-stage-close').click();
  await holdPick(page, { x: 80, y: 80 }, 'context-item-personal-note');
  await expect(page.getByTestId('sticky-panel')).toBeVisible();
  await page.getByTestId('sticky-text').fill('Release checklist lives here');
  // The closed node panel may still be fading out (M-02): scope to the sticky panel.
  await expect(page.getByTestId('sticky-panel').getByTestId('personal-save-state')).toHaveText('saved locally');

  // On disk, in the personal file — nowhere in the workspace projection.
  expect(existsSync(FILE)).toBe(true);
  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as { notes: Record<string, { text: string }>; stickies: { text: string }[] };
  expect(stored.notes['t-build']!.text).toBe('Ask about the flaky auth test\nbefore Friday');
  expect(stored.stickies.map((s) => s.text)).toEqual(['Release checklist lives here']);

  // Back after a reload (the BFF reads the file on every request; it keeps no copy).
  await page.reload();
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('personal-stickies-count')).toHaveText('1');
  await expect(page.getByTestId('personal-notes-count')).toHaveText('1');
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await expect(page.getByTestId('personal-note-text')).toHaveValue('Ask about the flaky auth test\nbefore Friday');
});

test('a personal diagram without a built-in renderer: source kept, honestly unavailable, back after a reload', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  expect((await page.request.put('http://127.0.0.1:8787/api/personal', { data: EMPTY })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await holdPick(page, { x: 80, y: 80 }, 'context-item-personal-diagram');
  await expect(page.getByTestId('sticky-panel')).toBeVisible();
  const source = 'erDiagram\n  GOAL ||--o{ SUBGOAL : splits\n  SUBGOAL ||--o{ NOTE : holds\n';
  await page.getByTestId('sticky-text').fill(source);
  // No renderer in this build: the sticky says so and keeps the source as text.
  await expect(page.getByTestId('sticky-diagram-state')).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
  await expect(page.getByTestId('sticky-panel').getByTestId('personal-save-state')).toHaveText('saved locally');

  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as { version: number; stickies: { id: string; kind: string; text: string }[] };
  expect(stored.version).toBe(2);
  const sticky = stored.stickies[0]!;
  expect(sticky).toMatchObject({ kind: 'mermaid', text: source });
  // Nothing is served for it on the isolated origin.
  const hash = createHash('sha256').update(source, 'utf8').digest('hex');
  expect((await page.request.get(`http://127.0.0.1:8788/personal-render/${hash}`)).status()).toBe(404);

  await page.reload();
  await expect(page.getByTestId('live-dot')).toBeVisible();
  const entry = page.getByTestId(`sticky-${sticky.id}`);
  await expect(entry).toHaveAttribute('data-kind', 'mermaid');
  await entry.dispatchEvent('click');
  await expect(page.getByTestId('sticky-diagram-state')).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
  await expect(page.getByTestId('sticky-text')).toHaveValue(source);
});
