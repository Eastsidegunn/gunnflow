import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, encodeInput, INPUT_CHUNK_BYTES } from '../src/transport/terminalClient.js';
import { terminalsForNode } from '../src/state/terminalPanel.js';
import { en } from '../src/i18n/en.js';
import { ko } from '../src/i18n/ko.js';

describe('terminal panel (GF-T1)', () => {
  it('encodes typed text as UTF-8 bytes, round-tripping through base64', () => {
    const [chunk] = encodeInput('héllo 한글\r');
    expect(new TextDecoder().decode(base64ToBytes(chunk!))).toBe('héllo 한글\r');
    expect(bytesToBase64(new Uint8Array([0, 255, 27]))).toBe('AP8b');
  });

  it('splits a large paste into chunks the BFF accepts, keeping every byte in order', () => {
    const paste = 'x'.repeat(INPUT_CHUNK_BYTES * 2 + 10);
    const chunks = encodeInput(paste);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(64 * 1024);
    expect(chunks.map((c) => new TextDecoder().decode(base64ToBytes(c))).join('')).toBe(paste);
    expect(encodeInput('')).toEqual([]);
  });

  it('offers a node only its running terminals', () => {
    const list = {
      ok: true as const,
      terminals: [
        { terminalId: 'a', label: 'A', kind: 'attachable' as const, state: 'running' as const, nodeId: 'n1' },
        { terminalId: 'b', label: 'B', kind: 'attachable' as const, state: 'exited' as const, nodeId: 'n1' },
        { terminalId: 'c', label: 'C', kind: 'shell' as const, state: 'running' as const },
      ],
    };
    expect(terminalsForNode(list, 'n1').map((x) => x.terminalId)).toEqual(['a']);
    expect(terminalsForNode({ ok: false, unsupported: true, reason: 'x' }, 'n1')).toEqual([]);
    expect(terminalsForNode(null, 'n1')).toEqual([]);
  });

  it('every terminal string exists in English and Korean', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('term.') || k === 'stage.openTerminal');
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect((ko as Record<string, string>)[k], k).toBeTruthy();
  });
});
