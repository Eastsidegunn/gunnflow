// Task Inspector (Screen #2) acceptance: context retention, live updates,
// write path, observe/intervene × capability, drill-down entries, stale.
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', {
    data: { name },
  });
  expect(res.ok()).toBeTruthy();
}

async function open(page: Page, fixture: string) {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
}

async function openInspector(page: Page, taskId: string) {
  await page.getByTestId(`node-${taskId}`).dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await expect(page.getByTestId('task-inspector')).toBeVisible();
}

test('open flow: stage → ③ work surface fills the screen (no context strip)', async ({ page }) => {
  await open(page, 'normal');
  await openInspector(page, 't-draft');
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Draft');
  await expect(page.getByTestId('inspector-state')).toContainText('RUNNING');
  await expect(page.getByTestId('inspector-current')).toHaveText('Writing landing page copy');
  // ③: the work content owns the screen — no strip (design review ②).
  await expect(page.getByTestId('work-strip')).toHaveCount(0);
  await expect(page.getByTestId('work-back')).toHaveCount(0);
  await expect(page.locator('[data-testid^="work-neighbor-"]')).toHaveCount(0);
  // Deep link reflects the open task.
  expect(page.url()).toContain('#task=t-draft');
});

test('deep link restores selection and inspector', async ({ page }) => {
  await loadFixture(page, 'normal');
  await page.goto('/#task=t-build');
  await expect(page.getByTestId('task-inspector')).toBeVisible();
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Web Build');
});

test('live write path: pause shows pending, state flips only via projection', async ({ page }) => {
  await open(page, 'normal');
  await openInspector(page, 't-build');
  await page.getByTestId('inspector-pause').click();
  // Pending marker while upstream is deciding; state not yet changed locally.
  await expect(page.getByTestId('pending-pause')).toBeVisible();
  // Authoritative projection arrives → PAUSED, Resume affordance appears.
  await expect(page.getByTestId('inspector-state')).toContainText('PAUSED');
  await expect(page.getByTestId('inspector-resume')).toBeEnabled();
});

test('send instruction lands as an upstream human activity, not local chat', async ({ page }) => {
  await open(page, 'normal');
  await openInspector(page, 't-draft');
  await page.getByTestId('instruct-input').fill('Focus the copy on technical users.');
  await page.getByTestId('instruct-send').click();
  await page.getByTestId('tab-activity').click();
  const entry = page.locator('.activity-list li.human', {
    hasText: 'Focus the copy on technical users.',
  });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('human');
});

test('capabilities from upstream gate the affordances exactly', async ({ page }) => {
  await open(page, 'normal');
  // t-build: forceReplan disabled by upstream even while intervening.
  await openInspector(page, 't-build');
  await expect(page.getByTestId('inspector-force-replan')).toBeDisabled();
  await expect(page.getByTestId('inspector-cancel')).toBeEnabled();
  // t-research: pause/cancel/instruct hidden by upstream (completed task).
  // No chips in ③ — the move goes through ②: Esc, select, enter.
  await page.keyboard.press('Escape');
  await openInspector(page, 't-research');
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Research');
  await expect(page.getByTestId('inspector-pause')).toHaveCount(0);
  await expect(page.getByTestId('inspector-cancel')).toHaveCount(0);
  await expect(page.getByTestId('instruct-form')).toHaveCount(0);
});

test('blocked task: upstream reason first, privileged action stays an entry point', async ({ page }) => {
  await open(page, 'blocked');
  await openInspector(page, 't-test');
  await expect(page.getByTestId('inspector-blocked')).toContainText(
    'Staging environment credentials expired (upstream policy hold)',
  );
  await page.getByTestId('inspector-cancel').click();
  await expect(page.getByTestId('privileged-note')).toContainText('nothing was executed');
});

test('drill-down entries: execution, deliverable, gate', async ({ page }) => {
  await open(page, 'attention');
  // Execution entry (upstream session link on t-build).
  await openInspector(page, 't-build');
  await expect(page.getByTestId('inspector-execution')).toContainText('Builder Session');
  await page.getByTestId('open-execution').click();
  await expect(page.getByTestId('execution-surface')).toBeVisible();
  await page.keyboard.press('Escape'); // execution's exit goes back to the workspace (②)
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  // Related tab of t-draft: gate + selecting a related task swaps content.
  await page.getByTestId('node-t-draft').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('tab-related').click();
  await expect(page.getByTestId('open-gate-g-publish')).toContainText('Publish?');
  await page.getByTestId('related-t-research').click();
  await expect(page.getByTestId('inspector-breadcrumb')).toHaveText('Ship Website / Research');
});

test('deliverable entry appears for producing task', async ({ page }) => {
  await open(page, 'normal');
  await openInspector(page, 't-research');
  await expect(page.getByTestId('open-deliverable-d-report')).toContainText('Research Report');
});

test('close behaviors: Esc returns ③→② with the selection intact; the gate ③ is reached through ②', async ({ page }) => {
  await open(page, 'attention');
  await openInspector(page, 't-draft');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-inspector')).toBeHidden();
  // ②: the canvas and the stage are back, selection kept.
  await expect(page.getByTestId('canvas-host')).toBeVisible();
  await expect(page.getByTestId('node-stage')).toHaveAttribute('data-node', 't-draft');
  // No chips in ③ any more — the gate's ③ opens from ② like any other node.
  await page.getByTestId('node-g-publish').dispatchEvent('click');
  await page.getByTestId('enter-approval').click();
  await expect(page.getByTestId('task-inspector')).toBeHidden();
  await expect(page.getByTestId('gate-surface')).toBeVisible();
});

test('stale: inspector announces the projection age on connection loss', async ({ page }) => {
  await open(page, 'normal');
  await openInspector(page, 't-build');
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { dropStream: () => void } }).__gunnflowDebug.dropStream();
  });
  await expect(page.getByTestId('inspector-stale')).toContainText('Stale · showing state from');
});
