/** GateViewState (Human Gate brief §29) — presentation only: which gate is open. */
import { createSignal } from 'solid-js';

export function createGateViewState() {
  const [openGateId, setOpenGateId] = createSignal<string | null>(null);
  return {
    openGateId,
    open: (gateId: string) => setOpenGateId(gateId),
    close: () => setOpenGateId(null),
  };
}

export type GateViewState = ReturnType<typeof createGateViewState>;
