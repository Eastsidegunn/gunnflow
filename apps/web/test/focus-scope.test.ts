// Focus restore on close: give focus back only when nothing else took it —
// a surface that focused itself meanwhile (e.g. a ③ overlay's trap) owns it.
import { describe, expect, it } from 'vitest';
import { keyOwnerFocus, shouldRestoreFocus } from '../src/ui/focusScope.js';

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

describe('keyOwnerFocus (a non-modal surface takes keys only with focus inside it, or on nothing)', () => {
  const node = (name: string) => ({ name }) as unknown as Node;
  const inside = node('row');
  const root = { contains: (n: Node | null) => n === inside };
  const body = node('body');

  it('inside the surface, on the body or with no target: yes', () => {
    expect(keyOwnerFocus(inside, root, body)).toBe(true);
    expect(keyOwnerFocus(body, root, body)).toBe(true);
    expect(keyOwnerFocus(null, root, body)).toBe(true);
  });

  it('focus elsewhere (a canvas mirror node, a context menu item): no', () => {
    expect(keyOwnerFocus(node('menu-item'), root, body)).toBe(false);
    expect(keyOwnerFocus(node('mirror-node'), null, body)).toBe(false);
  });
});
