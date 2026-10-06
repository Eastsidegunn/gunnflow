/**
 * The config file (optional): everything needed to connect in one file.
 * Environment variables, when set, win over the file. Which file applies is
 * resolved in scripts/gunnflow-settings.mjs: GUNNFLOW_CONFIG > `<repo>/gunnflow.config.json` >
 * `$GUNNFLOW_HOME/config.json` > none.
 *
 *   { "upstream": "direct" | "fake",
 *     "url": "http://…", "webOrigin": "http://…", "previewOrigin": "http://…",
 *     "wiringDir": "wiring", "personalDir": "…" }
 */
import { fileURLToPath } from 'node:url';
import { CONFIG_ENV, gunnflowHome, resolveWiringDir, type GunnflowConfig } from '../../../scripts/gunnflow-settings.mjs';

// The schema and its validation are shared with the web build and the scripts.
export { CONFIG_ENV, loadConfigFile, parseConfig, type GunnflowConfig } from '../../../scripts/gunnflow-settings.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_WIRING_DIR = 'wiring';

/** The wiring directory for the effective settings, absolute (resolution order in scripts/gunnflow-settings.mjs). */
export function wiringDirOf(settings: Readonly<Record<string, string | undefined>>, home: string = gunnflowHome()): string {
  return resolveWiringDir({ explicit: settings[CONFIG_ENV.wiringDir], repoRoot: REPO_ROOT, home });
}

/** The effective settings as environment-shaped keys: env values win over the file. */
export function resolveSettings(
  env: Readonly<Record<string, string | undefined>>,
  config: GunnflowConfig,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, name] of Object.entries(CONFIG_ENV) as Array<[keyof GunnflowConfig, string]>) {
    out[name] = env[name] ?? config[key];
  }
  return out;
}
