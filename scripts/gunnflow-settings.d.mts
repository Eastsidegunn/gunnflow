// Types for scripts/gunnflow-settings.mjs (used by apps/bff and apps/web/vite.config.ts).
type Env = Readonly<Record<string, string | undefined>>;

export const UPSTREAM_CHOICES: readonly ['fake', 'direct'];
export const CONFIG_ENV: {
  readonly upstream: 'GUNNFLOW_UPSTREAM';
  readonly url: 'GUNNFLOW_UPSTREAM_URL';
  readonly webOrigin: 'GUNNFLOW_WEB_ORIGIN';
  readonly previewOrigin: 'GUNNFLOW_PREVIEW_ORIGIN';
  readonly wiringDir: 'GUNNFLOW_WIRING_DIR';
  readonly personalDir: 'GUNNFLOW_PERSONAL_DIR';
};

export interface GunnflowConfig {
  upstream?: string;
  url?: string;
  webOrigin?: string;
  previewOrigin?: string;
  /** Wiring config directory; relative paths resolve against the repo root. Default: $GUNNFLOW_HOME/wiring if present, else <repo>/wiring. */
  wiringDir?: string;
  /** Personal-layer directory (local notes, never sent upstream); default $GUNNFLOW_HOME/personal. */
  personalDir?: string;
}

export type ConfigSource = 'env' | 'repo' | 'home';
export interface ConfigLocation {
  path: string;
  source: ConfigSource;
}

export function gunnflowHome(env?: Env, userHome?: string): string;
export function resolveConfigFile(opts: {
  env: Env;
  repoRoot: string;
  home: string;
  exists?: (path: string) => boolean;
}): ConfigLocation | undefined;
export function resolveWiringDir(opts: {
  explicit: string | undefined;
  repoRoot: string;
  home: string;
  isDirectory?: (path: string) => boolean;
}): string;
export function parseConfig(raw: unknown): GunnflowConfig;
export function loadConfigFile(path: string, opts?: { required?: boolean; shown?: string }): GunnflowConfig;
export function displayPath(path: string, opts: { repoRoot: string; env?: Env; userHome?: string }): string;
export function loadUserConfig(opts: { env?: Env; repoRoot: string; userHome?: string }): {
  home: string;
  location: (ConfigLocation & { shown: string }) | undefined;
  config: GunnflowConfig;
};
