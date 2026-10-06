/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * The preview origin comes from env (VITE_PREVIEW_ORIGIN, GUNNFLOW_PREVIEW_ORIGIN)
 * or the repo's gunnflow.config.json. The BFF validates that file; the web only
 * reads its previewOrigin.
 */
function configuredPreviewOrigin(): string | undefined {
  const fromEnv = process.env.VITE_PREVIEW_ORIGIN ?? process.env.GUNNFLOW_PREVIEW_ORIGIN;
  if (fromEnv) return fromEnv;
  const path = process.env.GUNNFLOW_CONFIG ?? fileURLToPath(new URL('../../gunnflow.config.json', import.meta.url));
  if (!existsSync(path)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { previewOrigin?: unknown }).previewOrigin;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
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
  },
});
