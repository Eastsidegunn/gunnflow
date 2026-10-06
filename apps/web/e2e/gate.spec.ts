// Human Gate (Screen #5) acceptance: context, decision paths, permission,
// pending/failure separation, credential metadata, preview isolation.
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', {
    data: { name },
  });
  expect(res.ok()).toBeTruthy();
}

async function open(page: Page, fixture = 'gates') {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

async function openGate(page: Page, gateId: string) {
  await page.getByTestId(`node-${gateId}`).dispatchEvent('click');
  await page.getByTestId('enter-approval').click();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
}

test('A: context — workspace node entry, mission/task breadcrumb, inspector entry too', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-review');
  await expect(page.getByTestId('gate-surface')).toHaveAttribute('data-form', 'panel');
  await expect(page.locator('.gate-header .breadcrumb')).toContainText('Ship Website');
  await expect(page.locator('.gate-header .breadcrumb')).toContainText('Draft');
  // ③: no context strip — the gate surface owns the screen; Esc is the only way back.
  await expect(page.getByTestId('work-strip')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('canvas-host')).toBeVisible(); // ②: canvas context returns, selection intact
  // Same gate reachable from the Task Inspector (Related tab).
  await page.getByTestId('node-t-draft').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('tab-related').click();
  await page.getByTestId('open-gate-g-review').click();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
  await expect(page.getByTestId('gate-title')).toContainText('Review draft?');
});

test('B: publish approval — overlay (external effect) with evidence on the isolated origin, understandable in one screen', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-publish');
  await expect(page.getByTestId('gate-surface')).toHaveAttribute('data-form', 'overlay');
  await expect(page.getByTestId('gate-requested-action')).toHaveText('Publish the landing page externally');
  await expect(page.getByTestId('gate-destination')).toHaveText('myblog.example');
  await expect(page.getByTestId('gate-requested-by')).toContainText('Copy Session');
  await expect(page.getByTestId('gate-reason')).toContainText('ready for release');
  await expect(page.getByTestId('gate-impact')).toContainText('external effect');
  // Preview security (H): sandboxed iframe, isolated origin, never same-origin.
  const frame = page.getByTestId('gate-preview-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  expect(await frame.getAttribute('src')).toContain('127.0.0.1:8788/preview/');
});

test('C: approve goes pending → attributed APPROVED (capability-gated, no modes)', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-publish');
  await expect(page.getByTestId('audit-notice')).toContainText('recorded in the audit chain');
  await page.getByTestId('gate-approve').click();
  await expect(page.getByTestId('gate-state')).toContainText('APPROVED');
  await expect(page.getByTestId('gate-decision')).toContainText('approved by fake-actor:local-dev');
  // Approval ≠ effect: the egress effect shows up as its own pending fact (G).
  await expect(page.getByTestId('gate-effects')).toContainText('pending');
});

test('C: privileged deploy requires impact + reason + confirmation (🔴 friction)', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-deploy');
  await expect(page.getByTestId('gate-risk')).toHaveText('privileged');
  await expect(page.getByTestId('gate-credential')).toContainText('GitHub Deploy Credential');
  await page.getByTestId('gate-approve').click(); // opens confirm, does NOT submit
  await expect(page.getByTestId('privileged-confirm')).toContainText('external effect');
  await expect(page.getByTestId('confirm-approve')).toBeDisabled(); // reason required
  await page.getByTestId('gate-reason-input').fill('Release window confirmed with team');
  await page.getByTestId('confirm-approve').click();
  await expect(page.getByTestId('gate-state')).toContainText('APPROVED');
  await expect(page.getByTestId('gate-decision')).toContainText('Release window confirmed with team');
});

test('D: request changes lands as human intent on the linked task; gate resolution stays upstream', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-review');
  await page.getByTestId('gate-request-changes').click();
  await page.getByTestId('gate-changes-input').fill('Shorten the introduction and regenerate the charts.');
  await page.getByTestId('gate-changes-send').click();
  // Gate stays waiting (the fake upstream keeps it open) — no local resolution.
  await expect(page.getByTestId('gate-state')).toContainText('WAITING');
  // The instruction shows up in the linked task's activity as a human event.
  await page.keyboard.press('Escape');
  await page.getByTestId('node-t-draft').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('tab-activity').click();
  await expect(
    page.locator('.activity-list li.human', { hasText: 'Shorten the introduction' }),
  ).toBeVisible();
});

test('E: upstream-disabled capability shows its upstream reason', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-scope');
  await expect(page.getByTestId('gate-approve')).toBeDisabled();
  await expect(page.getByTestId('gate-disabled-reason')).toHaveText('Requires privileged operator.');
  await expect(page.getByTestId('gate-reject')).toBeEnabled();
});

test('H: approved gate with failed effect keeps the two facts separate', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-migrate');
  await expect(page.getByTestId('gate-state')).toContainText('APPROVED');
  await expect(page.getByTestId('effect-failed')).toContainText('failed');
  await expect(page.getByTestId('effect-failed')).toContainText('constraint violation');
  // Decided gate: no action buttons at all.
  await expect(page.getByTestId('gate-approve')).toHaveCount(0);
});

test('I: superseded gate takes no decisions and points at the latest request', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-old-publish');
  await expect(page.getByTestId('gate-inactive')).toContainText('no longer active');
  await expect(page.getByTestId('gate-approve')).toHaveCount(0);
  await page.getByTestId('open-latest-gate').click();
  await expect(page.getByTestId('gate-title')).toContainText('Publish?');
  await expect(page.getByTestId('gate-state')).toContainText('WAITING');
});

test('J: stale connection disables decisions and warns — outcome is never guessed', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-review');
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { dropStream: () => void } }).__gunnflowDebug.dropStream();
  });
  await expect(page.getByTestId('gate-stale')).toContainText('Reconnect before approving');
  await expect(page.getByTestId('gate-approve')).toBeDisabled();
  await expect(page.getByTestId('gate-reject')).toBeDisabled();
});

test('G(credential): no reveal/copy affordance exists anywhere on the surface', async ({ page }) => {
  await open(page);
  await openGate(page, 'g-deploy');
  const surface = page.getByTestId('gate-surface');
  await expect(surface).not.toContainText('Show token');
  await expect(surface).not.toContainText('Copy secret');
  await expect(surface).not.toContainText('Reveal');
});
