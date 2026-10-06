import { createSignal } from 'solid-js';

export function createSelectionState() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  return { selectedId, select: setSelectedId, clear: () => setSelectedId(null) };
}

export type SelectionState = ReturnType<typeof createSelectionState>;
