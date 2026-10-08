/**
 * Exact-bytes copy box logic (wiring `detail.copyable`) — pure. The received
 * string is shown as it is, with the characters a reader cannot see given a
 * visible marker. The markers are display only: every token keeps its raw
 * characters, and joining the raws gives back the exact input, so what the
 * box shows and what the copy button writes are the same string. Making a
 * character visible is display fidelity — never a verdict on the text.
 */

export type CopyMarkClass = 'eol' | 'tab' | 'zero-width' | 'bidi' | 'control' | 'trailing-space';

export type CopyToken =
  /** Plain characters, shown as they are. */
  | { kind: 'text'; raw: string }
  /** One invisible character (or a trailing space) and the marker drawn for it. */
  | { kind: 'mark'; raw: string; mark: string; cls: CopyMarkClass };

export interface CopyLine {
  /** 1-based line number. */
  number: number;
  /** The line's tokens; a line that ends in a line feed ends with an `eol` mark whose raw is "\n". */
  tokens: CopyToken[];
}

/** Zero-width characters and the BOM, by code point, with the name drawn for each. */
const ZERO_WIDTH: ReadonlyMap<number, string> = new Map([
  [0x200b, 'ZWSP'],
  [0x200c, 'ZWNJ'],
  [0x200d, 'ZWJ'],
  [0x2060, 'WJ'],
  [0xfeff, 'BOM'],
]);
/** Bidi controls and line/paragraph separators: invisible, and able to reorder or break what is seen. */
function isBidiOrSeparator(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

const hex4 = (code: number) => code.toString(16).toUpperCase().padStart(4, '0');

/** The marker for one character, or null when it is visible as it is. */
export function markFor(ch: string): { mark: string; cls: CopyMarkClass } | null {
  if (ch === '\n') return { mark: '⏎', cls: 'eol' };
  if (ch === '\t') return { mark: '→', cls: 'tab' };
  const code = ch.codePointAt(0)!;
  const zw = ZERO_WIDTH.get(code);
  if (zw) return { mark: zw, cls: 'zero-width' };
  // C0 controls (except LF and TAB, handled above): the Unicode control pictures ␀..␟.
  if (code < 0x20) return { mark: String.fromCodePoint(0x2400 + code), cls: 'control' };
  if (code === 0x7f) return { mark: '␡', cls: 'control' };
  // C1 controls have no pictures: their escape form.
  if (code >= 0x80 && code <= 0x9f) return { mark: `\\u${hex4(code)}`, cls: 'control' };
  if (isBidiOrSeparator(code)) return { mark: `U+${hex4(code)}`, cls: 'bidi' };
  return null;
}

/** The received string as numbered lines of tokens; the raws, joined, are exactly the input. */
export function tokenizeCopyText(text: string): CopyLine[] {
  const lines: CopyLine[] = [];
  if (text === '') return lines;
  let tokens: CopyToken[] = [];
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ kind: 'text', raw: plain });
    plain = '';
  };
  const endLine = () => {
    markTrailingSpaces(tokens);
    lines.push({ number: lines.length + 1, tokens });
    tokens = [];
  };
  for (const ch of text) {
    const m = markFor(ch);
    if (!m) {
      plain += ch;
      continue;
    }
    flush();
    tokens.push({ kind: 'mark', raw: ch, ...m });
    if (m.cls === 'eol') endLine();
  }
  flush();
  // A final line without a line feed; a string ending in "\n" has no empty line after it.
  if (tokens.length > 0) endLine();
  return lines;
}

/** Spaces at the end of a line (before its line feed, or at the end of the string) become marks. */
function markTrailingSpaces(tokens: CopyToken[]) {
  let i = tokens.length - 1;
  if (i >= 0 && tokens[i]!.kind === 'mark' && (tokens[i] as { cls: CopyMarkClass }).cls === 'eol') i--;
  const last = tokens[i];
  if (!last || last.kind !== 'text') return;
  const m = /( +)$/.exec(last.raw);
  if (!m) return;
  const keep = last.raw.slice(0, last.raw.length - m[1]!.length);
  const marks: CopyToken[] = [...m[1]!].map(() => ({ kind: 'mark', raw: ' ', mark: '·', cls: 'trailing-space' }));
  tokens.splice(i, 1, ...(keep ? [{ kind: 'text' as const, raw: keep }] : []), ...marks);
}

/** Joining every token's raw — the identity the copy box relies on. */
export function joinRaw(lines: readonly CopyLine[]): string {
  return lines.map((l) => l.tokens.map((t) => t.raw).join('')).join('');
}

/** Line count as the box numbers them: a trailing line feed does not open another line; "" has none. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const feeds = text.split('\n').length - 1;
  return text.endsWith('\n') ? feeds : feeds + 1;
}

/** The string's size in UTF-8 bytes (what a terminal receives when it is pasted). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The copy statement: what this screen copied, computed from the very string it wrote. */
export function copiedStatement(text: string): string {
  return `✓ 복사됨 · ${lineCount(text)}줄 · ${utf8Bytes(text)}바이트`;
}
