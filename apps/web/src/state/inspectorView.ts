/**
 * TaskInspectorViewState (Task Inspector brief §21) — pure presentation state:
 * which task the drawer shows, and which tab. Never mixed with projection or
 * pending-intent state.
 */
import { createSignal } from 'solid-js';

export type InspectorTab = 'overview' | 'activity' | 'related';

export function createInspectorViewState() {
  const [openTaskId, setOpenTaskId] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<InspectorTab>('overview');

  return {
    openTaskId,
    tab,
    setTab,
    open(taskId: string) {
      if (openTaskId() !== taskId) setTab('overview');
      setOpenTaskId(taskId);
    },
    close() {
      setOpenTaskId(null);
    },
  };
}

export type InspectorViewState = ReturnType<typeof createInspectorViewState>;
