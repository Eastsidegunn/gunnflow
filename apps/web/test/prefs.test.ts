// Machine-local prefs: defaults are engine presets; a broken file never breaks the cockpit.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, sanitizePrefs } from '../src/prefs/prefsState.js';

describe('prefs sanitize', () => {
  it('falls back per field and clamps ranges', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ zoomSensitivity: 99, detailZoom: -1, defaultLens: '' })).toEqual({
      zoomSensitivity: 2,
      detailZoom: 0,
      defaultLens: 'all',
      keys: {},
      packContainers: true,
    });
    expect(sanitizePrefs({ zoomSensitivity: '1.5', defaultLens: 'needs-you' })).toEqual({
      ...DEFAULT_PREFS,
      defaultLens: 'needs-you',
    });
  });

  it('carries keybinding overrides and drops malformed ones', () => {
    expect(sanitizePrefs({ keys: { 'open-decision-inbox': 'K', bad: 'ctrl+x', worse: '' } })).toEqual({
      ...DEFAULT_PREFS,
      keys: { 'open-decision-inbox': 'k' },
    });
  });

  it('packContainers: a boolean is kept, anything else falls back to on', () => {
    expect(DEFAULT_PREFS.packContainers).toBe(true);
    expect(sanitizePrefs({ packContainers: false }).packContainers).toBe(false);
    expect(sanitizePrefs({ packContainers: true }).packContainers).toBe(true);
    for (const bad of ['false', 0, null, {}]) expect(sanitizePrefs({ packContainers: bad }).packContainers).toBe(true);
  });
});
