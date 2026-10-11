/**
 * The terminal panel: a backend's terminal used here like a local one. xterm.js
 * draws the bytes the backend sends and hands back the bytes typed or pasted;
 * the cockpit reads neither. A (re)connect starts from the backend's retained
 * snapshot. Esc belongs to the shell — the panel closes by its button only.
 */
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import '@xterm/xterm/css/xterm.css';
import { t } from '../i18n/index.js';
import { terminalPanel } from '../state/terminalPanel.js';
import {
  closeTerminal,
  connectOutput,
  inputSender,
  openTerminal,
  resizeTerminal,
  type TerminalEntry,
  type TerminalList as TerminalListResult,
} from '../transport/terminalClient.js';

type Status = 'connecting' | 'live' | 'retrying' | 'exited' | 'gone';

export function TerminalPanelToggle() {
  return (
    <button
      class="term-toggle"
      data-testid="terminals-toggle"
      aria-pressed={terminalPanel.open()}
      onClick={() => (terminalPanel.open() ? terminalPanel.hide() : terminalPanel.show())}
    >
      {t('term.toggle')}
    </button>
  );
}

export function TerminalPanel() {
  const p = terminalPanel;
  return (
    <Show when={p.open()}>
      <aside class="term-panel" data-testid="term-panel" role="dialog" aria-label={t('term.title')}>
        <header class="term-head">
          <Show when={p.active()} fallback={<strong>{t('term.title')}</strong>}>
            {(e) => (
              <>
                <button data-testid="term-back" onClick={() => p.back()}>{t('term.back')}</button>
                <strong class="term-label">{e().label}</strong>
              </>
            )}
          </Show>
          <span class="spacer" />
          <button data-testid="term-panel-close" onClick={() => p.hide()}>{t('common.close')}</button>
        </header>
        <Show when={p.active()} keyed fallback={<TerminalList />}>
          {(entry) => <TerminalView entry={entry} />}
        </Show>
      </aside>
    </Show>
  );
}

const offered = (list: TerminalListResult): TerminalEntry[] => (list.ok ? list.terminals : []);

function TerminalList() {
  const p = terminalPanel;
  const [cwd, setCwd] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const openShell = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const folder = cwd().trim();
    const opened = await openTerminal({ shell: { cwd: folder } }, 80, 24);
    if (!opened.ok) return setError(t('term.openFailed', { reason: opened.reason }));
    p.show({ terminalId: opened.terminalId, label: t('term.shellLabel', { folder }), kind: 'shell', state: 'running' });
  };
  return (
    <div class="term-list" data-testid="term-list">
      <Show when={p.list()} fallback={<p class="hint">{t('term.loading')}</p>}>
        {(list) => (
          <Show
            when={list().ok && list()}
            fallback={
              <p class="hint" data-testid="term-list-unavailable">
                {(() => {
                  const l = list();
                  if (l.ok) return '';
                  return l.unsupported ? t('term.unsupported') : t('term.listFailed', { reason: l.reason });
                })()}
              </p>
            }
          >
            {(ok) => (
              <>
                <Show when={offered(ok()).length === 0}>
                  <p class="hint">{t('term.none')}</p>
                </Show>
                <ul>
                  <For each={offered(ok())}>
                    {(x) => (
                      <li class="term-row" data-testid={`term-row-${x.terminalId}`}>
                        <span class="term-kind">{t(x.kind === 'shell' ? 'term.kind.shell' : 'term.kind.attachable')}</span>
                        <span class="term-label">{x.label}</span>
                        <Show
                          when={x.state === 'running'}
                          fallback={<span class="hint">{t('term.state.exited')}</span>}
                        >
                          <button data-testid={`term-open-${x.terminalId}`} onClick={() => p.show(x)}>
                            {t('term.open')}
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <form class="term-new" onSubmit={openShell}>
                  <label>
                    {t('term.folder')}
                    <input
                      data-testid="term-folder"
                      value={cwd()}
                      placeholder={t('term.folderPlaceholder')}
                      onInput={(e) => setCwd(e.currentTarget.value)}
                    />
                  </label>
                  <button type="submit" data-testid="term-new-shell" disabled={!cwd().trim()}>
                    {t('term.newShell')}
                  </button>
                </form>
                <Show when={error()}>
                  <p class="term-error" role="alert">{error()}</p>
                </Show>
              </>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

function TerminalView(props: { entry: TerminalEntry }) {
  const id = props.entry.terminalId;
  let host!: HTMLDivElement;
  const [status, setStatus] = createSignal<Status>('connecting');
  const [exitCode, setExitCode] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;
  let teardown: (() => void) | null = null;

  onMount(async () => {
    // Keys typed into the shell are the shell's: none reaches the cockpit's bindings (Esc, Enter, V…).
    host.addEventListener('keydown', (e) => e.stopPropagation());
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    if (disposed) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Attaching states this viewer's size; a refusal leaves the screen read-only with its reason.
    const attached = await openTerminal({ attach: id }, term.cols, term.rows);
    if (disposed) return term.dispose();
    if (!attached.ok) setError(t('term.openFailed', { reason: attached.reason }));
    const send = inputSender(id, (reason) => setError(t('term.inputFailed', { reason })));
    const onData = term.onData((d) => {
      if (status() !== 'exited') send(d);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void resizeTerminal(id, cols, rows), 120);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);
    const stop = connectOutput(id, {
      snapshot: (bytes) => {
        term.reset();
        term.write(bytes);
        setStatus('live');
      },
      data: (bytes) => term.write(bytes),
      exit: (code) => {
        setExitCode(code);
        setStatus('exited');
      },
      lost: (retrying) => setStatus((s) => (s === 'exited' ? s : retrying ? 'retrying' : 'gone')),
    });
    term.focus();
    teardown = () => {
      stop();
      clearTimeout(resizeTimer);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      term.dispose();
    };
  });
  onCleanup(() => {
    disposed = true;
    teardown?.();
  });

  const statusText = () => {
    const s = status();
    if (s === 'exited') return exitCode() === null ? t('term.status.ended') : t('term.status.exited', { code: String(exitCode()) });
    return t(`term.status.${s}`);
  };

  return (
    <div class="term-view">
      <div class="term-screen" data-testid="term-screen" data-status={status()} ref={host} />
      <footer class="term-foot">
        <span class="hint" data-testid="term-status">{statusText()}</span>
        <Show when={error()}>
          <span class="term-error" role="alert">{error()}</span>
        </Show>
        <span class="spacer" />
        <Show when={status() !== 'exited'}>
          <button
            class="privileged"
            data-testid="term-end"
            onClick={async () => {
              const refused = await closeTerminal(id);
              if (refused) setError(t('term.closeFailed', { reason: refused }));
              else terminalPanel.back();
            }}
          >
            {t('term.end')}
          </button>
        </Show>
      </footer>
    </div>
  );
}
