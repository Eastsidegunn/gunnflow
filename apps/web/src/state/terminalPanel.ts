/**
 * The terminal panel's open state and the offered terminals, shared by the
 * toolbar entry and the node stage ("Open terminal" when one is bound to the node).
 */
import { createRoot, createSignal } from 'solid-js';
import { listTerminals, type TerminalEntry, type TerminalList } from '../transport/terminalClient.js';

export function terminalsForNode(list: TerminalList | null, nodeId: string): TerminalEntry[] {
  return list?.ok ? list.terminals.filter((x) => x.nodeId === nodeId && x.state === 'running') : [];
}

export const terminalPanel = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  /** The terminal on screen; null = the list. */
  const [active, setActive] = createSignal<TerminalEntry | null>(null);
  const [list, setList] = createSignal<TerminalList | null>(null);
  let loading: Promise<void> | null = null;
  const refresh = () =>
    (loading ??= listTerminals().then((l) => {
      setList(l);
      loading = null;
    }));
  return {
    open,
    active,
    list,
    refresh,
    show(entry: TerminalEntry | null = null) {
      setActive(entry);
      setOpen(true);
      void refresh();
    },
    back() {
      setActive(null);
      void refresh();
    },
    hide() {
      setOpen(false);
      setActive(null);
    },
  };
});
