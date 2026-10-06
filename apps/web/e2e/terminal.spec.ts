// Live Terminal / Intervention (Screen #4) acceptance + performance.
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  const res = await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name } });
  expect(res.ok()).toBeTruthy();
}

async function openTerminal(page: Page, fixture = 'normal') {
  await loadFixture(page, fixture);
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('open-execution').click();
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-surface')).toBeVisible();
  await expect(page.getByTestId('pty-line').first()).toBeVisible();
}

test('A: the PTY renders verbatim; affordances come from capabilities alone', async ({ page }) => {
  await openTerminal(page);
  await expect(page.locator('[data-testid="pty-line"]', { hasText: 'pnpm test' }).first()).toBeVisible();
  // stderr channel is visually distinct but content is verbatim upstream.
  await expect(page.locator('.pty-line[data-channel="stderr"]').first()).toContainText('auth.spec.ts');
  // K: masked env from upstream, no raw secret anywhere.
  await expect(page.getByTestId('terminal-masked-env')).toContainText('API_KEY=••••••');
});

test('B+C+L: intervene stdin — pending echo → authoritative attributed line with audit marker', async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId('stdin-input').fill('pnpm test src/utils/format.test.ts');
  await page.getByTestId('stdin-send').click();
  // Local echo is visibly pending, not authoritative.
  await expect(page.getByTestId('pending-line')).toContainText('transmitting…');
  // Authoritative stream returns the operator line with the 👤 audit marker.
  const operatorLine = page.locator('.pty-line.operator', {
    hasText: 'pnpm test src/utils/format.test.ts',
  });
  await expect(operatorLine).toBeVisible();
  await expect(page.getByTestId('pending-line')).toHaveCount(0);
  await expect(operatorLine.getByTestId('operator-marker')).toHaveText('👤');
  // The runtime's own response follows as agent output.
  await expect(
    page.locator('[data-testid="pty-line"]', { hasText: '[fake runtime] ran:' }),
  ).toBeVisible();
  // Audit drill: the marker opens the raw chunk on the upstream-declared operator channel.
  await operatorLine.getByTestId('operator-marker').click();
  await expect(page.getByTestId('pty-raw')).toContainText('"channel": "operator"');
});

test('D: rejected stdin shows INPUT NOT CONFIRMED — never displayed as executed', async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId('stdin-input').fill('sudo reboot');
  await page.getByTestId('stdin-send').click();
  await expect(page.getByTestId('input-unconfirmed')).toContainText('Input not confirmed');
  await expect(page.getByTestId('input-unconfirmed')).toContainText('policy');
  // No authoritative line ever appeared for it.
  await expect(page.locator('.pty-line.operator', { hasText: 'sudo' })).toHaveCount(0);
});

test('E: pause → pausing via projection; paused session refuses stdin with a guard', async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId('terminal-pause').click();
  await expect(page.getByTestId('terminal-session-state')).toContainText('PAUSED');
  await expect(page.getByTestId('stdin-input')).toBeDisabled();
  await expect(page.getByTestId('stdin-guard')).toContainText('not running');
  await expect(page.getByTestId('terminal-resume')).toBeEnabled();
});

test('G: kill is never one-click — impact + required reason + confirm, then KILLED', async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId('terminal-kill').click();
  const confirm = page.getByTestId('kill-confirm');
  await expect(confirm).toContainText('stops the active runtime');
  await expect(page.getByTestId('kill-confirm-button')).toBeDisabled(); // reason required
  await page.getByTestId('kill-reason').fill('Runaway loop, burning budget');
  await page.getByTestId('kill-confirm-button').click();
  await expect(page.getByTestId('terminal-session-state')).toContainText('KILLED');
  // The kill lands as an attributed control line in the stream.
  await expect(
    page.locator('.pty-line[data-channel="control"]', { hasText: 'killed by fake-actor:local-dev' }),
  ).toBeVisible();
  await expect(page.getByTestId('stdin-input')).toBeDisabled();
});

test('H: restart/model swap stays a privileged entry (contract BLOCKED)', async ({ page }) => {
  await openTerminal(page);
  // s-184 restart capability is upstream-disabled; the entry renders but stays inert.
  await expect(page.getByTestId('terminal-restart')).toBeDisabled();
});

test('I: connection loss — LIVE removed, last confirmed timestamp, stdin off', async ({ page }) => {
  await openTerminal(page);
  await expect(page.getByTestId('stdin-input')).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { __gunnflowDebug: { dropStream: () => void } }).__gunnflowDebug.dropStream();
  });
  await expect(page.getByTestId('terminal-lost')).toHaveText('CONNECTION LOST');
  await expect(page.getByTestId('terminal-live')).toHaveCount(0);
  await expect(page.getByTestId('terminal-stale')).toContainText('Last confirmed output');
  await expect(page.getByTestId('terminal-stale')).toContainText('never invented');
  await expect(page.getByTestId('stdin-input')).toBeDisabled();
  await expect(page.getByTestId('stdin-guard')).toContainText('cannot be confirmed');
});

test('search highlights matching output, observe-allowed', async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId('terminal-search').fill('failed');
  await expect(page.locator('.pty-line.match').first()).toContainText('1 failed');
});

test('performance: 10k-line PTY stays virtualized; typing stays enabled during bursts (§44)', async ({ page }) => {
  await loadFixture(page, 'normal');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await page.getByTestId('enter-inspector').click();
  await page.getByTestId('open-execution').click();
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('pty-line').first()).toBeVisible();
  const big = await page.request.post('http://127.0.0.1:8787/api/_fake/pty-burst', {
    data: { sessionId: 's-184', count: 10_000 },
  });
  expect(big.ok()).toBeTruthy();
  await expect(page.getByTestId('stream-local-drop')).toContainText('LOCAL BUFFER DROP');
  // Virtualized: 10k retained lines, only a window of DOM rows.
  await expect(page.getByTestId('pty-line').last()).toContainText('[burst] output line');
  expect(await page.getByTestId('pty-line').count()).toBeLessThan(150);
  await expect(page.getByTestId('stdin-input')).toBeEnabled();
  await page.getByTestId('stdin-input').fill('echo still-responsive');
  await page.getByTestId('stdin-send').click();
  await expect(page.locator('.pty-line.operator', { hasText: 'still-responsive' })).toBeVisible();
});
