/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { loadUserConfig } from '../../scripts/gunnflow-settings.mjs';

/**
 * The preview origin comes from env (VITE_PREVIEW_ORIGIN, GUNNFLOW_PREVIEW_ORIGIN)
 * or the config file the BFF uses (GUNNFLOW_CONFIG > the repo's
 * gunnflow.config.json > $GUNNFLOW_HOME/config.json), loaded and validated by the
 * same shared code: an invalid file stops the dev server or build with the reason,
 * never a silent fallback. Unit tests (Vitest) read no config file at all — this
 * config is evaluated before any test setup could isolate the home.
 */
function configuredPreviewOrigin(): string | undefined {
  const fromEnv = process.env.VITE_PREVIEW_ORIGIN ?? process.env.GUNNFLOW_PREVIEW_ORIGIN;
  if (process.env.VITEST) return fromEnv;
  // Validate the config file even when an env var supplies the value: an invalid
  // file must stop the dev server or build, never be bypassed.
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const fromFile = loadUserConfig({ repoRoot }).config.previewOrigin;
  return fromEnv ?? fromFile;
}
const previewOrigin = configuredPreviewOrigin();

/** Bind host shared with the BFF (GUNNFLOW_BIND_HOST); loopback by default. */
const bindHost = process.env.GUNNFLOW_BIND_HOST || '127.0.0.1';
/** Where the dev proxy reaches the BFF: a wildcard bind is still reachable on loopback. */
const bffHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost.includes(':') ? `[${bindHost}]` : bindHost;

export default defineConfig({
  plugins: [solid()],
  ...(previewOrigin ? { define: { 'import.meta.env.VITE_PREVIEW_ORIGIN': JSON.stringify(previewOrigin) } } : {}),
  server: {
    host: bindHost,
    port: Number(process.env.GUNNFLOW_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://${bffHost}:${process.env.GUNNFLOW_BFF_PORT ?? 8787}`,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // GUNNFLOW_HOME in a fresh temp dir: no test reaches a developer's real ~/.gunnflow.
    setupFiles: ['test/setup-home.ts'],
  },
});
