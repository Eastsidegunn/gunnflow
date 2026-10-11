// gf-p2-views §1 — view A "Now": the list the cockpit lands on. Waiting on you →
// Moving → Changed since your last look; ↑↓ + Enter open a node in the full view's
// stage (until view B exists); "changed" is the person's own device-local mark.
// View operations (cursor, switching, marking seen) make no request.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_WIRING_DIR } from '../playwright.config.js';

/** The e2e home lands on `all` for the canvas scenarios; this scenario opens on the product default. */
async function setLanding(page: Page, landingView: 'now' | 'all') {
  const cur = (await (await page.request.get(`/api/prefs`)).json()) as { prefs: Record<string, unknown> | null };
  const res = await page.request.put(`/api/prefs`, { data: { ...(cur.prefs ?? {}), landingView } });
  expect(res.ok()).toBeTruthy();
}

/**
 * A person who last looked before any of the fixture's changes: a stored record at revision 0 for
 * this upstream (written only when none is stored yet, so marks made in the test survive a reload).
 * Without it the visit is a first look, which starts at the current revision.
 */
async function lookedBefore(page: Page) {
  const { label } = (await (await page.request.get(`/api/upstream`)).json()) as { label: string };
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ lastSeen: 0, nodes: {} }));
  }, `gunnflow.now.seen.v1|${label}`);
}

async function open(page: Page, fixture = 'views') {
  const res = await page.request.post(`/api/_fake/fixture`, { data: { name: fixture } });
  expect(res.ok()).toBeTruthy();
  await setLanding(page, 'now');
}

async function openViews(page: Page) {
  await open(page);
  await lookedBefore(page);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect(page.getByTestId('now-row-changed-m1')).toBeVisible();
}

const rowIds = (page: Page, section: string) =>
  page.locator(`[data-testid^="now-row-${section}-"]`).evaluateAll((els, s) => els.map((e) => e.getAttribute('data-testid')!.slice(`now-row-${s}-`.length)), section);

test.afterAll(async ({ request }) => {
  const cur = (await (await request.get(`/api/prefs`)).json()) as { prefs: Record<string, unknown> | null };
  await request.put(`/api/prefs`, { data: { ...(cur.prefs ?? {}), landingView: 'all' } });
  await request.post(`/api/_fake/fixture`, { data: { name: 'normal' } });
});

test('lands on Now: three sections in order, with the fixture rows; no canvas', async ({ page }) => {
  await openViews(page);
  await expect(page.getByTestId('view-switch-now')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('view-switch-now')).toHaveText('Now');
  await expect(page.getByTestId('canvas-host')).toHaveCount(0);
  const sections = await page.locator('[data-testid^="now-section-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(sections).toEqual(['now-section-waiting', 'now-section-moving', 'now-section-changed']);
  // Waiting: the received attention, in the decision inbox's order.
  expect(await rowIds(page, 'waiting')).toEqual(['t-build', 't-test']);
  // Moving: active === true only, newest activity first; the mission states no time and sorts last.
  expect(await rowIds(page, 'moving')).toEqual(['t-build', 't-draft', 'm1']);
  await expect(page.getByTestId('now-row-moving-m1')).toContainText('Website');
  await expect(page.getByTestId('now-steps-t-build')).toContainText('3/6');
  // Changed: last looked before revision 1 → every stated change, latest first.
  expect(await rowIds(page, 'changed')).toEqual(['m1', 't-build', 't-draft', 't-test', 'd-report', 't-research']);
  await expect(page.getByTestId('now-count-waiting')).toHaveText('2 waiting on you');
  await expect(page.getByTestId('now-count-moving')).toHaveText('3 moving');
  await expect(page.getByTestId('now-count-changed')).toHaveText('6 changes since your last look');
  await expect(page.getByTestId('now-changed-first-look')).toHaveCount(0);
  // Summaries are received plain text.
  await expect(page.getByTestId('now-row-moving-t-draft')).toContainText('Landing page copy, second pass.');
});

test('a first visit starts at the current revision: nothing listed as changed, and it says so', async ({ page }) => {
  await open(page);
  await page.goto('/');
  await expect(page.getByTestId('now-row-moving-t-build')).toBeVisible();
  await expect(page.getByTestId('now-changed-empty')).toBeVisible();
  await expect(page.getByTestId('now-changed-first-look')).toHaveText('First look — changes show from here on');
  await expect(page.getByTestId('now-changed-memory-only')).toHaveCount(0);
});

test('↓ and Enter open the node in All with its stage; back on Now only that changed row is gone', async ({ page }) => {
  await openViews(page);
  // 2 waiting + 3 moving rows, then changed: m1, t-build, t-draft → the 8th row.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('now-row-changed-t-draft')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('view-switch-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-draft');
  await page.getByTestId('view-switch-now').click();
  expect(await rowIds(page, 'changed')).toEqual(['m1', 't-build', 't-test', 'd-report', 't-research']);
  // Opening marks only the change: t-draft still moves.
  expect(await rowIds(page, 'moving')).toEqual(['t-build', 't-draft', 'm1']);
  // Esc on Now does nothing: the full view's selection (and its stage) is left as it was.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('now-view')).toBeVisible();
  await page.getByTestId('view-switch-all').click();
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-draft');
  // Esc in All never jumps back to Now: it closes the stage (the ladder's own meaning).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('node-stage')).toHaveCount(0);
  await expect(page.getByTestId('view-switch-all')).toHaveAttribute('aria-pressed', 'true');
});

test('mark all seen empties Changed and holds across a reload; nothing advances it by itself', async ({ page }) => {
  await openViews(page);
  await expect(page.getByTestId('now-mark-all-seen')).toHaveText('Mark all seen');
  await page.getByTestId('now-mark-all-seen').click();
  await expect(page.getByTestId('now-changed-empty')).toBeVisible();
  await expect(page.getByTestId('now-count-changed')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('now-count-changed')).toHaveText('0 changes since your last look');
  await page.reload();
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect(page.getByTestId('now-changed-empty')).toBeVisible();
  // The other sections are untouched.
  expect(await rowIds(page, 'waiting')).toEqual(['t-build', 't-test']);
});

test('the decision-inbox key on a waiting row opens the inbox at that item, focused', async ({ page }) => {
  await openViews(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('now-row-waiting-t-test')).toBeFocused();
  await page.keyboard.press('d');
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect(page.getByTestId('inbox-row-t-test')).toHaveAttribute('data-selected', 'yes');
  await expect(page.getByTestId('inbox-row-t-test')).toBeFocused();
});

test.describe('with a folded (ambient) inbox group from the wiring', () => {
  const WIRING_FILE = join(E2E_WIRING_DIR, '50-now-groups.json');
  test.beforeEach(() => {
    mkdirSync(E2E_WIRING_DIR, { recursive: true });
    writeFileSync(
      WIRING_FILE,
      JSON.stringify({
        version: '0.1.0',
        attention: [
          { match: { cause: 'waiting_for_human' }, mechanism: 'interrupt', group: 'Decide' },
          { match: { cause: 'flagged' }, mechanism: 'ambient', group: 'Check' },
        ],
      }),
    );
  });
  test.afterEach(() => rmSync(WIRING_FILE, { force: true }));

  test('opening at a row unfolds its group, selects and focuses it — and again from another row', async ({ page }) => {
    await openViews(page);
    // The wiring has loaded once the list shows its group.
    await expect(page.locator('.now-group-name')).toHaveText(['Check 2']);
    // From the toggle the ambient group starts folded.
    await page.getByTestId('decision-inbox-toggle').click();
    await expect(page.getByTestId('inbox-group-toggle-1')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('decision-inbox')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('now-row-waiting-t-test')).toBeFocused();
    await page.keyboard.press('d');
    await expect(page.getByTestId('inbox-group-toggle-1')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('inbox-row-t-test')).toHaveAttribute('data-selected', 'yes');
    await expect(page.getByTestId('inbox-row-t-test')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('decision-inbox')).toHaveCount(0);

    await page.getByTestId('now-row-waiting-t-build').focus();
    await page.keyboard.press('d');
    await expect(page.getByTestId('inbox-group-toggle-1')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('inbox-row-t-build')).toHaveAttribute('data-selected', 'yes');
    await expect(page.getByTestId('inbox-row-t-build')).toBeFocused();
  });
});

test('switching to Now cancels link mode; Esc on Now leaves the full view alone', async ({ page }) => {
  await openViews(page);
  await page.getByTestId('now-row-moving-t-draft').click();
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-draft');
  await page.getByTestId('personal-note').getByTestId('personal-connect').click();
  await expect(page.getByTestId('personal-connect-banner')).toBeVisible();
  await page.getByTestId('view-switch-now').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('view-switch-all').click();
  await expect(page.getByTestId('personal-connect-banner')).toHaveCount(0);
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-draft');
});

test('a backend that sends no activity or change revisions is said so, not shown as empty lists', async ({ page }) => {
  await open(page, 'attention');
  await page.goto('/');
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect(page.getByTestId('now-row-waiting-g-publish')).toBeVisible();
  await expect(page.getByTestId('now-moving-unsupported')).toHaveText('This backend does not send activity.');
  await expect(page.getByTestId('now-changed-unsupported')).toHaveText('This backend does not send change revisions (changedAtRevision).');
  await expect(page.getByTestId('now-mark-all-seen')).toHaveCount(0);
  // All empty: the calm state claims emptiness only for what this backend sends.
  await page.request.post(`/api/_fake/fixture`, { data: { name: 'normal' } });
  await expect(page.getByTestId('now-calm')).toBeVisible();
  await expect(page.getByTestId('now-waiting-empty')).toBeVisible();
  await expect(page.getByTestId('now-moving-unsupported')).toBeVisible();
  await expect(page.getByTestId('now-changed-unsupported')).toBeVisible();
  await expect(page.getByTestId('now-moving-empty')).toHaveCount(0);
  await expect(page.getByTestId('now-changed-empty')).toHaveCount(0);
  await expect(page.getByTestId('now-calm')).not.toContainText('Nothing is moving.');
});

test('view operations make zero network requests — the first switch included', async ({ page }) => {
  await openViews(page);
  // The layout code preloads after the first snapshot, at idle time; the shell says when it is in.
  await expect(page.locator('.shell')).toHaveAttribute('data-layout-preload', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('canvas-host')).toHaveCount(0);

  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('v'); // the first switch to All, by its binding
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await page.keyboard.press('v'); // → Now
  await expect(page.getByTestId('now-view')).toBeVisible();
  await page.getByTestId('view-switch-all').click();
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await page.getByTestId('view-switch-now').click();
  // The list takes ↑↓ even with focus left on the switch just clicked.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.now-row:focus')).toHaveCount(1);
  await page.getByTestId('now-mark-all-seen').click();
  await expect(page.getByTestId('now-changed-empty')).toBeVisible();
  // The language switch in the corner: the headings follow at once, still without a request.
  await expect(page.getByTestId('now-count-waiting')).toHaveText('2 waiting on you');
  await page.getByTestId('locale-ko').click();
  await expect(page.getByTestId('now-count-waiting')).toHaveText('나를 기다림 2');
  await expect(page.getByTestId('now-count-moving')).toHaveText('움직이는 중 3');
  await expect(page.getByTestId('now-count-changed')).toHaveText('바뀜 (지난 확인 이후) 0');
  await expect(page.getByTestId('view-switch-now')).toHaveText('지금');
  await page.getByTestId('locale-en').click();
  await expect(page.getByTestId('now-count-waiting')).toHaveText('2 waiting on you');
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
});
