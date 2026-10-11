/**
 * Interactive terminals through the BFF (upstream-port 0.2.0). Bytes only: the
 * cockpit encodes keystrokes and decodes chunks for xterm, and reads neither.
 */

export interface TerminalEntry {
  terminalId: string;
  label: string;
  kind: 'attachable' | 'shell';
  state: 'running' | 'exited';
  nodeId?: string;
}

/** The BFF's input limit is 64 KiB of base64; raw chunks stay under it. */
export const INPUT_CHUNK_BYTES = 48 * 1024;

export type TerminalList = { ok: true; terminals: TerminalEntry[] } | { ok: false; unsupported: boolean; reason: string };

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** UTF-8 encode typed or pasted text and split it into input-sized base64 chunks. */
export function encodeInput(text: string, chunkBytes = INPUT_CHUNK_BYTES): string[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) chunks.push(bytesToBase64(bytes.subarray(i, i + chunkBytes)));
  return chunks;
}

async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === 'string') return body.reason;
  } catch {
    /* no body */
  }
  return `HTTP ${res.status}`;
}

export async function listTerminals(): Promise<TerminalList> {
  try {
    const res = await fetch('/api/terminals');
    if (!res.ok) return { ok: false, unsupported: res.status === 501, reason: await reasonOf(res) };
    const body = (await res.json()) as { terminals: TerminalEntry[] };
    return { ok: true, terminals: body.terminals };
  } catch (err) {
    return { ok: false, unsupported: false, reason: String(err) };
  }
}

export type OpenTarget = { attach: string } | { shell: { cwd: string } };

/**
 * Either target opens a new terminal: input, size, output and close all use the
 * returned terminalId. An `attach` id names what to join, not a terminal to talk to.
 */
export async function openTerminal(
  target: OpenTarget,
  cols: number,
  rows: number,
): Promise<{ ok: true; terminalId: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, cols, rows }),
    });
    if (!res.ok) return { ok: false, reason: await reasonOf(res) };
    return { ok: true, terminalId: ((await res.json()) as { terminalId: string }).terminalId };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? null : await reasonOf(res);
  } catch (err) {
    return String(err);
  }
}

export const resizeTerminal = (id: string, cols: number, rows: number) =>
  post(`/api/terminals/${encodeURIComponent(id)}/resize`, { cols, rows });

/** `keepalive`: the request outlives the page (a tab closing or reloading). */
export async function closeTerminal(id: string, opts: { keepalive?: boolean } = {}): Promise<string | null> {
  try {
    const res = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: opts.keepalive });
    return res.ok ? null : await reasonOf(res);
  } catch (err) {
    return String(err);
  }
}

/** Keystrokes and pastes leave in order: each write waits for the one before it. */
export function inputSender(id: string, onError: (reason: string) => void): (text: string) => void {
  let tail: Promise<unknown> = Promise.resolve();
  return (text) => {
    for (const chunk of encodeInput(text)) {
      tail = tail.then(async () => {
        const refused = await post(`/api/terminals/${encodeURIComponent(id)}/input`, { bytesBase64: chunk });
        if (refused) onError(refused);
      });
    }
  };
}

export interface OutputHandlers {
  /** The retained output; on every (re)connect the screen restarts from it. */
  snapshot(bytes: Uint8Array): void;
  data(bytes: Uint8Array): void;
  exit(code: number | null): void;
  /** The stream dropped (the browser retries) or could not open (closed for good). */
  lost(retrying: boolean): void;
}

export function connectOutput(id: string, h: OutputHandlers): () => void {
  const es = new EventSource(`/api/terminals/${encodeURIComponent(id)}/output`);
  es.addEventListener('snapshot', (e) => h.snapshot(base64ToBytes(JSON.parse((e as MessageEvent).data).bytesBase64)));
  es.addEventListener('data', (e) => h.data(base64ToBytes(JSON.parse((e as MessageEvent).data).bytesBase64)));
  es.addEventListener('exit', (e) => {
    es.close();
    h.exit(JSON.parse((e as MessageEvent).data).code);
  });
  es.onerror = () => h.lost(es.readyState !== EventSource.CLOSED);
  return () => es.close();
}
