/**
 * An evidence artifact, opened on request (or immediately where it is part of
 * the surface). Showing it through a claim-grade viewer is what makes it
 * "viewed": the display token is minted from that render, and the attestation
 * later states exactly that. Portal-grade evidence can never be viewed.
 */
import { Show, createSignal } from 'solid-js';
import type { ArtifactRef } from '@gunnflow/contract';
import type { WiringConfig } from '@gunnflow/contract/wiring';
import type { DisplayToken } from '../state/editorLogic.js';
import { ArtifactViewer } from './ArtifactViewer.jsx';

export function EvidenceView(props: {
  artifactId: string;
  artifact: ArtifactRef | undefined;
  snapshotBase64: string | undefined;
  config: WiringConfig;
  viewed: boolean;
  onViewed: (token: DisplayToken) => void;
  /** Render immediately (the evidence is part of the surface), rather than on request. */
  autoOpen?: boolean;
  testIdPrefix: string;
}) {
  const [open, setOpen] = createSignal(props.autoOpen === true);
  return (
    <div class="generic-evidence" data-testid={`${props.testIdPrefix}-${props.artifactId}`} data-viewed={props.viewed ? 'yes' : 'no'}>
      <button data-testid={`${props.testIdPrefix}-open-${props.artifactId}`} onClick={() => setOpen(true)} disabled={open()}>
        {props.viewed ? '✓ viewed' : 'view evidence'} · {props.artifactId}
      </button>
      <Show when={open()}>
        <ArtifactViewer
          artifactId={props.artifactId}
          artifact={props.artifact}
          snapshotBase64={props.snapshotBase64}
          config={props.config}
          onViewed={props.onViewed}
          testIdPrefix={props.testIdPrefix}
        />
      </Show>
    </div>
  );
}
