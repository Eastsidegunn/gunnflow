// GF-T3: the panels that share the screen's edges never cover one another. The terminal dock takes
// the bottom (full width, height by its handle), the right dock holds the stage or the decision inbox,
// the toggles share the toolbar, and toasts and the notifications list stand clear of open docks.
import { expect, test, type Locator, type Page } from '@playwright/test';

type Box = { x: number; y: number; width: number; height: number };

async function loadFixture(page: Page, name: string) {
  // Through the web origin's /api proxy, so the spec runs against whichever BFF the config wires.
  const res = await page.request.post('/api/_fake/fixture', { data: { name } });
  expect(res.ok()).toBeTruthy();
}

/** Every intent comes back refused, so a send raises a toast. */
async function refuseIntents(page: Page) {
  await page.route('**/api/intent', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: false, reason: 'refused for the layout check' }) }),
  );
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;

/** Settled boxes (entrance animations done), each inside the window and on top at its centre. */
async function boxes(page: Page, parts: Record<string, Locator>): Promise<Record<string, Box>> {
  await page.waitForTimeout(400);
  const vp = page.viewportSize()!;
  const out: Record<string, Box> = {};
  for (const [name, loc] of Object.entries(parts)) {
    await expect(loc, name).toBeVisible();
    const b = (await loc.boundingBox())!;
    expect(b.x, `${name} left`).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(vp.width + 0.5);
    expect(b.y + b.height, `${name} bottom`).toBeLessThanOrEqual(vp.height + 0.5);
    const onTop = await loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
      return hit !== null && el.contains(hit);
    });
    expect(onTop, `${name} is not covered`).toBe(true);
    out[name] = b;
  }
  return out;
}

function expectApart(found: Record<string, Box>) {
  const names = Object.keys(found);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      expect(overlaps(found[names[i]!]!, found[names[j]!]!), `${names[i]} overlaps ${names[j]}`).toBe(false);
}

async function openShell(page: Page) {
  await page.getByTestId('terminals-toggle').click();
  await page.getByTestId('term-folder').fill('/work');
  await page.getByTestId('term-new-shell').click();
  await expect(page.getByTestId('term-screen')).toHaveAttribute('data-status', 'live');
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  test(`terminals, decision inbox, a toast and the notifications list stand apart at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await loadFixture(page, 'blocked');
    await refuseIntents(page);
    await page.goto('/');
    await expect(page.getByTestId('live-dot')).toBeVisible();
    await openShell(page);
    await page.getByTestId('decision-inbox-toggle').click();
    await expect(page.getByTestId('decision-inbox')).toBeVisible();
    await page.getByTestId('generic-send-gate.approve').click();
    await expect(page.getByTestId('relay-error')).toBeVisible();
    await page.getByTestId('notifications-toggle').click();
    const found = await boxes(page, {
      terminalsToggle: page.getByTestId('terminals-toggle'),
      inboxToggle: page.getByTestId('decision-inbox-toggle'),
      notificationsToggle: page.getByTestId('notifications-toggle'),
      terminalDock: page.getByTestId('term-panel'),
      inbox: page.getByTestId('decision-inbox'),
      toast: page.getByTestId('relay-error'),
      notifications: page.getByTestId('notifications-panel'),
      statusLine: page.locator('.status-strip'),
    });
    expectApart(found);
    // The status line's controls still take clicks with everything open.
    await page.getByTestId('activity-toggle').click({ trial: true, timeout: 2000 });
  });
}

test('the node stage stops above the terminal dock; the dock resizes by its handle', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loadFixture(page, 'normal');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('terminals-toggle').click();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  await expect(page.getByTestId('node-stage')).toBeVisible();
  const dock = page.getByTestId('term-panel');
  expectApart(await boxes(page, { stage: page.getByTestId('node-stage'), terminalDock: dock, statusLine: page.locator('.status-strip') }));

  // Drag the handle up: the dock grows, the stage gives way, still apart.
  const before = (await dock.boundingBox())!;
  const handle = (await page.getByTestId('term-dock-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())!.height).toBeGreaterThan(before.height + 90);
  expectApart(await boxes(page, { stage: page.getByTestId('node-stage'), terminalDock: dock }));
  // And by keyboard on the same handle.
  const grown = (await dock.boundingBox())!.height;
  await page.getByTestId('term-dock-handle').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await dock.boundingBox())!.height).toBeLessThan(grown);
});

test('keys typed in the terminal stay the shell’s while the decision inbox is open', async ({ page }) => {
  await loadFixture(page, 'blocked');
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await openShell(page);
  await page.getByTestId('decision-inbox-toggle').click();
  const gateRow = page.getByTestId('inbox-row-g-publish');
  await expect(gateRow).toHaveAttribute('data-selected', 'yes');
  await page.getByTestId('term-screen').click();
  await page.keyboard.type('jk');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('term-screen').locator('.xterm-rows')).toContainText('$ jk');
  // Neither the inbox's next/previous nor its Esc acted.
  await expect(page.getByTestId('decision-inbox')).toBeVisible();
  await expect(gateRow).toHaveAttribute('data-selected', 'yes');
});
