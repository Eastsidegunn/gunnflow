// Acceptance F: required screen states, plus D/E checks at the UI level.
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', {
    data: { name },
  });
  expect(res.ok()).toBeTruthy();
}

/** Mirror buttons are visually hidden under the canvas; click them directly. */
async function clickNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).dispatchEvent('click');
}

async function open(page: Page, fixture: string) {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

test('F1: empty / first run — quiet prompt, mission starts via relay', async ({ page }) => {
  await open(page, 'empty');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByText('What are we working on?')).toBeVisible();

  // The entry point is live; the write flows through the relay (capability-gated).
  await expect(page.getByTestId('start-mission')).toBeDisabled(); // empty name
  await page.getByTestId('mission-name').fill('Ship Website');
  await page.getByTestId('start-mission').click();
  await expect(page.getByTestId('canvas-host')).toBeVisible();
});

test('F2: normal graph renders tasks, deliverable, live status', async ({ page }) => {
  await open(page, 'normal');
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await expect(page.getByTestId('node-t-build')).toHaveText(/Web Build.*running.*Testing authentication/);
  await expect(page.getByTestId('node-d-report')).toHaveText(/Research Report.*completed/);
  await expect(page.getByTestId('strip-running')).toHaveText(/2 running/);
});

test('F3: attention — needs-you lens highlights the gate, dims the rest (E1)', async ({ page }) => {
  await open(page, 'attention');
  await expect(page.getByTestId('lens-needs-you')).toContainText('1');
  await page.getByTestId('lens-needs-you').click();
  await expect(page.getByTestId('node-g-publish')).toHaveAttribute('data-emphasis', 'highlight');
  await expect(page.getByTestId('node-t-build')).toHaveAttribute('data-emphasis', 'dim');
  await expect(page.getByTestId('strip-needsyou')).toHaveText(/1 need you/);

  // Gate click → the Human Gate surface (Screen #5) opens with full context.
  await clickNode(page, 'g-publish');
  await page.getByTestId('enter-approval').click();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
  await expect(page.getByTestId('gate-title')).toContainText('Publish?');
});

test('F4: blocked — upstream reason at the inspector entry point (B4)', async ({ page }) => {
  await open(page, 'blocked');
  await clickNode(page, 't-test');
  await expect(page.getByTestId('blocked-reason')).toHaveText(
    'Staging environment credentials expired (upstream policy hold)',
  );
  // D3: the privileged action is an entry point, not an execution.
  await page.getByTestId('cancel-task').click();
  await expect(page.getByTestId('privileged-note')).toContainText('nothing was executed');
});

test('F5: large topology stays interactive', async ({ page }) => {
  await open(page, 'large');
  const nodes = page.locator('.a11y-mirror button');
  // The mirror fills once the (large) snapshot is applied; poll rather than sample one instant.
  await expect.poll(() => nodes.count()).toBeGreaterThan(400);
  // UI chrome must not be blocked while the canvas holds the big graph (H).
  await page.getByTestId('canvas-host').hover();
  await page.mouse.wheel(0, 240); // wheel zoom-out — the chrome stays responsive
  await page.getByTestId('lens-blocked').click();
  await expect(page.getByTestId('lens-blocked')).toHaveClass(/active/);
});

test('F6: disconnected projection shows connection loss, hides live dot', async ({ page }) => {
  await loadFixture(page, 'normal');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  // Simulate transport loss via the dev-only debug hook.
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { dropStream: () => void } }).__gunnflowDebug.dropStream();
  });
  await expect(page.getByTestId('connection-lost')).toBeVisible();
  await expect(page.getByTestId('connection-lost')).toContainText('showing state from');
  await expect(page.getByTestId('live-dot')).toBeHidden();
});

test('write path in the UI: pause relays and returns as authoritative state (C)', async ({ page }) => {
  await open(page, 'normal');
  await clickNode(page, 't-build');
  await expect(page.getByTestId('sel-state')).toHaveText('running');
  await page.getByTestId('pause-task').click();
  // The state change arrives only via the upstream projection (C3).
  await expect(page.getByTestId('sel-state')).toHaveText('paused');
});

test('E4: switching lenses never changes upstream counts', async ({ page }) => {
  await open(page, 'attention');
  const before = await page.getByTestId('strip-running').textContent();
  await page.getByTestId('lens-deliverables').click();
  await page.getByTestId('lens-all').click();
  await expect(page.getByTestId('strip-running')).toHaveText(before!);
});
