// GF-T1: a backend terminal in the cockpit, used like a local one (simulator echo shell).
import { expect, test, type Page } from '@playwright/test';

async function loadFixture(page: Page, name: string) {
  // Through the web origin's /api proxy, so the spec runs against whichever BFF the config wires.
  const res = await page.request.post('/api/_fake/fixture', { data: { name } });
  expect(res.ok()).toBeTruthy();
}

const screen = (page: Page) => page.getByTestId('term-screen');

test('a new shell: open the panel, type, see the echo; reconnect starts from the snapshot', async ({ page }) => {
  await loadFixture(page, 'normal');
  await page.goto('/');
  await page.getByTestId('terminals-toggle').click();
  await expect(page.getByTestId('term-row-term-build')).toBeVisible();
  await page.getByTestId('term-folder').fill('/work');
  await page.getByTestId('term-new-shell').click();
  await expect(screen(page)).toHaveAttribute('data-status', 'live');
  await expect(screen(page).locator('.xterm-rows')).toContainText('echo shell in /work');
  await screen(page).click();
  await page.keyboard.type('hello there');
  await page.keyboard.press('Enter');
  await expect(screen(page).locator('.xterm-rows')).toContainText('$ hello there');
  await expect.poll(async () => (await screen(page).locator('.xterm-rows').innerText()).split('hello there').length - 1).toBe(2);
  // Esc goes to the shell, not to the cockpit: the panel stays.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('term-panel')).toBeVisible();
  // Leave and come back: the screen restarts from the backend's retained output.
  await page.getByTestId('term-back').click();
  await page.getByTestId('term-open-shell-1').click();
  await expect(screen(page).locator('.xterm-rows')).toContainText('$ hello there');
  // The shell's size follows the panel.
  await screen(page).click();
  await page.keyboard.type('size');
  await page.keyboard.press('Enter');
  await expect(screen(page).locator('.xterm-rows')).toContainText(/\d+x\d+/);
  await page.getByTestId('term-end').click();
  await expect(page.getByTestId('term-list')).toBeVisible();
  await expect(page.getByTestId('term-row-shell-1')).toHaveCount(0);
});

test('a node bound to a terminal offers "Open terminal" in its stage', async ({ page }) => {
  await loadFixture(page, 'normal');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await page.getByTestId('stage-open-terminal-term-build').click();
  await expect(screen(page).locator('.xterm-rows')).toContainText('build console (simulated)');
  await screen(page).click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('term-status')).toHaveText('Exited (0)');
  await expect(page.getByTestId('term-end')).toHaveCount(0);
});
