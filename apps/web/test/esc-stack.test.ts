// Esc ownership: one Esc, one level — only the top owner acts; the App
// ladder is the base owner (acts when the stack is empty).
import { describe, expect, it } from 'vitest';
import { createEscStack } from '../src/state/escStack.js';

describe('esc stack', () => {
  it('only the top owner is active; the base (empty stack) is the ladder', () => {
    const s = createEscStack();
    expect(s.isEmpty()).toBe(true);
    const a = {};
    const b = {};
    const releaseA = s.push(a);
    expect(s.isTop(a)).toBe(true);
    const releaseB = s.push(b);
    expect(s.isTop(a)).toBe(false);
    expect(s.isTop(b)).toBe(true);
    releaseB();
    expect(s.isTop(a)).toBe(true);
    releaseA();
    expect(s.isEmpty()).toBe(true);
  });

  it('release works out of order and is idempotent', () => {
    const s = createEscStack();
    const a = {};
    const b = {};
    const releaseA = s.push(a);
    s.push(b);
    releaseA(); // the one below leaves first
    expect(s.isTop(b)).toBe(true);
    expect(s.size()).toBe(1);
    releaseA(); // again: no effect
    expect(s.size()).toBe(1);
  });
});
