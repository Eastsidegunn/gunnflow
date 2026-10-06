/**
 * The engine's default look as ONE preset: every visual value the engine
 * paints lives here, as literals (hex colours, characters, numbers) — the
 * same vocabulary wiring config uses. Nothing in this file is structure:
 * changing a value here restyles the cockpit without touching engine code.
 * What stays invariant is the mechanism (grades must stay distinguishable,
 * dashes belong to pending/draft, fallback never distorts) — not these
 * particular values.
 */

export const DEFAULT_THEME = {
  /** DOM chrome: injected as `--<name>` CSS variables at boot (see main.tsx). */
  chrome: {
    bg: '#101317',
    panel: '#171c22',
    border: '#242b34',
    text: '#dde3ea',
    subtext: '#94a0ae',
    accent: '#4da3ff',
    gate: '#ffb02e',
    blocked: '#ff5d5d',
    pending: '#9aa5ff',
    /** Portal grade (live remote, unattested): its own hue — amber stays attention's alone (N-04). */
    portal: '#4dd0db',
    personal: '#f472b6',
  },

  /** Fallback for an unmapped or invalid state (never distorts: neutral, not invented). */
  neutral: { glyph: '○', tone: '#dde3ea' },

  /** The engine's own attention signal (interrupt borders, badges) and its background wash. */
  attention: '#ffb02e',
  attentionWash: 'rgba(255,176,46,0.12)',

  /** Config-selectable edge strokes (all solid — dashes are grade signifiers). */
  edges: {
    solid: { width: 2, color: '#303945', double: false },
    bold: { width: 3, color: '#6ee7a8', double: false },
    muted: { width: 1, color: '#242b34', double: false },
    double: { width: 2, color: '#ffb02e', double: true },
  },

  /** Grade-owned dash patterns; config edges never use them. */
  dashes: {
    pending: [7, 6] as readonly number[],
    draft: [2, 4] as readonly number[],
    configEdge: [] as readonly number[],
    /** Engine furniture, not a grade: the cleared breathing margin around the focus node (P3). */
    focusMargin: [4, 5] as readonly number[],
  },

  /** `contain` group boxes. */
  group: {
    fill: 'rgba(77,163,255,0.035)',
    border: '#2c3540',
    borderWidth: 1.5,
    radius: 14,
    label: '#94a0ae',
    labelFont: '600 13px system-ui, sans-serif',
  },

  /** The personal grade: a hue no other grade uses, solid, folded corner. */
  personal: {
    color: '#f472b6',
    fill: 'rgba(244,114,182,0.13)',
    text: '#fbe4f0',
    label: 'personal',
    fold: 14,
    boxFill: 'rgba(244,114,182,0.045)',
    chip: 'rgba(80,28,56,0.92)',
  },

  /**
   * Motion tokens (ui-requirements §5.1, Carbon productive). Injected as
   * `--duration-*` / `--ease-*` CSS variables at boot. Received values and
   * attention are NEVER animated (M-16/M-17) — motion is chrome-only.
   */
  motion: {
    durations: { fast01: 70, fast02: 110, moderate01: 150, moderate02: 240, slow01: 400 },
    easings: {
      entrance: 'cubic-bezier(0, 0, 0.38, 0.9)',
      exit: 'cubic-bezier(0.2, 0, 1, 0.9)',
      standard: 'cubic-bezier(0.2, 0, 0.38, 0.9)',
    },
  },

  /** Canvas typography: every ctx.font string the painter uses. */
  fonts: {
    title: '600 14px system-ui, sans-serif',
    meta: '12px system-ui, sans-serif',
    small: '11px system-ui, sans-serif',
    badge: '700 12px system-ui, sans-serif',
    pendingLabel: 'italic 11px system-ui, sans-serif',
    personalHeader: '600 13px system-ui, sans-serif',
    personalMeta: '11px system-ui, sans-serif',
    personalChip: '600 10px system-ui, sans-serif',
    personalBody: '12px system-ui, sans-serif',
  },

  /** Canvas geometry: node size, spacing, grid — density knobs, all data. */
  geometry: {
    node: { w: 200, h: 78 },
    colGap: 90,
    rowGap: 36,
    pad: 48,
    groupPad: 20,
    groupHeader: 30,
    aspect: 1.6,
    gridStep: 64,
    selectionRingOffset: 5,
    /** Dynamic-view P3 — tier → node size factor (index = tier). Size is a LAYOUT INPUT, space is output ③. */
    tierScale: [1, 1, 1.25, 1.6] as readonly number[],
    /** The clear breathing margin kept around a grown node when a local tier change pushes neighbours aside. */
    focusMargin: 24,
    /** Push-aside locality: a ripple travels at most this many contact hops from a grown node — distant nodes never move. */
    pushHops: 3,
  },

  /** The canvas painter's palette. */
  canvas: {
    bg: '#101317',
    grid: '#1a1f26',
    missionBox: '#171c22',
    missionBorder: '#242b34',
    missionLabel: '#8b96a5',
    node: '#1d242d',
    nodeBorder: '#303945',
    text: '#dde3ea',
    subtext: '#94a0ae',
    faint: '#5b6672',
    running: '#4da3ff',
    blocked: '#ff5d5d',
    gate: '#ffb02e',
    done: '#3b4552',
    deliverable: '#6ee7a8',
    selection: '#7aa7ff',
    pending: '#9aa5ff',
    /** White ground under rendered diagrams (mermaid stickies). */
    paper: '#ffffff',
  },
} as const;

/** Injects the chrome palette and motion tokens as CSS variables before first render. */
export function applyChrome(root: HTMLElement = document.documentElement, theme = DEFAULT_THEME): void {
  for (const [name, value] of Object.entries(theme.chrome)) root.style.setProperty(`--${name}`, value);
  for (const [name, ms] of Object.entries(theme.motion.durations)) root.style.setProperty(`--duration-${name}`, `${ms}ms`);
  for (const [name, curve] of Object.entries(theme.motion.easings)) root.style.setProperty(`--ease-${name}`, curve);
}
