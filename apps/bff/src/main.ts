/** Composition root: the only place the upstream (fake or direct) is chosen and wired. */
import { loadUpstream } from './composition.js';
import { DEFAULT_CONFIG_PATH, REPO_ROOT, loadConfigFile, resolveSettings, wiringDirOf } from './config.js';
import { DEFAULT_PERSONAL_DIR, workspaceKey } from './personalStore.js';
import { DEFAULT_PREFS_FILE } from './prefsStore.js';
import { join, resolve } from 'node:path';
import { buildServer } from './server.js';
import { DEFAULT_WEB_ORIGIN, buildPreviewServer } from './preview-server.js';

const refuse = (err: unknown): never => {
  console.error(`gunnflow bff refused to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
};
// One config file (optional) holds the connection; env values win over it.
const settings = (() => {
  try {
    return resolveSettings(process.env, loadConfigFile(process.env.GUNNFLOW_CONFIG ?? DEFAULT_CONFIG_PATH));
  } catch (err) {
    return refuse(err);
  }
})();
const loaded = await loadUpstream(settings).catch(refuse);
const { upstream, fake, label } = loaded;

// The personal layer lives next to nothing upstream: one local file per workspace.
const personalFile = join(
  settings.GUNNFLOW_PERSONAL_DIR ? resolve(REPO_ROOT, settings.GUNNFLOW_PERSONAL_DIR) : DEFAULT_PERSONAL_DIR,
  `${workspaceKey(label)}.json`,
);
// No mermaid renderer is built in: diagram surfaces state "unavailable" with the reason.
const app = buildServer({
  upstream,
  wiringDir: wiringDirOf(settings),
  upstreamLabel: label,
  personalFile,
  prefsFile: process.env.GUNNFLOW_PREFS_FILE ?? DEFAULT_PREFS_FILE,
  loadFixture: fake ? (name) => fake.loadFixture(name as never) : undefined,
  burstExecution: fake ? (taskId, count) => fake.burstExecution(taskId, count) : undefined,
  burstPty: fake ? (sessionId, count) => fake.burstPty(sessionId, count) : undefined,
  gapStream: fake ? (sessionId, count) => fake.gapStream(sessionId, count) : undefined,
});
// The isolated origin serves artifact snapshots the upstream can provide.
const preview = buildPreviewServer(
  {
    async artifactSnapshot(artifactId, digest) {
      const snap = await upstream.artifactSnapshot?.(artifactId, digest);
      return snap ? { mediaType: snap.mediaType, bytes: Buffer.from(snap.bytesBase64, 'base64') } : undefined;
    },
  },
  {
    webOrigin: settings.GUNNFLOW_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
  },
);

const BFF_PORT = Number(process.env.GUNNFLOW_BFF_PORT ?? 8787);
const previewOriginPort = settings.GUNNFLOW_PREVIEW_ORIGIN ? new URL(settings.GUNNFLOW_PREVIEW_ORIGIN).port : '';
const PREVIEW_PORT = Number(process.env.GUNNFLOW_PREVIEW_PORT ?? (previewOriginPort || 8788));

// Loopback by default: the BFF is unauthenticated (SECURITY.md). Changing the bind host exposes it.
const BIND_HOST = process.env.GUNNFLOW_BIND_HOST || '127.0.0.1';
const shownHost = BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST;

await app.listen({ port: BFF_PORT, host: BIND_HOST });
await preview.listen({ port: PREVIEW_PORT, host: BIND_HOST });
console.log(`gunnflow bff    http://${shownHost}:${BFF_PORT}  (upstream: ${label})`);
console.log(`preview origin  http://${shownHost}:${PREVIEW_PORT}  (isolated, strict CSP)`);
console.log(`personal layer  ${personalFile}  (local only)`);
