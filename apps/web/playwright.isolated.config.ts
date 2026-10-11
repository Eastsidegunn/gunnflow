/**
 * The full suite, clear of a live cockpit: run this while the live servers (web :5173, BFF :8787,
 * preview :8788) are up —
 *
 *   npx playwright test -c playwright.isolated.config.ts
 *
 * Every server of the main suite moves +40000 (web 45173/45174, BFF 48787/48797, preview
 * 48788/48798, the direct-wire reference server 48791), each started fresh (no reuse of a running
 * server) with its own temporary home, wiring and personal directories. The unfamiliar-backend and
 * input-method servers already sit on their own ports (2xxxx, 3xxxx).
 */
import './e2e/isolated-env.js';
export { default } from './playwright.config.js';
