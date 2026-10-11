/**
 * Minimal, dependency-free i18n for the cockpit's own strings.
 *
 * Only what the engine authors is translated. Backend data and wiring-config
 * vocabulary (node labels, kinds, states, relations, actions, causes, lens and
 * group names) are shown as received, in whatever language they arrive.
 *
 * Locale: a choice stored on this device (localStorage) → else the browser's
 * language (`ko*` → ko, anything else → en) → else en. Switching is a local
 * signal change: everything reading `t` re-renders, nothing is sent anywhere.
 */
import { createSignal } from 'solid-js';
import { en, type MessageKey, type Messages } from './en.js';
import { ko } from './ko.js';

export type { MessageKey } from './en.js';
export type Locale = 'en' | 'ko';
export const LOCALES: readonly Locale[] = ['en', 'ko'];
/** How each locale names itself in the switch. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'EN', ko: '한국어' };
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'gunnflow.locale';

export const CATALOGS: Record<Locale, Messages> = { en, ko };

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Maps a BCP 47 tag to a supported locale, or null: `ko`, `ko-KR` → ko; `en*` → en. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  return primary === 'ko' ? 'ko' : 'en';
}

/** Resolution order: stored choice → navigator language → en. */
export function resolveLocale(stored: string | null | undefined, navigatorLanguage: string | null | undefined): Locale {
  if (isLocale(stored)) return stored;
  return matchLocale(navigatorLanguage) ?? DEFAULT_LOCALE;
}

/** The browser's storage; none outside a browser (unit tests run in node). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function initialLocale(): Locale {
  const nav = typeof navigator !== 'undefined' ? navigator.language : undefined;
  return resolveLocale(readStored(), nav);
}

const [locale, setLocaleSignal] = createSignal<Locale>(initialLocale());
export { locale };

function reflectOnDocument(l: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}
reflectOnDocument(locale());

/** Switches the interface language at once; `persist` stores the choice on this device only. */
export function setLocale(l: Locale, opts: { persist?: boolean } = {}): void {
  setLocaleSignal(l);
  reflectOnDocument(l);
  if (opts.persist === false) return;
  try {
    storage()?.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
}

/**
 * A message kept in state: a catalog key with its parameters (cockpit-authored —
 * translated whenever it is read, so it follows a locale switch), or a raw string
 * received from elsewhere (an upstream reason, a contract validator problem),
 * shown verbatim in every locale.
 */
export type Msg = { readonly key: MessageKey; readonly params?: Params; readonly count?: number } | { readonly raw: string };
/** A parameter: plain text or a number, or a nested message (translated with its parent). */
export type Param = string | number | Msg;
export type Params = Readonly<Record<string, Param>>;

/** A cockpit-authored message descriptor (translated at read time). */
export function msg(key: MessageKey, params?: Params): Msg {
  return params ? { key, params } : { key };
}
/** A count-form descriptor: resolves to `{base}.one` / `{base}.other` at read time. */
export function msgN(base: CountMessage, count: number, params?: Params): Msg {
  return { key: `${base}.other` as MessageKey, count, params: { count, ...params } };
}
/** A received string, kept verbatim. */
export function raw(text: string): Msg {
  return { raw: text };
}
export function isMsg(v: unknown): v is Msg {
  return typeof v === 'object' && v !== null && ('raw' in v || 'key' in v);
}

function render(l: Locale, m: Msg): string {
  if ('raw' in m) return m.raw;
  const key = m.count === undefined ? m.key : (m.key.replace(/\.other$/, m.count === 1 ? '.one' : '.other') as MessageKey);
  return translate(l, key, m.params);
}

function interpolate(l: Locale, template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    if (!(name in params)) return m;
    const v = params[name]!;
    return isMsg(v) ? render(l, v) : String(v);
  });
}

/** Looks a key up in a given locale; a key missing there falls back to en, then to the key itself. */
export function translate(l: Locale, key: MessageKey, params?: Params): string {
  const own = (CATALOGS[l] as Record<string, string | undefined>)[key];
  const template = own ?? (en as Record<string, string | undefined>)[key] ?? key;
  return interpolate(l, template, params);
}

/** The current locale's text for `key` (reactive: reading it inside a tracked scope re-runs on switch). */
export function t(key: MessageKey, params?: Params): string {
  return translate(locale(), key, params);
}

/** A stored message as text in the current locale (reactive, like `t`). */
export function tm(m: Msg): string;
export function tm(m: Msg | null | undefined): string | null;
export function tm(m: Msg | null | undefined): string | null {
  return m ? render(locale(), m) : null;
}

type CountKey<K> = K extends `${infer B}.other` ? (`${B}.one` extends MessageKey ? B : never) : never;
/** A key family with `.one` and `.other` forms. */
export type CountMessage = CountKey<MessageKey>;

/** Count form: `{base}.one` when count is 1, else `{base}.other`; `{count}` is passed in. */
export function tn(base: CountMessage, count: number, params?: Params): string {
  return tm(msgN(base, count, params));
}

/** An error whose message is a catalog descriptor: `.msg` stays translatable after it is caught and stored. */
export class MsgError extends Error {
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LOCALE, msg));
    this.name = 'MsgError';
  }
}

/** What a caught error says, as a message: a MsgError keeps its descriptor; anything else is shown verbatim. */
export function msgOf(err: unknown): Msg {
  if (err instanceof MsgError) return err.msg;
  return raw(err instanceof Error ? err.message : String(err));
}
