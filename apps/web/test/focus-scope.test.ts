// Focus restore on close: give focus back only when nothing else took it —
// a surface that focused itself meanwhile (e.g. a ③ overlay's trap) owns it.
import { describe, expect, it } from 'vitest';
import { shouldRestoreFocus } from '../src/ui/focusScope.js';

describe('shouldRestoreFocus', () => {
  const el = (name: string) => ({ name }) as unknown as Element;

  it('restores on the plain-close path (focus fell back to the body or nowhere)', () => {
    const body = el('body');
    expect(shouldRestoreFocus(null, body)).toBe(true);
    expect(shouldRestoreFocus(body, body)).toBe(true);
  });

  it('bails when another element already holds focus', () => {
    const body = el('body');
    expect(shouldRestoreFocus(el('gate-approve'), body)).toBe(false);
  });
});
