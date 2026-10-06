import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/** The personal layer's files during e2e: a temporary directory, never the person's ~/.gunnflow. */
export const E2E_PERSONAL_DIR = join(tmpdir(), 'gunnflow-e2e-personal');

/**
 * The wiring directory during e2e: a temporary directory with no files, so scenarios see the built-in
 * default (the settings scenario writes 90-user.json there and removes it again).
 */
export const E2E_WIRING_DIR = join(tmpdir(), 'gunnflow-e2e-wiring');

/**
 * The Gunnflow home during e2e: a temporary directory, never the person's ~/.gunnflow — so a
 * developer's own config.json, wiring/ and prefs.json there cannot leak into (or be written by) the
 * suite. Created empty here; the BFF creates files inside it as scenarios need.
 */
export const E2E_HOME = join(tmpdir(), 'gunnflow-e2e-home');
mkdirSync(E2E_HOME, { recursive: true });

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // The fake BFF holds shared scenario state; tests must not race over it.
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: [
    {
      // Pin the simulator regardless of any local gunnflow.config.json (env
      // beats the file), so the suite stays hermetic on a machine whose dev
      // servers point at a real backend.
      command: 'pnpm --filter @gunnflow/bff dev',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      cwd: '../..',
      // Scenarios assert the built-in default wiring: the repo's wiring/ files stay out of e2e.
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        GUNNFLOW_UPSTREAM: 'fake',
        GUNNFLOW_WIRING_DIR: E2E_WIRING_DIR,
        GUNNFLOW_PERSONAL_DIR: E2E_PERSONAL_DIR,
      },
    },
    {
      command: 'pnpm --filter @gunnflow/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      cwd: '../..',
      env: { GUNNFLOW_HOME: E2E_HOME },
    },
    // The direct path: the simulator's direct-wire reference server (:8791), a BFF
    // on `direct` (:8797, preview :8798) and a web instance proxying to it (:5174).
    {
      command:
        'sh -c "pnpm --filter @gunnflow-testing/fake-contracts serve:direct & ' +
        'until curl -sf http://127.0.0.1:8791/nodes >/dev/null; do sleep 0.2; done; ' +
        'pnpm --filter @gunnflow/bff dev"',
      url: 'http://127.0.0.1:8797/api/health',
      reuseExistingServer: !process.env.CI,
      cwd: '../..',
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        GUNNFLOW_UPSTREAM: 'direct',
        GUNNFLOW_UPSTREAM_URL: 'http://127.0.0.1:8791',
        GUNNFLOW_BFF_PORT: '8797',
        GUNNFLOW_PREVIEW_PORT: '8798',
        GUNNFLOW_WEB_ORIGIN: 'http://127.0.0.1:5174',
        GUNNFLOW_WIRING_DIR: E2E_WIRING_DIR,
        GUNNFLOW_PERSONAL_DIR: E2E_PERSONAL_DIR,
      },
    },
    {
      command: 'pnpm --filter @gunnflow/web dev',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      cwd: '../..',
      env: { GUNNFLOW_HOME: E2E_HOME, GUNNFLOW_WEB_PORT: '5174', GUNNFLOW_BFF_PORT: '8797', VITE_PREVIEW_ORIGIN: 'http://127.0.0.1:8798' },
    },
  ],
});
