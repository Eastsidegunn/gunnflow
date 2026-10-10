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
  // The total beside the groups: nodes with an interrupt-mapped cause (the ambient Check row is not counted).
  await expect(page.getByTestId('decision-inbox-total')).toHaveText('3');
  await expect(toggle).toHaveAttribute('aria-label', '결정함: 3 (Decide 1 · Do 2 · Check 1)');
  // This upstream sends its own count (one waiting gate): the strip shows that, not the inbox total.
  await expect(page.getByTestId('strip-needsyou')).toHaveText('◆ 1 need you');
  await expect(page.getByTestId('strip-needsyou')).toHaveAttribute('data-source', 'received');
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
  // No label in the config: the raw action name. Its optional reason is not the inline one,
  // so the button opens an expand-in-place form (it never sends a text it does not show).
  await expect(page.getByTestId('generic-open-gate.reject')).toHaveText('gate.reject');
  await expect(page.getByTestId('generic-send-gate.reject')).toHaveCount(0);
  await page.getByTestId('generic-open-gate.reject').click();
  await expect(page.getByTestId('generic-text-gate.reject')).toHaveAttribute('placeholder', 'gate.reject 사유 (선택)');
  // Optional: 보내기 runs with the field empty.
  await expect(page.getByTestId('generic-send-gate.reject')).toBeEnabled();
  await page.getByTestId('generic-cancel-gate.reject').click();

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

type Debug = {
  camera: () => { x: number; y: number; zoom: number };
  selectedId: () => string | null;
  nodeRect: (id: string) => { x: number; y: number; w: number; h: number } | undefined;
};
type Box = { left: number; top: number; right: number; bottom: number };
const camera = (page: Page) => page.evaluate(() => (window as unknown as { __gunnflowDebug: Debug }).__gunnflowDebug.camera());
const canvasSelection = (page: Page) => page.evaluate(() => (window as unknown as { __gunnflowDebug: Debug }).__gunnflowDebug.selectedId());
/** Where the canvas draws a node right now, in client coordinates (null when it is not drawn). */
const drawnBox = (page: Page, id: string) =>
  page.evaluate((nodeId): Box | null => {
    const dbg = (window as unknown as { __gunnflowDebug: Debug }).__gunnflowDebug;
    const r = dbg.nodeRect(nodeId);
    if (!r) return null;
    const cam = dbg.camera();
    const host = document.querySelector('[data-testid="canvas-host"] canvas')!.getBoundingClientRect();
    const sx = (wx: number) => host.left + host.width / 2 + (wx - cam.x) * cam.zoom;
    const sy = (wy: number) => host.top + host.height / 2 + (wy - cam.y) * cam.zoom;
    return { left: sx(r.x), top: sy(r.y), right: sx(r.x + r.w), bottom: sy(r.y + r.h) };
  }, id);
const centerOf = (b: Box) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });

/** Polls until `read` returns the same value `times` polls in a row (≈100 ms apart); returns it. */
async function settled<T>(read: () => Promise<T>, times = 4): Promise<T> {
  let last = await read();
  let same = 0;
  await expect
    .poll(
      async () => {
        const cur = await read();
        same = JSON.stringify(cur) === JSON.stringify(last) ? same + 1 : 0;
        last = cur;
        return same;
      },
      { intervals: [100], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(times);
  return last;
}
/** Camera plus the drawn boxes of the given nodes: geometry is still when this stops changing. */
const geometry = (page: Page, ids: readonly string[]) => async () => ({
  cam: await camera(page),
  boxes: await Promise.all(ids.map((id) => drawnBox(page, id))),
});

/** The visible canvas area: the canvas left of the drawer (or all of it when the drawer is closed). */
async function visibleArea(page: Page): Promise<Box> {
  const host = (await page.getByTestId('canvas-host').boundingBox())!;
  const drawer = page.getByTestId('decision-inbox');
  const right = (await drawer.count()) > 0 ? (await drawer.boundingBox())!.x : host.x + host.width;
  return { left: host.x, top: host.y, right, bottom: host.y + host.height };
}
const inside = (b: Box, area: Box, pad = 8) =>
  b.left >= area.left + pad && b.right <= area.right - pad && b.top >= area.top + pad && b.bottom <= area.bottom - pad;

/** Canvas nodes of the 'inbox' fixture other than the inbox's own selection. */
const CANDIDATES = ['t-draft', 'd-report', 't-research', 't-build', 't-test'];
/** A node drawn wholly inside the visible canvas area once geometry is still; null when none is. */
async function visibleTarget(page: Page): Promise<string | null> {
  await settled(geometry(page, ['g-publish', ...CANDIDATES]));
  const area = await visibleArea(page);
  for (const id of CANDIDATES) {
    const b = await drawnBox(page, id);
    if (b && inside(b, area)) return id;
  }
  return null;
}
/** Recomputes the target's centre on still geometry and checks it is still inside the visible area. */
async function aim(page: Page, id: string) {
  await settled(geometry(page, [id]));
  const b = (await drawnBox(page, id))!;
  expect(inside(b, await visibleArea(page)), `${id} drawn inside the visible canvas`).toBe(true);
  return centerOf(b);
}
/**
 * With the inbox open on g-publish, a node the framing put in view — with no
 * help: the canvas frames on open and again when a relayout lands (the frame
 * is computed from the final layout, so it holds once geometry is still).
 */
async function framedTarget(page: Page): Promise<string> {
  const target = await visibleTarget(page);
  expect(target, "the automatic frame puts a node of the selected item's mission left of the drawer").not.toBeNull();
  // The selected item itself is in view too.
  const g = await drawnBox(page, 'g-publish');
  expect(g !== null && inside(g, await visibleArea(page), 0), 'g-publish drawn inside the visible canvas').toBe(true);
  return target!;
}
/** The person's own view first: a wheel zoom (it also stops the automatic re-fit); returns the settled camera. */
async function personZoom(page: Page) {
  const box = (await page.getByTestId('canvas-host').boundingBox())!;
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  return settled(() => camera(page));
}

test('non-modal: with the inbox open the canvas highlights a clicked node and zooms; the inbox selection stays; Esc leaves no stage', async ({ page }) => {
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox).toBeVisible();
  await expect(inbox).toHaveAttribute('role', 'complementary');
  await expect(inbox).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  expect(await canvasSelection(page)).toBeNull();

  // A click on a drawn node left of the drawer selects it on the canvas only.
  const target = await framedTarget(page);
  let at = await aim(page, target);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => canvasSelection(page)).toBe(target);
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  await expect(page.getByTestId('inbox-detail-title')).toHaveText('Publish?');
  await expect(page.getByTestId('node-stage')).toHaveCount(0);

  // Selection resized the node: aim again on still geometry, then double-click — no ③.
  at = await aim(page, target);
  await page.mouse.dblclick(at.x, at.y);
  // The gesture hit the node (a miss on empty canvas would have cleared the selection).
  await expect.poll(() => canvasSelection(page)).toBe(target);
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('task-inspector')).toHaveCount(0);
  await expect(page.getByTestId('gate-surface')).toHaveCount(0);
  await expect(page.getByTestId('node-stage')).toHaveCount(0);

  // Wheel over the visible canvas zooms (the scrim does not swallow it).
  const area = await visibleArea(page);
  const z0 = (await settled(() => camera(page))).zoom;
  await page.mouse.move((area.left + area.right) / 2, area.bottom - 20);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(z0);

  // One Esc, one level: the inbox closes; the looked-at node leaves no stage behind.
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect.poll(() => canvasSelection(page)).toBeNull();
  await expect(page.getByTestId('node-stage')).toHaveCount(0);
});

test('closing the inbox puts back the selection from before it opened (its stage returns, not the inspected one)', async ({ page }) => {
  await open(page);
  await page.getByTestId('node-t-draft').dispatchEvent('click');
  await expect(page.getByTestId('node-stage')).toBeVisible();
  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toHaveCount(0);

  await framedTarget(page);
  const target = await otherTarget(page, 't-draft');
  expect(target).not.toBeNull();
  const at = await aim(page, target!);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => canvasSelection(page)).toBe(target);

  await page.getByTestId('inbox-close').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect.poll(() => canvasSelection(page)).toBe('t-draft');
  await expect(page.getByTestId('node-stage')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toContainText('Draft');
});

/** A visible candidate other than `not`. */
async function otherTarget(page: Page, not: string): Promise<string | null> {
  await settled(geometry(page, CANDIDATES));
  const area = await visibleArea(page);
  for (const id of CANDIDATES) {
    if (id === not) continue;
    const b = await drawnBox(page, id);
    if (b && inside(b, area)) return id;
  }
  return null;
}

test('keyboard: a context menu opened over the canvas owns arrows and Esc while the inbox is open', async ({ page }) => {
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');

  // Click mode (keyboard path): the menu takes the arrows; the inbox selection does not move.
  await page.getByTestId('node-t-build').focus();
  await page.getByTestId('node-t-build').dispatchEvent('contextmenu');
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  // One Esc closes the menu only.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(inbox).toBeVisible();

  // Hold mode (right button held on the visible canvas): Esc closes the ring only.
  const target = await framedTarget(page);
  const at = await aim(page, target);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(inbox).toBeVisible();
  await page.mouse.up({ button: 'right' });
  await expect(inbox).toBeVisible();

  // The next Esc is the inbox's.
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
});

test('a text typed on another surface is never sent invisibly from the bar', async ({ page }) => {
  await open(page);
  // ② stage for the gate: the stacked controls show every text field.
  await page.getByTestId('node-g-publish').dispatchEvent('click');
  await expect(page.getByTestId('node-stage')).toBeVisible();
  await page.getByTestId('generic-text-gate.reject').fill('typed on the stage');
  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  // In the bar the reject reason is not shown, so nothing can send it: only an opener, marked as holding a draft.
  await expect(page.getByTestId('generic-send-gate.reject')).toHaveCount(0);
  await expect(page.getByTestId('hidden-draft-mark-gate.reject')).toBeVisible();
  await page.getByTestId('generic-open-gate.reject').click();
  // Opened, the composing text is on screen before any send.
  await expect(page.getByTestId('generic-text-gate.reject')).toHaveValue('typed on the stage');
  await expect(page.getByTestId('receipt-gate.reject')).toHaveCount(0);
});

test('reduced motion: open → close restores the exact camera; so does open → ③ → back, once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const before = await personZoom(page);

  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect.poll(() => camera(page)).not.toEqual(before);
  await page.getByTestId('inbox-close').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect.poll(() => camera(page)).toEqual(before);
  expect(await settled(() => camera(page))).toEqual(before);

  // Open again, enter ③ from the inbox (the canvas unmounts), come back: the remount's fit must not win.
  await page.getByTestId('decision-inbox-toggle').click();
  await expect.poll(() => camera(page)).not.toEqual(before);
  await page.getByTestId('inbox-enter').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect(page.getByTestId('canvas-host')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  // Still past the stage pan-aside delay (8 polls ≈ 800 ms of no change).
  expect(await settled(() => camera(page), 8)).toEqual(before);

  // The hold is consumed by that one remount: the next ③ round trip fits normally.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('canvas-host')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  expect(await settled(() => camera(page), 8)).not.toEqual(before);
});

test('camera: the canvas frames the selection beside the drawer; closing restores the camera the person had', async ({ page }) => {
  await open(page);
  const before = await personZoom(page);

  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect.poll(() => camera(page)).not.toEqual(before);
  // Moving the selection frames again (both items share their mission box, so the frame may coincide).
  await page.getByTestId('inbox-row-c-silent').click();
  await expect(page.getByTestId('inbox-row-c-silent')).toHaveAttribute('data-selected', 'yes');

  await page.getByTestId('inbox-close').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect(page.getByTestId('node-stage')).toHaveCount(0);
  await expect.poll(() => camera(page)).toEqual(before);
});
