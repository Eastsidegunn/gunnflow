/**
 * TEST-ONLY interactive terminals for the upstream port's terminal surface
 * (upstream-port 0.2.0). An echo shell stands in for a real PTY: it echoes
 * keystrokes, answers a finished line by printing it back, `size` prints the
 * last resize, `exit` ends it. Bytes in, bytes out — the cockpit and the BFF
 * never see anything but base64 chunks.
 */
import type {
  UpstreamTerminal,
  UpstreamTerminalAck,
  UpstreamTerminalEvent,
  UpstreamTerminalOpen,
  UpstreamTerminalOpened,
} from '@gunnflow/upstream-port';

const RETAIN_BYTES = 64 * 1024;
const PROMPT = '$ ';

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

type Listener = (event: UpstreamTerminalEvent) => void;

export class FakeEchoShell {
  readonly info: UpstreamTerminal;
  private retained: Uint8Array = new Uint8Array(0);
  private line = '';
  private cols: number;
  private rows: number;
  private exitCode: number | null | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(info: Omit<UpstreamTerminal, 'state'>, cols = 80, rows = 24, banner = '') {
    this.info = { ...info, state: 'running' };
    this.cols = cols;
    this.rows = rows;
    this.emit(banner + PROMPT);
  }

  get state(): UpstreamTerminal['state'] {
    return this.exitCode === undefined ? 'running' : 'exited';
  }

  snapshotBase64(): string {
    return bytesToBase64(this.retained);
  }

  subscribe(listener: Listener): () => void {
    listener({ type: 'snapshot', bytesBase64: this.snapshotBase64() });
    if (this.exitCode !== undefined) {
      listener({ type: 'exit', code: this.exitCode });
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  input(bytesBase64: string): UpstreamTerminalAck {
    if (this.exitCode !== undefined) return { ok: false, reason: 'exited' };
    let out = '';
    for (const ch of dec.decode(base64ToBytes(bytesBase64))) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.line.trim();
        this.line = '';
        if (cmd === 'exit') {
          this.emit(out + '\r\n');
          this.end(0);
          return { ok: true };
        }
        out += '\r\n';
        if (cmd === 'size') out += `${this.cols}x${this.rows}\r\n`;
        else if (cmd) out += `${cmd}\r\n`;
        out += PROMPT;
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          out += '\b \b';
        }
      } else if (ch === '\x03') {
        this.line = '';
        out += '^C\r\n' + PROMPT;
      } else if (ch >= ' ') {
        this.line += ch;
        out += ch;
      }
    }
    if (out) this.emit(out);
    return { ok: true };
  }

  resize(cols: number, rows: number): UpstreamTerminalAck {
    if (this.exitCode !== undefined) return { ok: false, reason: 'exited' };
    this.cols = cols;
    this.rows = rows;
    return { ok: true };
  }

  end(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    for (const l of this.listeners) l({ type: 'exit', code });
    this.listeners.clear();
  }

  private emit(text: string): void {
    const bytes = enc.encode(text);
    const merged = new Uint8Array(this.retained.length + bytes.length);
    merged.set(this.retained);
    merged.set(bytes, this.retained.length);
    this.retained = merged.length > RETAIN_BYTES ? merged.slice(merged.length - RETAIN_BYTES) : merged;
    const event: UpstreamTerminalEvent = { type: 'data', bytesBase64: bytesToBase64(bytes) };
    for (const l of this.listeners) l(event);
  }
}

/**
 * One viewer's terminal onto a running target, as a real backend opens it on
 * `attach`: its own terminalId, the target's bytes both ways. Closing it ends
 * this view only (its stream gets `exit`); the target keeps running. When the
 * target ends, the view ends with it.
 */
export class FakeAttachView {
  readonly info: UpstreamTerminal;
  private exitCode: number | null | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly off: () => void;

  constructor(
    terminalId: string,
    private readonly target: FakeEchoShell,
  ) {
    this.info = { ...target.info, terminalId, state: 'running' };
    // Only the target's later output and its end matter here; a subscriber starts from the target's snapshot.
    this.off = target.subscribe((e) => {
      if (e.type === 'exit') this.end(e.code);
      else if (e.type === 'data') for (const l of this.listeners) l(e);
    });
  }

  get state(): UpstreamTerminal['state'] {
    return this.exitCode === undefined ? 'running' : 'exited';
  }

  subscribe(listener: Listener): () => void {
    listener({ type: 'snapshot', bytesBase64: this.target.snapshotBase64() });
    if (this.exitCode !== undefined) {
      listener({ type: 'exit', code: this.exitCode });
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  input(bytesBase64: string): UpstreamTerminalAck {
    return this.exitCode !== undefined ? { ok: false, reason: 'exited' } : this.target.input(bytesBase64);
  }

  resize(cols: number, rows: number): UpstreamTerminalAck {
    return this.exitCode !== undefined ? { ok: false, reason: 'exited' } : this.target.resize(cols, rows);
  }

  end(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.off();
    for (const l of this.listeners) l({ type: 'exit', code });
    this.listeners.clear();
  }
}

type FakeTerminal = FakeEchoShell | FakeAttachView;

/**
 * The simulator's terminal table, shaped like a real backend's. The attachable
 * console bound to a node is a *target*: its id is for `attach` only, never for
 * input, size, output or close. Attaching opens a new terminal (`view-N`), listed
 * beside the target with its label and node; closing that view leaves the target
 * running. A new shell (`shell-N`) is a terminal of its own.
 */
export class FakeTerminals {
  private readonly targets = new Map<string, FakeEchoShell>();
  private readonly terminals = new Map<string, FakeTerminal>();
  private nextShell = 1;
  private nextView = 1;

  constructor() {
    this.targets.set(
      'term-build',
      new FakeEchoShell(
        { terminalId: 'term-build', label: 'Web Build console', kind: 'attachable', nodeId: 't-build' },
        80,
        24,
        'build console (simulated)\r\n',
      ),
    );
  }

  list(): UpstreamTerminal[] {
    return [...this.targets.values(), ...this.terminals.values()].map((t) => ({ ...t.info, state: t.state }));
  }

  open(request: UpstreamTerminalOpen): UpstreamTerminalOpened {
    if ('attach' in request.target) {
      const t = this.targets.get(request.target.attach);
      if (!t) return { ok: false, reason: 'no such session' };
      if (t.state === 'exited') return { ok: false, reason: 'session has exited' };
      t.resize(request.cols, request.rows);
      const terminalId = `view-${this.nextView++}`;
      this.terminals.set(terminalId, new FakeAttachView(terminalId, t));
      return { ok: true, terminalId };
    }
    const cwd = request.target.shell.cwd.trim();
    if (!cwd) return { ok: false, reason: 'a folder is required' };
    const terminalId = `shell-${this.nextShell++}`;
    this.terminals.set(
      terminalId,
      new FakeEchoShell({ terminalId, label: `shell · ${cwd}`, kind: 'shell' }, request.cols, request.rows, `echo shell in ${cwd} (simulated)\r\n`),
    );
    return { ok: true, terminalId };
  }

  /** Terminals only: an attach target's id names no terminal. */
  get(terminalId: string): FakeTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  close(terminalId: string): UpstreamTerminalAck {
    const t = this.terminals.get(terminalId);
    if (!t) return { ok: false, reason: 'unknown' };
    t.end(null);
    this.terminals.delete(terminalId);
    return { ok: true };
  }
}
