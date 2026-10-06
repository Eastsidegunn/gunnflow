// 결정함 (design decision 2026-10-05): wide right drawer over the dimmed canvas. Queue =
// nodes with received attention (interrupt-mapped first), detail = the node's
// GET /detail items verbatim (claim grade, config-emphasized recommendation),
// decisions = the existing intent machinery. Decided items FOLD (§11: never
// hidden, counts invariant).
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, fixture: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: fixture } });
  expect(res.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

test('toggle → count → emphasized recommendation → approve → auto-advance → fold', async ({ page }) => {
  // 'blocked': g-publish (waiting_for_human → interrupt) + t-test (flagged → ambient).
  await open(page, 'blocked');
  await expect(page.getByTestId('decision-inbox-count')).toHaveText('2');
  await page.getByTestId('decision-inbox-toggle').click();
  const inbox = page.getByTestId('decision-inbox');
  await expect(inbox).toBeVisible();
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('미결 2');
  // Canvas stays visible behind the drawer (wide drawer, not a full overlay).
  await expect(page.getByTestId('canvas-host')).toBeVisible();

  // Interrupt-mapped before ambient-mapped; rows carry state + cause verbatim.
  const gateRow = page.getByTestId('inbox-row-g-publish');
  await expect(gateRow).toHaveAttribute('data-mechanism', 'interrupt');
  await expect(gateRow).toContainText('waiting · waiting_for_human');
  await expect(page.getByTestId('inbox-row-t-test')).toContainText('flagged');

  // The first pending item is selected; its detail stands with revision + claim grade.
  await expect(gateRow).toHaveAttribute('data-selected', 'yes');
  await expect(page.getByTestId('inbox-detail-title')).toHaveText('Publish?');
  const detail = page.getByTestId('node-detail-section');
  await expect(detail).toContainText('as of revision');
  // The wiring's detail.emphasis names the 'recommendation' label: that item is emphasized.
  const recommendation = page.locator('[data-testid^="node-detail-item-"]', { hasText: 'recommendation' });
  await expect(recommendation).toHaveAttribute('data-emphasis', 'config');
  await expect(recommendation).toHaveAttribute('data-grade', 'claim');
  await expect(recommendation).toContainText('Approve after reviewing the evidence.');

  // Approve through the existing capability machinery (evidence auto-opened, digest binding as-is).
  const approve = page.getByTestId('generic-send-gate.approve');
  await expect(approve).toBeEnabled();
  await approve.click();

  // Auto-advance to the next pending item; the decided one folds — never removed.
  await expect(page.getByTestId('inbox-row-t-test')).toHaveAttribute('data-selected', 'yes');
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('미결 1');
  const decidedToggle = page.getByTestId('inbox-decided-toggle');
  await expect(decidedToggle).toContainText('결정됨 1');
  await decidedToggle.click();
  await expect(page.getByTestId('inbox-decided-list').getByTestId('inbox-row-g-publish')).toBeVisible();

  // The fold baseline is per OPEN: reopening starts fresh — the decided gate
  // (no received attention any more) is simply absent, not carried as folded.
  await page.getByTestId('inbox-close').click();
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await page.getByTestId('decision-inbox-toggle').click();
  await expect(page.getByTestId('inbox-pending-count')).toHaveText('미결 1');
  await expect(page.getByTestId('decision-inbox').getByTestId('inbox-decided-toggle')).toHaveCount(0);
  await expect(page.getByTestId('decision-inbox').getByTestId('inbox-row-g-publish')).toHaveCount(0);
});

test('keyboard: the configurable binding opens it; ↓ moves; Enter enters ③ with the queue; Esc closes', async ({ page }) => {
  await open(page, 'blocked');
  // Default binding 'd' — a settings item (prefs.keys), not a hardcoded key.
  await page.keyboard.press('d');
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('inbox-row-t-test')).toHaveAttribute('data-selected', 'yes');
  await page.keyboard.press('k'); // vim twin of ↑
  await expect(page.getByTestId('inbox-row-g-publish')).toHaveAttribute('data-selected', 'yes');
  await page.keyboard.press('j');
  // Enter: ③ for the item, queue carried (the floating 대기열 chip — the only thing over the strip-less ③).
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
  await expect(page.getByTestId('task-inspector')).toBeVisible(); // t-test is a task
  await expect(page.getByTestId('work-queue')).toContainText('2/2');
  // Lateral queue move onto the gate: its ③ is the gate surface (external effect → overlay form).
  await page.getByTestId('work-prev').click();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
  await expect(page.getByTestId('work-queue')).toContainText('1/2');
  // Esc from ③ → ②; reopening the inbox starts a fresh fold baseline.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await page.keyboard.press('d');
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('decision-inbox')).toBeHidden();
});
