/**
 * Wiring config loading. The built-in default is the floor; every config file
 * the BFF carries from the wiring directory is validated on its own and, if it
 * passes, layered on in file-name order. The merged result is validated once
 * more as a whole. Nothing fails silently: rejected files and a rejected merge
 * are kept with their reasons for the debug summary.
 */
import { createSignal } from 'solid-js';
import { WIRING_SCHEMA_VERSION, validateWiringConfig, type WiringConfig } from '@gunnflow/contract/wiring';
import { DEFAULT_WIRING } from './defaultWiring.js';

export const EMPTY_WIRING: WiringConfig = { version: WIRING_SCHEMA_VERSION };

/** One file as the BFF carries it: parsed JSON, or a transport error. */
export type WiringFileEntry = { file: string; config: unknown } | { file: string; error: string };

export interface WiringFileReport {
  loaded: string[];
  rejected: { file: string; reasons: string[] }[];
}

export interface LoadedWiring {
  config: WiringConfig;
  /** Validation problems of the config that was offered (or of the merge); empty when it was used. */
  problems: string[];
  files: WiringFileReport;
  /** The accepted files, in merge order (for provenance: which layer set what). */
  layers: { file: string; config: WiringConfig }[];
}

const NO_FILES: WiringFileReport = { loaded: [], rejected: [] };

export function loadWiring(offered: unknown = DEFAULT_WIRING, log: (msg: string) => void = console.error): LoadedWiring {
  const result = validateWiringConfig(offered);
  if (result.ok) return { config: result.config, problems: [], files: NO_FILES, layers: [] };
  log(`wiring config rejected; using engine defaults:\n  ${result.problems.join('\n  ')}`);
  return { config: EMPTY_WIRING, problems: result.problems, files: NO_FILES, layers: [] };
}

/**
 * Layers `over` onto `base`. Tables (render, relations, viewers, kinds)
 * override per key — a later file's entry replaces the whole entry, new keys
 * are added. Attention merges per cause — a later rule for a known cause
 * replaces it in place, a new cause is appended — so "first match wins"
 * keeps its meaning. The version is the base's (each file is checked for
 * compatibility on its own).
 */
export function mergeWiring(base: WiringConfig, over: WiringConfig): WiringConfig {
  const table = <T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined) =>
    a || b ? { ...(a ?? {}), ...(b ?? {}) } : undefined;
  const attention = [...(base.attention ?? [])];
  for (const rule of over.attention ?? []) {
    const at = attention.findIndex((r) => r.match.cause === rule.match.cause);
    if (at >= 0) attention[at] = rule;
    else attention.push(rule);
  }
  // Lenses merge like attention: a later file's lens of a known id replaces it in place, a new id is appended.
  const lenses = [...(base.lenses ?? [])];
  for (const lens of over.lenses ?? []) {
    const at = lenses.findIndex((l) => l.id === lens.id);
    if (at >= 0) lenses[at] = lens;
    else lenses.push(lens);
  }
  const merged: WiringConfig = { version: base.version };
  const render = table(base.render, over.render);
  const relations = table(base.relations, over.relations);
  const viewers = table(base.viewers, over.viewers);
  const kinds = table(base.kinds, over.kinds);
  if (render) merged.render = render;
  if (relations) merged.relations = relations;
  if (base.attention || over.attention) merged.attention = attention;
  if (viewers) merged.viewers = viewers;
  if (kinds) merged.kinds = kinds;
  if (base.lenses || over.lenses) merged.lenses = lenses;
  // Detail emphasis replaces as a whole: a later file states the full list.
  const detail = over.detail ?? base.detail;
  if (detail) merged.detail = detail;
  return merged;
}

export function loadWiringFiles(
  entries: readonly WiringFileEntry[],
  base: WiringConfig = DEFAULT_WIRING,
  log: (msg: string) => void = console.error,
): LoadedWiring {
  const files: WiringFileReport = { loaded: [], rejected: [] };
  const layers: { file: string; config: WiringConfig }[] = [];
  let merged = base;
  for (const entry of entries) {
    if ('error' in entry) {
      files.rejected.push({ file: entry.file, reasons: [entry.error] });
      continue;
    }
    const result = validateWiringConfig(entry.config);
    if (!result.ok) {
      files.rejected.push({ file: entry.file, reasons: result.problems });
      continue;
    }
    merged = mergeWiring(merged, result.config);
    files.loaded.push(entry.file);
    layers.push({ file: entry.file, config: result.config });
  }
  for (const r of files.rejected) log(`wiring file ${r.file} rejected (skipped):\n  ${r.reasons.join('\n  ')}`);
  const whole = validateWiringConfig(merged);
  if (whole.ok) return { config: whole.config, problems: [], files, layers };
  log(`merged wiring config rejected; using the default:\n  ${whole.problems.join('\n  ')}`);
  return { config: base, problems: whole.problems, files, layers: [] };
}

/** The workspace's wiring: the default until the directory's files arrive. */
export function createWiringState() {
  const [loaded, setLoaded] = createSignal<LoadedWiring>(loadWiring());
  return {
    get config() {
      return loaded().config;
    },
    get problems() {
      return loaded().problems;
    },
    get files() {
      return loaded().files;
    },
    get layers() {
      return loaded().layers;
    },
    /** Fetches the directory's files; a failed fetch keeps the default. */
    async refresh(fetchFiles: () => Promise<readonly WiringFileEntry[]>) {
      let entries: readonly WiringFileEntry[];
      try {
        entries = await fetchFiles();
      } catch {
        return;
      }
      // Applied even when the list is empty: removing every file returns to the default.
      setLoaded(loadWiringFiles(entries));
    },
  };
}

export async function fetchWiringFiles(): Promise<readonly WiringFileEntry[]> {
  const res = await fetch('/api/wiring');
  if (!res.ok) throw new Error(`wiring fetch failed (${res.status})`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('wiring fetch: not a list');
  return body as WiringFileEntry[];
}
