// Execution Surface (Screen #3) acceptance + performance scenarios.
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name } });
  expect(res.ok()).toBeTruthy();
}

async function burst(page: Page, taskId: string, count: number) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/execution-burst', {
    data: { taskId, count },
  });
  expect(res.ok()).toBeTruthy();
}

async function openExecution(page: Page, taskId: string, fixture = 'normal') {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId(`node-${taskId}`).dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('open-execution').click();
  await expect(page.getByTestId('execution-surface')).toBeVisible();
}

test('navigation: inspector → execution, breadcrumb back to workspace', async ({ page }) => {
  await openExecution(page, 't-build');
  await expect(page.getByTestId('execution-back')).toContainText('Ship Website / Web Build');
  await expect(page.getByTestId('execution-live')).toHaveText('● LIVE');
  await expect(page.getByTestId('session-state')).toContainText('RUNNING');
  await page.getByTestId('execution-back').click();
  await expect(page.getByTestId('canvas-host')).toBeVisible();
});

test('timeline: upstream events verbatim; detail pane with raw event and gate link', async ({ page }) => {
  await openExecution(page, 't-build', 'attention'); // g-publish exists in this fixture
  const rows = page.getByTestId('timeline-row');
  await expect(rows.first()).toContainText('session started');
  await page.locator('[data-testid="timeline-row"]', { hasText: '12 passed, 1 failed' }).click();
  const detail = page.getByTestId('detail-pane');
  await expect(detail).toContainText('shell.result');
  await expect(page.getByTestId('raw-event')).toContainText('"kind": "shell"');
  await detail.getByLabel('Close detail').click();
  // Egress row links to its gate (intent ⇄ decision ⇄ effect chain, projected).
  await page.locator('[data-testid="timeline-row"]', { hasText: 'publish landing page' }).first().click();
  await page.getByTestId('detail-open-gate').click();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
});

test('tabs: messages, tools with failure marker, files diff read-only, policy chain', async ({ page }) => {
  await openExecution(page, 't-build');
  await page.getByTestId('exec-tab-messages').click();
  await expect(page.locator('.message-list li.human')).toContainText('Prefer fixing the implementation');
  await page.getByTestId('exec-tab-tools').click();
  const failedTool = page.locator('.tools-table tr[data-status="failed"]');
  await expect(failedTool).toContainText('✕');
  await page.getByTestId('exec-tab-files').click();
  await expect(page.getByTestId('files-view')).toContainText('src/components/Hero.tsx');
  await page.locator('.file-list button', { hasText: 'src/App.tsx' }).click();
  await expect(page.getByTestId('file-diff')).toContainText('+  <Hero />');
  await expect(page.getByTestId('files-view')).toContainText('Read-only');
  await page.getByTestId('exec-tab-policy').click();
  await expect(page.getByTestId('policy-view')).toContainText('no external egress without approval');
  await expect(page.getByTestId('policy-deny')).toContainText('fetch external analytics API');
  await expect(page.getByTestId('policy-pending')).toContainText('publish landing page');
});

test('multiple sessions: selector switches, no primary inference; paused sibling', async ({ page }) => {
  await openExecution(page, 't-build');
  const selector = page.getByTestId('session-selector');
  await expect(selector).toBeVisible();
  await selector.selectOption('s-185');
  await expect(page.getByTestId('session-state')).toContainText('PAUSED');
  await expect(page.getByTestId('session-resume')).toBeVisible();
});

test('fork lineage marker on child session', async ({ page }) => {
  await openExecution(page, 't-draft');
  await page.getByTestId('session-selector').selectOption('s-201a');
  await expect(page.getByTestId('fork-marker')).toContainText('fork of s-201');
});

test('controls: pause pending → PAUSED; fork adds session; kill is an entry point', async ({ page }) => {
  await openExecution(page, 't-build');
  await page.getByTestId('session-pause').click();
  await expect(page.getByTestId('session-pending')).toContainText('Pausing…');
  await expect(page.getByTestId('session-state')).toContainText('PAUSED');
  // The human intervention lands in the timeline as an attributed event.
  await expect(
    page.locator('[data-testid="timeline-row"]', { hasText: 'Paused by fake-actor:local-dev' }),
  ).toBeVisible();
  await page.getByTestId('session-fork').click();
  await expect(page.getByTestId('session-selector').locator('option')).toHaveCount(3);
  await page.getByTestId('session-kill').click();
  await expect(page.getByTestId('privileged-note')).toContainText('nothing was executed');
});

test('live tail: burst while scrolled up shows new-events counter; click jumps to latest', async ({ page }) => {
  await openExecution(page, 't-build');
  // Grow the tail first so the timeline actually overflows its viewport.
  await burst(page, 't-build', 30);
  await expect(
    page.locator('[data-testid="timeline-row"]', { hasText: 'burst event 30' }),
  ).toBeVisible();
  await page.getByTestId('timeline').evaluate((el) => {
    el.scrollTop = 0; // scroll away from the bottom → auto-scroll pauses
    el.dispatchEvent(new Event('scroll'));
  });
  await burst(page, 't-build', 12);
  await expect(page.getByTestId('new-events')).toContainText('12 new events ↓');
  await page.getByTestId('new-events').click();
  await expect(page.getByTestId('new-events')).toBeHidden();
  // Jumped to the live tail: the last row is the newest burst event.
  await expect(page.getByTestId('timeline-row').last()).toContainText('burst event 12');
});

test('filters: failed-only narrows the timeline, view-only', async ({ page }) => {
  await openExecution(page, 't-build');
  await expect(page.getByTestId('timeline-row').first()).toBeVisible();
  const before = await page.getByTestId('timeline-row').count();
  await page.getByTestId('filter-failed').click();
  const after = await page.getByTestId('timeline-row').count();
  expect(after).toBeLessThan(before);
  await expect(page.getByTestId('timeline-row').first()).toContainText('fetch external analytics API');
  await page.getByTestId('filter-failed').click();
  expect(await page.getByTestId('timeline-row').count()).toBe(before);
});

test('terminal preview: read-only tail + masked env + live-terminal entry (#4)', async ({ page }) => {
  await openExecution(page, 't-build');
  const preview = page.getByTestId('terminal-preview');
  await expect(page.getByTestId('current-command')).toHaveText('$ pnpm test');
  await expect(page.getByTestId('masked-env')).toContainText('API_KEY=••••••');
  await expect(page.getByTestId('masked-env')).not.toContainText('sk-');
  await preview.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-surface')).toBeVisible();
});

test('stale: connection loss shows last event time, removes LIVE, no state inference', async ({ page }) => {
  await openExecution(page, 't-build');
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { dropStream: () => void } }).__gunnflowDebug.dropStream();
  });
  await expect(page.getByTestId('execution-lost')).toHaveText('CONNECTION LOST');
  await expect(page.getByTestId('execution-live')).toHaveCount(0);
  await expect(page.getByTestId('execution-stale')).toContainText('Showing events through');
  await expect(page.getByTestId('execution-stale')).toContainText('not inferred');
});

test('performance: 5000-event fixture stays virtualized and interactive (§34)', async ({ page }) => {
  await loadFixture(page, 'large');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-Lm0t0').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  // Large fixture tasks have no workspace session link — enter via placeholder-free path:
  // the inspector shows no execution section, so use the surface directly? No —
  // execution streams exist for any task under the large fixture.
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  await page.goto('/'); // fall back: open execution through the app hook below
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { openExecution?: (id: string) => void } })
      .__gunnflowDebug.openExecution?.('Lm0t0');
  });
  await expect(page.getByTestId('execution-surface')).toBeVisible();
  // Virtualization: thousands of events, but only a window of DOM rows.
  const rowCount = await page.getByTestId('timeline-row').count();
  expect(rowCount).toBeLessThan(150);
  // Tab switching stays responsive with the big fixture loaded.
  await page.getByTestId('exec-tab-tools').click();
  await page.getByTestId('exec-tab-timeline').click();
  await expect(page.getByTestId('timeline-row').first()).toBeVisible();
  // Burst path: coalesced deltas append without freezing the UI.
  await burst(page, 'Lm0t0', 2000);
  await expect(
    page.locator('[data-testid="timeline-row"]', { hasText: 'burst event 2000' }),
  ).toBeVisible();
});
