// Keybindings: names in engine code, keys in machine prefs — resolution,
// sanitation and matching are pure.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYS,
  duplicateOf,
  isBindableKey,
  isTypingTag,
  matchesKey,
  resolveKey,
  sanitizeKeys,
} from '../src/state/keybindings.js';

describe('keybinding resolution', () => {
  it('falls back to the engine default and honors a machine override', () => {
    expect(resolveKey(undefined, 'open-decision-inbox')).toBe(DEFAULT_KEYS['open-decision-inbox']);
    expect(resolveKey({}, 'open-decision-inbox')).toBe('d');
    expect(resolveKey({ 'open-decision-inbox': 'G' }, 'open-decision-inbox')).toBe('g');
    // A malformed stored value never breaks the binding.
    expect(resolveKey({ 'open-decision-inbox': 'ctrl+g' }, 'open-decision-inbox')).toBe('d');
  });

  it('sanitizes stored keys: single printable characters only, unknown names kept', () => {
    expect(sanitizeKeys(null)).toEqual({});
    expect(sanitizeKeys({ 'open-decision-inbox': 'K', future: 'ㅈ', bad: 'Escape', worse: ' ', '': 'x' })).toEqual({
      'open-decision-inbox': 'k',
      future: 'ㅈ',
    });
  });

  it('bindable keys are one printable character (astral characters count as one)', () => {
    expect(isBindableKey('d')).toBe(true);
    expect(isBindableKey('ㅈ')).toBe(true);
    expect(isBindableKey('')).toBe(false);
    expect(isBindableKey(' ')).toBe(false);
    expect(isBindableKey('dd')).toBe(false);
    expect(isBindableKey(3)).toBe(false);
  });

  it('matches plain keys case-insensitively and never a chord', () => {
    const e = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    });
    expect(matchesKey(e('d'), 'd')).toBe(true);
    expect(matchesKey(e('D'), 'd')).toBe(true);
    expect(matchesKey(e('d', { ctrlKey: true }), 'd')).toBe(false);
    expect(matchesKey(e('d', { metaKey: true }), 'd')).toBe(false);
    expect(matchesKey(e('x'), 'd')).toBe(false);
  });

  it('refuses assigning a key another binding already resolves to', () => {
    // Defaults: open=d, next=j, prev=k.
    expect(duplicateOf({}, 'open-decision-inbox', 'j')).toBe('inbox-next');
    expect(duplicateOf({}, 'open-decision-inbox', 'J')).toBe('inbox-next'); // case-insensitive
    expect(duplicateOf({}, 'inbox-next', 'j')).toBeNull(); // its own key is fine
    expect(duplicateOf({}, 'open-decision-inbox', 'x')).toBeNull();
    // An override moves the conflict with it.
    expect(duplicateOf({ 'inbox-next': 'n' }, 'open-decision-inbox', 'j')).toBeNull();
    expect(duplicateOf({ 'inbox-next': 'n' }, 'open-decision-inbox', 'n')).toBe('inbox-next');
    expect(duplicateOf({}, 'open-decision-inbox', 'jj')).toBeNull(); // malformed never "collides"
  });

  it('typing surfaces silence plain-key bindings', () => {
    expect(isTypingTag('INPUT')).toBe(true);
    expect(isTypingTag('textarea')).toBe(true);
    expect(isTypingTag('SELECT')).toBe(true);
    expect(isTypingTag('DIV', 'true')).toBe(true);
    expect(isTypingTag('BUTTON')).toBe(false);
    expect(isTypingTag(undefined)).toBe(false);
  });
});
