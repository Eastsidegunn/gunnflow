// 결정함 v2 (2026-10-08): display groups, action labels, the horizontal action
// bar with inline reason fields, folded and copyable detail items, the
// no-action notice, waiting time, and the inbox-aside camera. Every grouping,
// label, fold and copy rule comes from a wiring file this spec writes into the
// e2e wiring directory (the simulator's own vocabulary — the engine reads none of it).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_WIRING_DIR } from '../playwright.config.js';

const WIRING_FILE = join(E2E_WIRING_DIR, '50-inbox-v2.json');
/** The 'inbox' fixture's hands-on command, as the simulator authors it (2 lines, 67 UTF-8 bytes). */
const COMMAND = 'fake-cli login\nfake-cli publish ./dist/fake-pkg.tgz --access public';

const WIRING = {
  version: '0.1.0',
  attention: [
    { match: { cause: 'waiting_for_human' }, mechanism: 'interrupt', group: 'Decide' },
    { match: { cause: 'needs_hands' }, mechanism: 'interrupt', group: 'Do' },
    { match: { cause: 'flagged' }, mechanism: 'ambient', group: 'Check' },
  ],
  actions: {
    'gate.approve': { label: 'Approve' },
    'gate.requestChanges': { label: 'Request changes' },
    'chore.done': { label: 'Report done' },
    'chore.cannot': { label: 'Cannot do' },
  },
  detail: { collapsed: ['afterwards'], copyable: ['command'] },
  kinds: {
    chore: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'state', part: 'label', source: 'state' },
        { id: 'done-note', part: 'text', action: 'chore.done' },
        { id: 'done', part: 'send', action: 'chore.done', requires: [] },
        { id: 'cannot-reason', part: 'text', action: 'chore.cannot' },
        { id: 'cannot', part: 'send', action: 'chore.cannot', requires: ['cannot-reason'] },
      ],
    },
  },
};

test.beforeEach(() => {
  mkdirSync(E2E_WIRING_DIR, { recursive: true });
  writeFileSync(WIRING_FILE, JSON.stringify(WIRING));
});
test.afterEach(() => {
  rmSync(WIRING_FILE, { force: true });
});

/** Records every clipboard write (or refuses them all), so the copy statement can be checked against the bytes written. */
async function stubClipboard(page: Page, mode: 'record' | 'refuse') {
  await page.addInitScript((m) => {
    const writes: string[] = [];
    (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites = writes;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (m === 'refuse') return Promise.reject(new Error('denied'));
          writes.push(text);
          return Promise.resolve();
        },
      },
    });
  }, mode);
}

async function open(page: Page) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'inbox' } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('wiring-files-loaded')).toHaveText('1');
}

test('groups: the toggle counts per group; interrupt groups open, the ambient group starts folded (count shown)', async ({ page }) => {
  await open(page);
  const toggle = page.getByTestId('decision-inbox-toggle');
  // 'inbox': g-publish waits for a decision, two hands-on requests, one flagged task.
  await expect(page.getByTestId('decision-inbox-groups')).toHaveText('Decide 1 · Do 2 · Check 1');
  await expect(page.getByTestId('decision-inbox-group-0')).toHaveAttribute('data-mechanism', 'interrupt');
  await expect(page.getByTestId('decision-inbox-group-1')).toHaveAttribute('data-mechanism', 'interrupt');
  await expect(page.getByTestId('decision-inbox-group-2')).toHaveAttribute('data-mechanism', 'ambient');
  await expect(page.getByTestId('decision-inbox-count')).toHaveCount(0);

  await toggle.click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('Decide 1 · Do 2 · Check 1');
  await expect(page.getByTestId('inbox-group-toggle-0')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('inbox-group-toggle-1')).toHaveAttribute('aria-expanded', 'true');
  // Folded, never hidden: the ambient group's line and count stay.
  const check = page.getByTestId('inbox-group-toggle-2');
  await expect(check).toHaveAttribute('aria-expanded', 'false');
  await expect(check).toHaveText('▸ Check 1');
  await expect(inbox.getByTestId('inbox-row-t-test')).toHaveCount(0);
  await expect(inbox.getByTestId('inbox-row-g-publish')).toBeVisible();
  await expect(inbox.getByTestId('inbox-row-c-publish')).toBeVisible();
  await check.click();
  await expect(check).toHaveAttribute('aria-expanded', 'true');
  await expect(inbox.getByTestId('inbox-row-t-test')).toContainText('flagged');

  // The first item of the first open group is selected; ↓ walks the open groups in display order.
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('inbox-row-c-publish')).toHaveAttribute('data-selected', 'yes');

  // Waiting time from the received attention.since (fixed simulator clock: days ago).
  await expect(page.getByTestId('inbox-since-c-publish')).toHaveText(/ · \d+일 전$/);
  await expect(page.getByTestId('inbox-detail-since')).toHaveText(/\d+일 전$/);
});

test('action bar: config labels, primary first, required reason expands in place, optional primary note inline', async ({ page }) => {
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  const bar = page.getByTestId('action-bar');
  await expect(bar).toBeVisible();

  // The labelled primary action, with its optional note inline in the bar.
  const approve = page.getByTestId('generic-send-gate.approve');
  await expect(approve).toHaveText('Approve');
  await expect(approve).toHaveClass(/primary/);
  await expect(page.getByTestId('generic-text-gate.approve')).toHaveAttribute('placeholder', 'Approve 메모 (선택)');
  // No label in the config: the raw action name.
  await expect(page.getByTestId('generic-send-gate.reject')).toHaveText('gate.reject');

  // Required text: the button opens a multi-line field above the bar.
  const opener = page.getByTestId('generic-open-gate.requestChanges');
  await expect(opener).toHaveText('Request changes');
  await expect(page.getByTestId('action-expand-gate.requestChanges')).toHaveCount(0);
  await opener.click();
  const field = page.getByTestId('action-expand-gate.requestChanges');
  await expect(field).toBeVisible();
  const reason = page.getByTestId('generic-text-gate.requestChanges');
  await expect(reason).toHaveAttribute('placeholder', 'Request changes 사유');
  const sendReason = page.getByTestId('generic-send-gate.requestChanges');
  await expect(sendReason).toHaveText('보내기');
  await expect(sendReason).toBeDisabled();
  await reason.fill('Tighten the headline first.');
  await expect(sendReason).toBeEnabled();
  // 취소 closes the field without destroying what was typed.
  await page.getByTestId('generic-cancel-gate.requestChanges').click();
  await expect(field).toHaveCount(0);
  await opener.click();
  await expect(page.getByTestId('generic-text-gate.requestChanges')).toHaveValue('Tighten the headline first.');

  // A hands-on request: labelled report actions from its kind assembly.
  await page.getByTestId('inbox-row-c-publish').click();
  await expect(page.getByTestId('inbox-detail-title')).toHaveText('Publish the package by hand');
  const done = page.getByTestId('generic-send-chore.done');
  await expect(done).toHaveText('Report done');
  await expect(done).toHaveClass(/primary/);
  await expect(done).toBeEnabled();
  await expect(page.getByTestId('generic-text-chore.done')).toHaveAttribute('placeholder', 'Report done 메모 (선택)');
  await page.getByTestId('generic-open-chore.cannot').click();
  await expect(page.getByTestId('generic-text-chore.cannot')).toHaveAttribute('placeholder', 'Cannot do 사유');
});

test('copy box: line numbers, visible line-feed marker, copy writes the exact bytes and states lines/bytes', async ({ page }) => {
  await stubClipboard(page, 'record');
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  await page.getByTestId('inbox-row-c-publish').click();
  const detail = page.getByTestId('node-detail-section');
  await expect(detail).toContainText('why');
  // Agent content carries the claim stripe.
  await expect(page.getByTestId('node-detail-claim')).toHaveAttribute('data-grade', 'claim');

  // detail items: why, where, command, afterwards — the command is item 2.
  const box = page.getByTestId('copy-box-2');
  await expect(box).toBeVisible();
  await expect(box.getByTestId('copy-box-2-line')).toHaveText(['1', '2']);
  const eol = box.locator('[data-testid="copy-box-2-mark"][data-cls="eol"]');
  await expect(eol).toHaveCount(1);
  await expect(eol).toHaveAttribute('data-mark', '⏎');
  // The box holds exactly the received string (markers are drawn, not inserted).
  expect(await page.getByTestId('copy-box-2-code').evaluate((el) => el.textContent)).toBe(COMMAND);
  await expect(box).toContainText('Gunnflow는 명령을 실행하지 않습니다 — 터미널에서 실행하세요');

  const copy = page.getByTestId('copy-box-2-copy');
  await expect(copy).toHaveText('복사');
  await copy.click();
  await expect(copy).toHaveText('✓ 복사됨 · 2줄 · 67바이트');
  expect(await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites)).toEqual([COMMAND]);

  // The configured label folds (folded, never hidden): one line that opens in place.
  const fold = page.getByTestId('node-detail-fold-3');
  await expect(fold).toHaveText('▸ afterwards');
  await expect(page.getByTestId('node-detail-item-3')).not.toContainText('Report done (a short note is optional).');
  await fold.click();
  await expect(page.getByTestId('node-detail-item-3')).toContainText('Report done (a short note is optional).');
});

test('copy box: a refused clipboard says so and selects the text', async ({ page }) => {
  await stubClipboard(page, 'refuse');
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  await page.getByTestId('inbox-row-c-publish').click();
  await page.getByTestId('copy-box-2-copy').click();
  await expect(page.getByTestId('copy-box-2-failed')).toHaveText('복사 실패 — 직접 선택해 복사하세요');
  await expect(page.getByTestId('copy-box-2-copy')).toHaveText('복사');
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(COMMAND);
});

test('no declared action: the Korean notice instead of buttons', async ({ page }) => {
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  await page.getByTestId('inbox-row-c-silent').click();
  await expect(page.getByTestId('inbox-detail-title')).toHaveText('Look at the shared drive');
  await expect(page.getByTestId('no-actions')).toHaveText('이 항목에 상류가 선언한 행동이 없습니다');
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
});

test('camera: the canvas frames the selection beside the drawer; closing restores the camera the person had', async ({ page }) => {
  await open(page);
  const camera = () => page.evaluate(() => (window as unknown as { __gunnflowDebug: { camera: () => { x: number; y: number; zoom: number } } }).__gunnflowDebug.camera());
  // The person's own view first: a zoom (it also stops the automatic re-fit).
  const host = page.getByTestId('canvas-host');
  const box = (await host.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
  const before = await camera();

  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect.poll(camera).not.toEqual(before);
  // Moving the selection frames again (both items share their mission box, so the frame may coincide).
  await page.getByTestId('inbox-row-c-silent').click();
  await expect(page.getByTestId('inbox-row-c-silent')).toHaveAttribute('data-selected', 'yes');

  await page.getByTestId('inbox-close').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect.poll(camera).toEqual(before);
});
