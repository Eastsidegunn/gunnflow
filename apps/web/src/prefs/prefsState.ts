/**
 * Machine-local preferences: ergonomics of this person on this machine (zoom
 * feel, semantic-zoom threshold, default lens). Not wiring config (no
 * workspace vocabulary), not personal notes (no content) — and never sent
 * upstream. Persisted by the BFF at ~/.gunnflow/prefs.json; the defaults here
 * are engine presets (data), used whenever the file is absent or a field is
 * out of range.
 */
import { createSignal } from 'solid-js';
import { sanitizeKeys } from '../state/keybindings.js';

export interface Prefs {
  /** Wheel zoom factor per notch (1.01..2). */
  zoomSensitivity: number;
  /** Camera zoom at which node detail lines appear (semantic zoom). */
  detailZoom: number;
  /** Lens selected at boot: `all`, `plan`, or a config lens id. */
  defaultLens: string;
  /** Keybinding overrides by binding name; a name absent here keeps its engine default. */
  keys: Record<string, string>;
  /** Pack unrelated children inside containers into rows toward the layout aspect (off: top-level packing only). */
  packContainers: boolean;
}

export const DEFAULT_PREFS: Prefs = { zoomSensitivity: 1.1, detailZoom: 0.5, defaultLens: 'all', keys: {}, packContainers: true };

/** Clamp and fall back per field — a broken file never breaks the cockpit. */
export function sanitizePrefs(raw: unknown): Prefs {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    zoomSensitivity: num(o.zoomSensitivity, DEFAULT_PREFS.zoomSensitivity, 1.01, 2),
    detailZoom: num(o.detailZoom, DEFAULT_PREFS.detailZoom, 0, 4),
    defaultLens: typeof o.defaultLens === 'string' && o.defaultLens !== '' ? o.defaultLens : DEFAULT_PREFS.defaultLens,
    keys: sanitizeKeys(o.keys),
    packContainers: typeof o.packContainers === 'boolean' ? o.packContainers : DEFAULT_PREFS.packContainers,
  };
}

export function createPrefsState() {
  const [prefs, setPrefs] = createSignal<Prefs>(DEFAULT_PREFS);
  const [saveProblem, setSaveProblem] = createSignal<string | null>(null);
  return {
    prefs,
    saveProblem,
    /** Loads once at boot; a missing store or failed fetch keeps the defaults. */
    async load(): Promise<Prefs> {
      try {
        const res = await fetch('/api/prefs', { cache: 'no-store' });
        if (!res.ok) return prefs();
        const body = (await res.json().catch(() => null)) as { prefs?: unknown } | null;
        if (body && body.prefs != null) setPrefs(sanitizePrefs(body.prefs));
      } catch {
        /* defaults stand */
      }
      return prefs();
    },
    /** Applies at once and persists to this machine. */
    async save(next: Partial<Prefs>): Promise<void> {
      setPrefs(sanitizePrefs({ ...prefs(), ...next }));
      setSaveProblem(null);
      try {
        const res = await fetch('/api/prefs', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(prefs()),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
          setSaveProblem(typeof body?.reason === 'string' ? body.reason : `prefs store answered ${res.status}`);
        }
      } catch (err) {
        setSaveProblem(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export type PrefsState = ReturnType<typeof createPrefsState>;
