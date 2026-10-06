/**
 * Keybindings: engine code knows binding NAMES; the key a name resolves to is
 * a machine-local preference (prefs.keys — 0 bytes upstream). No key literal
 * at a use site: every lookup goes through resolveKey. Pure functions so the
 * resolution and matching are testable without a DOM.
 */

export const KEYBINDINGS = [
  { name: 'open-decision-inbox', label: '결정함 열기/닫기' },
  { name: 'inbox-next', label: '결정함 다음 항목' },
  { name: 'inbox-prev', label: '결정함 이전 항목' },
] as const;

export type BindingName = (typeof KEYBINDINGS)[number]['name'];

/** Engine default keys — a preset, overridable per machine in prefs. */
export const DEFAULT_KEYS: Record<BindingName, string> = {
  'open-decision-inbox': 'd',
  'inbox-next': 'j',
  'inbox-prev': 'k',
};

/** A bindable key: one printable character (stored lowercase, matched case-insensitively). */
export function isBindableKey(v: unknown): v is string {
  return typeof v === 'string' && [...v].length === 1 && v.trim().length === 1;
}

const KEYS_MAX = 64;

/** Keep only well-formed entries; unknown names pass through (future bindings keep their keys). */
export function sanitizeKeys(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= KEYS_MAX) break;
    if (name !== '' && isBindableKey(key)) out[name] = key.toLowerCase();
  }
  return out;
}

/** The key a binding name resolves to: the machine's choice, else the engine default. */
export function resolveKey(keys: Record<string, string> | undefined, name: BindingName): string {
  const k = keys?.[name];
  return isBindableKey(k) ? k.toLowerCase() : DEFAULT_KEYS[name];
}

/** The other binding already resolving to this key, if any — assignment must refuse it. */
export function duplicateOf(keys: Record<string, string> | undefined, name: BindingName, key: string): BindingName | null {
  if (!isBindableKey(key)) return null;
  const k = key.toLowerCase();
  for (const b of KEYBINDINGS) {
    if (b.name !== name && resolveKey(keys, b.name) === k) return b.name;
  }
  return null;
}

/** Plain-key match: no modifiers (a chord is never a plain binding), case-insensitive. */
export function matchesKey(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  key: string,
): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === key.toLowerCase();
}

/** Where plain-key bindings must stay silent: anything that takes typed text or activates on keys. */
export function isTypingTag(tagName: string | undefined, contentEditable?: string): boolean {
  const t = (tagName ?? '').toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select' || contentEditable === 'true';
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(el && isTypingTag(el.tagName, el.isContentEditable ? 'true' : undefined));
}
