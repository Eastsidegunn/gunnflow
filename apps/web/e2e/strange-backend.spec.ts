// An unfamiliar backend: a ticket board on the direct wire that shares no vocabulary
// with the simulator (kinds board/ticket, states open/done, relation 'on', cause 'ping',
// actions ticket.close / ticket.note / ticket.rewrite). Each scenario asserts what a
// backend-agnostic cockpit should do with it. Scenarios that fail today because the app
// still assumes the simulator's domain are marked `test.fail` with the audit item —
// they turn into "unexpectedly passed" once that item is fixed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STRANGE_URL, STRANGE_WIRING_DIR } from '../playwright.strange.config.js';

test.use({ baseURL: 'http://127.0.0.1:25174' });

/** The board's own attention word mapped to an interrupt — wiring the backend's owner would write. */
const WIRING_FILE = join(STRANGE_WIRING_DIR, '50-strange.json');

test.beforeAll(() => {
  mkdirSync(STRANGE_WIRING_DIR, { recursive: true });
  writeFileSync(
    WIRING_FILE,
    JSON.stringify({ version: '0.1.0', attention: [{ match: { cause: 'ping' }, mechanism: 'interrupt', group: 'Pinged' }] }),
  );
});
test.afterAll(() => rmSync(WIRING_FILE, { force: true }));

async function open(page: Page, options: { empty?: boolean } = {}) {
  const reset = await page.request.post(`${STRANGE_URL}/_strange/reset`, { data: options });
  expect(reset.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

async function select(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).dispatchEvent('click');
  return page.getByTestId('node-stage');
}

test('strange: nodes stream in, kinds and states shown raw', async ({ page }) => {
  await open(page);
  for (const id of ['b-1', 'k-1', 'k-2']) await expect(page.getByTestId(`node-${id}`)).toHaveCount(1);
  const stage = await select(page, 'k-1');
  await expect(stage).toContainText('Wobbly hinge');
  await expect(stage).toContainText('ticket · open');
  await expect(await select(page, 'k-2')).toContainText('ticket · done');
});

test('strange: ticket.close shows its effect and the intent resolves as confirmed', async ({ page }) => {
  test.fail(true, 'known failure — audit H2: fakeIntentAdapter has no estimate for ticket.close, so the sent intent never leaves in-flight');
  await open(page);
  const stage = await select(page, 'k-1');
  await page.getByTestId('generic-send-ticket.close').click();
  await expect(stage).toContainText('ticket · done');
  await expect(page.getByTestId('receipt-ticket.close')).toHaveAttribute('data-state', 'confirmed', { timeout: 5000 });
});

test('strange: the editable notes get an editor that sends ticket.rewrite and shows the new body', async ({ page }) => {
  test.fail(true, 'known failure — audit H3/M3: the editor part exists only for action artifact.edit on wired simulator kinds; ticket.rewrite shows "needs an editor"');
  await open(page);
  await select(page, 'k-1');
  await expect(page.getByTestId('editor-part')).toBeVisible();
  await page.getByTestId('editor-start').click();
  await page.getByTestId('editor-buffer').fill('# Wobbly hinge\n\nOiled on Tuesday.\n');
  await page.getByTestId('editor-send').click();
  await expect(page.getByTestId('editor-saved')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toContainText('Oiled on Tuesday.');
});

test('strange: the open ticket served an execution can be entered', async ({ page }) => {
  test.fail(true, 'known failure — audit H1/M1: the inspector and its Execution entry exist only for domain kind task');
  await open(page);
  await select(page, 'k-1');
  // An assertion, not a bare click: a known failure must fail, not time out.
  await expect(page.getByTestId('enter-inspector')).toBeVisible();
  await page.getByTestId('enter-inspector').click();
  await expect(page.getByTestId('open-execution')).toBeVisible();
  await page.getByTestId('open-execution').click();
  await expect(page.getByTestId('execution-surface')).toContainText('found the squeak');
});

test('strange: with zero nodes the empty screen offers no simulator action', async ({ page }) => {
  test.fail(true, "known failure — audit M2: the empty state always offers '+ start mission' (mission.create)");
  await open(page, { empty: true });
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('start-mission')).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).not.toContainText(/mission/i);
});

test('strange: the default lenses assume no simulator kinds or states, and every node shows', async ({ page }) => {
  test.fail(true, 'known failure — audit M3: the built-in lenses are Running/Deliverables/Blocked (simulator states and kinds)');
  await open(page);
  for (const id of ['b-1', 'k-1', 'k-2']) await expect(page.getByTestId(`node-${id}`)).toHaveCount(1);
  for (const lens of ['running', 'deliverables', 'blocked']) await expect(page.getByTestId(`lens-${lens}`)).toHaveCount(0);
});

test('strange: the pinged ticket is in the decision inbox with its own actions', async ({ page }) => {
  test.fail(true, 'known failure — audit M3: only wired (simulator) kinds get input parts; ticket.note shows disabled, "needs text input"');
  await open(page);
  await page.getByTestId('decision-inbox-toggle').click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('inbox-row-k-1')).toBeVisible();
  await expect(page.getByTestId('inbox-row-k-2')).toHaveCount(0);
  await page.getByTestId('inbox-row-k-1').click();
  await expect(inbox.getByTestId('generic-send-ticket.close')).toBeVisible();
  // ticket.note declares a required text input: the cockpit must offer a way to write it.
  await expect(inbox.getByTestId('generic-open-ticket.note').or(inbox.getByTestId('generic-text-ticket.note'))).toBeVisible();
});

test('strange: the terminal panel lists and joins the board terminal and echoes input', async ({ page }) => {
  await open(page);
  await page.getByTestId('terminals-toggle').click();
  await expect(page.getByTestId('term-row-tty-k1')).toBeVisible();
  await page.getByTestId('term-open-tty-k1').click();
  const screen = page.getByTestId('term-screen');
  await expect(screen).toHaveAttribute('data-status', 'live');
  await expect(screen.locator('.xterm-rows')).toContainText('hinge console ready');
  await screen.click();
  await page.keyboard.type('squeak');
  await page.keyboard.press('Enter');
  await expect(screen.locator('.xterm-rows')).toContainText('squeak');
});
