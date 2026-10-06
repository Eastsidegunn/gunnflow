// ui-requirements M-18/M-19: motion is token-only. Every animation/transition
// in the stylesheet takes its duration from an injected --duration-* variable
// (no raw numbers), and reduced motion turns everything off.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../src/theme/defaultTheme.js';
import { presenceStep, type PresenceState } from '../src/ui/presence.js';

const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');

describe('motion tokens (M-19)', () => {
  it('the theme carries exactly the agreed Carbon-productive tokens', () => {
    expect(DEFAULT_THEME.motion.durations).toEqual({ fast01: 70, fast02: 110, moderate01: 150, moderate02: 240, slow01: 400 });
    expect(Object.keys(DEFAULT_THEME.motion.easings).sort()).toEqual(['entrance', 'exit', 'standard']);
  });

  it('no raw duration numbers in any animation/transition — tokens only', () => {
    // The reduced-motion kill switch is the one allowed place for literal durations.
    const withoutKillSwitch = css.replace(/@media \(prefers-reduced-motion:[^}]*\}[^}]*\}/s, '');
    const decls = withoutKillSwitch.match(/(?:animation|transition):[^;]*;/g) ?? [];
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) {
      expect(d, d).not.toMatch(/\d+\s*m?s/);
      expect(d, d).toMatch(/var\(--duration-/);
    }
  });

  it('reduced motion kills every animation and transition (M-18)', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/animation-duration: 0.01ms !important/);
    expect(css).toMatch(/transition-duration: 0ms !important/);
  });
});

describe('exit presence (M-02/M-03/M-06) — the pure transition', () => {
  it('holds through the exit, swaps content in place, re-enters when the value returns', () => {
    let st: PresenceState<string> = { held: null, phase: 'enter' };
    let r = presenceStep(st, 'a');
    expect(r.next).toEqual({ held: 'a', phase: 'enter' });
    expect(r.startExit).toBe(false);
    // M-03: a CHANGED value swaps content without exit or re-entrance.
    r = presenceStep(r.next, 'b');
    expect(r.next).toEqual({ held: 'b', phase: 'enter' });
    expect(r.startExit).toBe(false);
    // Vanished: one exit starts, the content stays mounted meanwhile.
    r = presenceStep(r.next, null);
    expect(r.next).toEqual({ held: 'b', phase: 'exit' });
    expect(r.startExit).toBe(true);
    // Still gone: no second exit timer.
    r = presenceStep(r.next, null);
    expect(r.startExit).toBe(false);
    // A value during the exit cancels it and re-enters.
    r = presenceStep(r.next, 'c');
    expect(r.next).toEqual({ held: 'c', phase: 'enter' });
  });
});

describe('signal colours (N-04, scoped to engine signals)', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  it('attention, pending, portal, accent and personal are distinct hues, each readable on the canvas ground', () => {
    const c = DEFAULT_THEME.chrome;
    const signals = [c.gate, c.pending, c.portal, c.accent, c.personal];
    expect(new Set(signals).size).toBe(signals.length);
    for (const s of signals) expect(contrast(s, c.bg), s).toBeGreaterThanOrEqual(3);
  });
  it('amber belongs to attention alone — portal carries its own hue', () => {
    expect(DEFAULT_THEME.chrome.portal).not.toBe(DEFAULT_THEME.chrome.gate);
  });
});
