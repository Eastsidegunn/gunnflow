// G4b: interpreted artifacts render only on the isolated origin, from digest-verified bytes.
import { expect, test } from '@playwright/test';

test('an HTML artifact opens in a sandboxed iframe on the isolated origin, pinned to its digest', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  const frame = page.getByTestId('generic-viewer-isolated-art-build-report');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('data-grade', 'claim');
  expect(await frame.getAttribute('src')).toMatch(/^http:\/\/127\.0\.0\.1:8788\/artifact\/art-build-report\/[0-9a-f]{64}$/);
  await expect(page.frameLocator('[data-testid="generic-viewer-isolated-art-build-report"]').locator('h1')).toHaveText('Build report');
  // The post-load re-check (CORS-limited to the web origin) confirmed the digest address.
  await expect(frame).toHaveAttribute('data-status', 'confirmed');
});

test('a mermaid artifact: no renderer is built in — explicitly unavailable, the source shown as text', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-research').dispatchEvent('click');
  const un = page.getByTestId('generic-viewer-mermaid-art-data-model-unavailable');
  await expect(un).toBeVisible();
  await expect(un).toContainText('Renderer unavailable');
  // Never an empty frame: the verified source itself is readable as plain text.
  await expect(un).toContainText(/erDiagram|flowchart/);
});

test('an Excalidraw scene draws in the isolated read-only viewer and reports back before it counts', async ({ page }) => {
  await page.request.post('http://127.0.0.1:8787/api/_fake/fixture', { data: { name: 'normal' } });
  await page.goto('/');
  await expect(page.getByTestId('live-dot')).toBeVisible();
  await page.getByTestId('node-t-build').dispatchEvent('click');
  const frame = page.getByTestId('generic-viewer-scene-art-release-sketch');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('data-status', 'confirmed', { timeout: 20_000 });
  await expect(page.frameLocator('[data-testid="generic-viewer-scene-art-release-sketch"]').locator('#content svg')).toBeVisible();
});
