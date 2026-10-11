/**
 * Loaded first by playwright.isolated.config.ts (a side-effect import, so it runs before the base
 * config and ports.ts read the offset): every port +40000, every temporary directory its own.
 * The name is ports.ts's E2E_PORT_OFFSET_ENV, spelled out: importing ports.ts here would read it too early.
 */
process.env.GUNNFLOW_E2E_PORT_OFFSET = '40000';
