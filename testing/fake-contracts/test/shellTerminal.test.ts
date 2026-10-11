import { describe, expect, it } from 'vitest';
import type { UpstreamTerminal, UpstreamTerminalEvent } from '@gunnflow/upstream-port';
import { base64ToBytes, bytesToBase64, createFakeUpstream } from '../src/index.js';

const b64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const text = (events: UpstreamTerminalEvent[]) =>
  events
    .map((e) =>
      e.type === 'exit' ? `<exit ${e.code}>` : e.type === 'end' ? `<end ${e.reason}>` : new TextDecoder().decode(base64ToBytes(e.bytesBase64)),
    )
    .join('');

describe('simulator terminals (upstream-port 0.2.0)', () => {
  it('lists the attachable console bound to a node', () => {
    const up = createFakeUpstream();
    expect(up.listTerminals!()).toEqual([
      { terminalId: 'term-build', label: 'Web Build console', kind: 'attachable', state: 'running', nodeId: 't-build' },
    ]);
  });

  it('opens a shell that echoes keystrokes and answers a line', async () => {
    const up = createFakeUpstream();
    const opened = await up.openTerminal!({ target: { shell: { cwd: '/work' } }, cols: 100, rows: 30 });
    expect(opened).toEqual({ ok: true, terminalId: 'shell-1' });
    const events: UpstreamTerminalEvent[] = [];
    up.subscribeTerminalOutput!('shell-1', (e) => events.push(e));
    expect(events[0]?.type).toBe('snapshot');
    await up.terminalInput!('shell-1', b64('hi\r'));
    await up.terminalInput!('shell-1', b64('size\r'));
    expect(text(events)).toBe('echo shell in /work (simulated)\r\n$ hi\r\nhi\r\n$ size\r\n100x30\r\n$ ');
    await up.terminalResize!('shell-1', 120, 40);
    await up.terminalInput!('shell-1', b64('size\rexit\r'));
    expect(text(events)).toContain('120x40');
    expect(events.at(-1)).toEqual({ type: 'exit', code: 0 });
    expect(await up.terminalInput!('shell-1', b64('x'))).toEqual({ ok: false, reason: 'exited' });
  });

  it('a new subscriber starts from the retained snapshot', async () => {
    const up = createFakeUpstream();
    const opened = await up.openTerminal!({ target: { attach: 'term-build' }, cols: 80, rows: 24 });
    if (!('ok' in opened) || !opened.ok) throw new Error('attach refused');
    await up.terminalInput!(opened.terminalId, b64('one\r'));
    const events: UpstreamTerminalEvent[] = [];
    up.subscribeTerminalOutput!(opened.terminalId, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(text(events)).toContain('$ one\r\none\r\n$ ');
  });

  it('attaching opens a new terminal; the target id is not one, and closing the view leaves the target running', async () => {
    const up = createFakeUpstream();
    expect(await up.openTerminal!({ target: { attach: 'term-build' }, cols: 90, rows: 20 })).toEqual({ ok: true, terminalId: 'view-1' });
    // The target id names what to join only, as on a real backend.
    expect(up.subscribeTerminalOutput!('term-build', () => undefined)).toBeUndefined();
    expect(await up.terminalInput!('term-build', b64('x'))).toEqual({ ok: false, reason: 'unknown' });
    expect(await up.terminalResize!('term-build', 80, 24)).toEqual({ ok: false, reason: 'unknown' });
    expect(await up.closeTerminal!('term-build')).toEqual({ ok: false, reason: 'unknown' });
    // The view is listed beside its target, with its label and node.
    expect(await up.listTerminals!()).toEqual([
      { terminalId: 'term-build', label: 'Web Build console', kind: 'attachable', state: 'running', nodeId: 't-build' },
      { terminalId: 'view-1', label: 'Web Build console', kind: 'attachable', state: 'running', nodeId: 't-build' },
    ]);
    const first: UpstreamTerminalEvent[] = [];
    up.subscribeTerminalOutput!('view-1', (e) => first.push(e));
    await up.terminalInput!('view-1', b64('size\r'));
    expect(text(first)).toContain('90x20');
    expect(await up.closeTerminal!('view-1')).toEqual({ ok: true });
    expect(first.at(-1)).toEqual({ type: 'exit', code: null });
    expect(((await up.listTerminals!()) as UpstreamTerminal[]).map((t) => [t.terminalId, t.state])).toEqual([['term-build', 'running']]);
    // A second viewer gets its own terminal, sees what the first one typed, and ends with the target.
    expect(await up.openTerminal!({ target: { attach: 'term-build' }, cols: 80, rows: 24 })).toEqual({ ok: true, terminalId: 'view-2' });
    const second: UpstreamTerminalEvent[] = [];
    up.subscribeTerminalOutput!('view-2', (e) => second.push(e));
    expect(text(second)).toContain('90x20');
    await up.terminalInput!('view-2', b64('exit\r'));
    expect(second.at(-1)).toEqual({ type: 'exit', code: 0 });
    expect(await up.openTerminal!({ target: { attach: 'term-build' }, cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'session has exited' });
  });

  it('refuses unknown terminals and a shell without a folder', async () => {
    const up = createFakeUpstream();
    expect(up.subscribeTerminalOutput!('nope', () => undefined)).toBeUndefined();
    expect(await up.terminalInput!('nope', b64('x'))).toEqual({ ok: false, reason: 'unknown' });
    expect(await up.closeTerminal!('nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(await up.openTerminal!({ target: { shell: { cwd: ' ' } }, cols: 80, rows: 24 })).toEqual({
      ok: false,
      reason: 'a folder is required',
    });
  });

  it('closing a shell ends its stream and drops it from the list', async () => {
    const up = createFakeUpstream();
    await up.openTerminal!({ target: { shell: { cwd: '/w' } }, cols: 80, rows: 24 });
    const events: UpstreamTerminalEvent[] = [];
    up.subscribeTerminalOutput!('shell-1', (e) => events.push(e));
    expect(await up.closeTerminal!('shell-1')).toEqual({ ok: true });
    expect(events.at(-1)).toEqual({ type: 'exit', code: null });
    expect(((await up.listTerminals!()) as UpstreamTerminal[]).map((t) => t.terminalId)).toEqual(['term-build']);
  });
});
