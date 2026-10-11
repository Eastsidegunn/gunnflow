import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { SIMULATOR_WIRING, SIMULATOR_WIRING_FILE } from '@gunnflow-testing/fake-contracts';
import { BFF, DIRECT_BFF, DIRECT_PREVIEW, DIRECT_UPSTREAM, DIRECT_WEB, E2E_PORT_OFFSET, PREVIEW, WEB, port } from './e2e/ports.js';
import { IME_SERVERS } from './playwright.ime.config.js';
import { STRANGE_SERVERS } from './playwright.strange.config.js';

/**
 * Run as the isolated suite (playwright.isolated.config.ts: ports +40000): every server starts fresh
 * and every temporary directory below is its own, so a live cockpit and this suite never share state.
 */
const ISOLATED = E2E_PORT_OFFSET !== 0;
const tmp = (name: string): string => join(tmpdir(), ISOLATED ? `${name}-${E2E_PORT_OFFSET}` : name);

/** The personal layer's files during e2e: a temporary directory, never the person's ~/.gunnflow. */
export const E2E_PERSONAL_DIR = tmp('gunnflow-e2e-personal');

/**
 * The wiring directory during e2e: a temporary directory with no files, so scenarios see the built-in
 * default (the settings scenario writes 90-user.json there and removes it again).
 */
export const E2E_WIRING_DIR = tmp('gunnflow-e2e-wiring');

/**
 * The direct path's wiring directory: a backend on the direct wire brings its wiring as files, so the
 * simulator served over the wire gets its own wiring here (fake mode gets the same layer from the BFF).
 */
export const E2E_DIRECT_WIRING_DIR = tmp('gunnflow-e2e-direct-wiring');
mkdirSync(E2E_DIRECT_WIRING_DIR, { recursive: true });
writeFileSync(join(E2E_DIRECT_WIRING_DIR, SIMULATOR_WIRING_FILE), JSON.stringify(SIMULATOR_WIRING, null, 2));

/**
 * The Gunnflow home during e2e: a temporary directory, never the person's ~/.gunnflow — so a
 * developer's own config.json, wiring/ and prefs.json there cannot leak into (or be written by) the
 * suite. Created here with one seeded file (prefs.json, below); the BFF creates the rest as scenarios need.
 */
export const E2E_HOME = tmp('gunnflow-e2e-home');
mkdirSync(E2E_HOME, { recursive: true });
/**
 * The product lands on the Now list (prefs `landingView`, default `now`); the canvas scenarios
 * were written for the full view, so the e2e home's prefs open on `all`. The Now scenario sets
 * `now` itself through the same prefs store. Rewritten at each config load: every run starts here.
 */
writeFileSync(join(E2E_HOME, 'prefs.json'), JSON.stringify({ landingView: 'all' }, null, 2));

/** Reusing a running dev server is a convenience of the default suite only. */
const reuseExistingServer = !process.env.CI && !ISOLATED;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // The fake BFF holds shared scenario state; tests must not race over it.
  workers: 1,
  use: {
    baseURL: WEB,
    // The interface language follows the browser when nothing is stored: pin it so runs are deterministic.
    locale: 'en-US',
  },
  webServer: [
    {
      // Pin the simulator regardless of any local gunnflow.config.json (env
      // beats the file), so the suite stays hermetic on a machine whose dev
      // servers point at a real backend.
      command: 'pnpm --filter @gunnflow/bff dev',
      url: `${BFF}/api/health`,
      reuseExistingServer: false,
      cwd: '../..',
      // Scenarios assert the built-in default wiring: the repo's wiring/ files stay out of e2e.
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        GUNNFLOW_UPSTREAM: 'fake',
        GUNNFLOW_BFF_PORT: String(port(8787)),
        GUNNFLOW_PREVIEW_PORT: String(port(8788)),
        GUNNFLOW_WEB_ORIGIN: WEB,
        GUNNFLOW_WIRING_DIR: E2E_WIRING_DIR,
        GUNNFLOW_PERSONAL_DIR: E2E_PERSONAL_DIR,
      },
    },
    {
      command: 'pnpm --filter @gunnflow/web dev',
      url: WEB,
      reuseExistingServer,
      cwd: '../..',
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        GUNNFLOW_WEB_PORT: String(port(5173)),
        GUNNFLOW_BFF_PORT: String(port(8787)),
        VITE_PREVIEW_ORIGIN: PREVIEW,
      },
    },
    // The direct path: the simulator's direct-wire reference server (:8791), a BFF
    // on `direct` (:8797, preview :8798) and a web instance proxying to it (:5174).
    {
      command:
        'sh -c "pnpm --filter @gunnflow-testing/fake-contracts serve:direct & ' +
        `until curl -sf ${DIRECT_UPSTREAM}/nodes >/dev/null; do sleep 0.2; done; ` +
        'pnpm --filter @gunnflow/bff dev"',
      url: `${DIRECT_BFF}/api/health`,
      reuseExistingServer,
      cwd: '../..',
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        FAKE_DIRECT_PORT: String(port(8791)),
        GUNNFLOW_UPSTREAM: 'direct',
        GUNNFLOW_UPSTREAM_URL: DIRECT_UPSTREAM,
        GUNNFLOW_BFF_PORT: String(port(8797)),
        GUNNFLOW_PREVIEW_PORT: String(port(8798)),
        GUNNFLOW_WEB_ORIGIN: DIRECT_WEB,
        GUNNFLOW_WIRING_DIR: E2E_DIRECT_WIRING_DIR,
        GUNNFLOW_PERSONAL_DIR: E2E_PERSONAL_DIR,
      },
    },
    {
      command: 'pnpm --filter @gunnflow/web dev',
      url: DIRECT_WEB,
      reuseExistingServer,
      cwd: '../..',
      env: {
        GUNNFLOW_HOME: E2E_HOME,
        GUNNFLOW_WEB_PORT: String(port(5174)),
        GUNNFLOW_BFF_PORT: String(port(8797)),
        VITE_PREVIEW_ORIGIN: DIRECT_PREVIEW,
      },
    },
    // An unfamiliar backend (e2e/strange-backend.spec.ts): its own servers, ports and home.
    ...STRANGE_SERVERS,
    // Typing through an input method (e2e/terminal-ime.spec.ts): its own servers, ports and home.
    ...IME_SERVERS,
  ],
});
