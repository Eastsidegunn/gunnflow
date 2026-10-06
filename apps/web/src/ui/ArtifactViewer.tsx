/**
 * One artifact, shown by the viewer the wiring maps its media type to.
 * Grades stay visible: claim (upstream bytes, digest-pinned) carries the claim
 * border; portal (live remote content) carries its own label and never yields
 * a display token. Interpreted content only ever renders on the isolated origin.
 */
import { Match, Show, Switch, createResource, createSignal, onCleanup } from 'solid-js';
import type { ArtifactRef } from '@gunnflow/contract';
import type { WiringConfig } from '@gunnflow/contract/wiring';
import { fixBase, markServedAfterLoad, pinServed, type DisplayToken } from '../state/editorLogic.js';
import { viewerPlan } from '../state/viewerPlan.js';
import {
  pageIsolationProblem,
  previewArtifactUrl,
  previewDownloadUrl,
  previewExcalidrawUrl,
  previewMermaidUrl,
} from '../transport/previewOrigin.js';
import { onRendered } from './renderedToken.js';

/** Asks the isolated origin about a digest address; only a verified 200 names a digest. */
async function servedDigest(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? res.headers.get('x-gunnflow-digest') : null;
  } catch {
    return null;
  }
}

const liveUrl = (ref: ArtifactRef) => (ref.access.kind === 'live' ? ref.access.url : undefined);

export function ArtifactViewer(props: {
  artifactId: string;
  artifact: ArtifactRef | undefined;
  snapshotBase64: string | undefined;
  config: WiringConfig;
  onViewed?: (token: DisplayToken) => void;
  testIdPrefix: string;
}) {
  const viewed = (t: DisplayToken | undefined) => t && props.onViewed?.(t);
  const tid = (part: string) => `${props.testIdPrefix}-${part}-${props.artifactId}`;
  return (
    <Show when={props.artifact} fallback={<p class="hint">Artifact {props.artifactId} is not in the projection.</p>}>
      {(ref) => {
        const plan = viewerPlan(ref(), props.config);
        return (
          <Switch>
            <Match when={plan === 'plain'}>
              <PlainView artifact={ref()} b64={props.snapshotBase64} tid={tid('plain')} onViewed={viewed} />
            </Match>
            <Match when={plan === 'frame' || plan === 'image'}>
              <IsolatedView artifact={ref()} embed={plan === 'image' ? 'img' : 'frame'} src={previewArtifactUrl} tid={tid('isolated')} onViewed={viewed} />
            </Match>
            <Match when={plan === 'mermaid'}>
              <MermaidView artifact={ref()} b64={props.snapshotBase64} tid={tid('mermaid')} onViewed={viewed} />
            </Match>
            <Match when={plan === 'scene'}>
              <IsolatedView artifact={ref()} embed="scene" src={previewExcalidrawUrl} tid={tid('scene')} onViewed={viewed} />
            </Match>
            <Match when={plan === 'portal' && liveUrl(ref())}>
              {(url) => <PortalView url={url()} tid={tid('portal')} />}
            </Match>
            <Match when={plan === 'fallback'}>
              <p class="hint" data-testid={tid('fallback')}>
                No viewer for {ref().mediaType}.{' '}
                <Show when={!pageIsolationProblem() && ref().digest} fallback="Nothing to download without a declared digest on an isolated origin.">
                  {(d) => (
                    <a href={previewDownloadUrl(ref().id, d() as string)} target="_blank" rel="noopener noreferrer" download="">
                      Download the verified bytes
                    </a>
                  )}
                </Show>
              </p>
            </Match>
          </Switch>
        );
      }}
    </Show>
  );
}

function PlainView(p: { artifact: ArtifactRef; b64: string | undefined; tid: string; onViewed: (t: DisplayToken | undefined) => void }) {
  const [base] = createResource(() => ({ r: p.artifact, b: p.b64 }), (s) => fixBase(s.r, s.b, [s.r.mediaType]));
  return (
    <Show when={base()}>
      {(b) => {
        const fixed = b();
        return fixed.ok ? (
          <pre class="editor-base" data-grade="claim" data-testid={p.tid} ref={(el) => onRendered(el, fixed.pinned, p.onViewed)}>
            {fixed.text}
          </pre>
        ) : (
          <p class="hint">Artifact cannot be pinned — {fixed.reason}</p>
        );
      }}
    </Show>
  );
}

/**
 * An isolated-origin embed. The display token needs the embed to have loaded
 * from exactly its digest address and the origin to re-confirm that digest;
 * a scene viewer must also report that it actually drew the scene.
 */
function IsolatedView(p: {
  artifact: ArtifactRef;
  embed: 'img' | 'frame' | 'scene';
  src: (id: string, digest: string) => string;
  tid: string;
  onViewed: (t: DisplayToken | undefined) => void;
}) {
  const problem = pageIsolationProblem();
  if (problem) return <p class="hint" data-testid={`${p.tid}-refused`}>Isolated viewer refused — {problem}</p>;
  const digest = p.artifact.digest;
  if (!digest) return <p class="hint">No declared digest — the isolated viewer shows nothing.</p>;
  const src = p.src(p.artifact.id, digest);
  const pinned = pinServed(p.artifact, src);
  const [status, setStatus] = createSignal<'loading' | 'confirmed' | 'unconfirmed'>('loading');
  const [failure, setFailure] = createSignal<string | null>(null);
  let frame: HTMLIFrameElement | undefined;
  // The scene viewer reports whether it drew the scene (its page has an opaque origin; the source is the frame itself).
  const drawn =
    p.embed === 'scene'
      ? new Promise<boolean>((resolve) => {
          const onMessage = (e: MessageEvent) => {
            if (!frame || e.source !== frame.contentWindow) return;
            const d = e.data as { gunnflowViewer?: string; digest?: string; reason?: string } | null;
            if (d?.gunnflowViewer === 'rendered' && d.digest === digest) finish(true);
            else if (d?.gunnflowViewer === 'failed') {
              setFailure(typeof d.reason === 'string' ? d.reason : 'the viewer could not draw the scene');
              finish(false);
            }
          };
          const timer = setTimeout(() => finish(false), 20_000);
          const finish = (ok: boolean) => {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(ok);
          };
          window.addEventListener('message', onMessage);
          onCleanup(() => finish(false));
        })
      : Promise.resolve(true);
  const loaded = (el: HTMLElement) => {
    if (!pinned) return setStatus('unconfirmed');
    void drawn
      .then((ok) => (ok ? markServedAfterLoad(pinned, el, servedDigest) : undefined))
      .then((token) => {
        setStatus(token ? 'confirmed' : 'unconfirmed');
        p.onViewed(token);
      });
  };
  return (
    <>
      {p.embed === 'img' ? (
        <img class="artifact-frame" data-grade="claim" data-status={status()} data-testid={p.tid} src={src} alt={p.artifact.id} onLoad={(e) => loaded(e.currentTarget)} onError={() => setStatus('unconfirmed')} />
      ) : p.embed === 'scene' ? (
        <iframe
          ref={frame}
          class="artifact-frame artifact-scene"
          data-grade="claim"
          data-status={status()}
          data-testid={p.tid}
          src={src}
          sandbox="allow-scripts"
          title={`Artifact ${p.artifact.id} (isolated scene viewer)`}
          onLoad={(e) => loaded(e.currentTarget)}
        />
      ) : (
        <iframe
          class="artifact-frame"
          data-grade="claim"
          data-status={status()}
          data-testid={p.tid}
          src={src}
          sandbox=""
          title={`Artifact ${p.artifact.id} (isolated)`}
          onLoad={(e) => loaded(e.currentTarget)}
        />
      )}
      <Show when={status() === 'unconfirmed'}>
        <p class="hint" data-testid={`${p.tid}-unconfirmed`}>
          {failure() ?? 'The isolated origin did not confirm these bytes'} — not counted as viewed.
        </p>
      </Show>
    </>
  );
}

/** What the isolated renderer says about a mermaid source version: rendered, or unavailable with its reason. */
async function renderStatus(src: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return { ok: true };
    const header = res.headers.get('x-gunnflow-render-error');
    return { ok: false, reason: header ? decodeURIComponent(header) : `renderer answered ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `renderer unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Mermaid: the isolated origin renders the verified source to SVG, shown as
 * an <img> (an SVG in <img> runs no script). When the renderer is missing or
 * fails, the reason is shown with the source as plain text — never an empty frame.
 */
function MermaidView(p: { artifact: ArtifactRef; b64: string | undefined; tid: string; onViewed: (t: DisplayToken | undefined) => void }) {
  const problem = pageIsolationProblem();
  if (problem) return <p class="hint" data-testid={`${p.tid}-refused`}>Isolated viewer refused — {problem}</p>;
  const digest = p.artifact.digest;
  if (!digest) return <p class="hint">No declared digest — the isolated viewer shows nothing.</p>;
  const [status] = createResource(() => renderStatus(previewMermaidUrl(p.artifact.id, digest)));
  // Source text for the fallback: the projection's snapshot, else the verified bytes from the isolated origin.
  const [b64] = createResource(
    () => (status()?.ok === false ? true : undefined),
    async () => p.b64 ?? (await sourceBase64(previewArtifactUrl(p.artifact.id, digest))),
  );
  return (
    <Show when={status()}>
      {(s) => {
        const st = s();
        return st.ok ? (
          <IsolatedView artifact={p.artifact} embed="img" src={previewMermaidUrl} tid={p.tid} onViewed={p.onViewed} />
        ) : (
          <div data-testid={`${p.tid}-unavailable`}>
            <p class="hint">Renderer unavailable — {st.reason}. Showing the diagram source.</p>
            <Show when={b64() !== undefined}>
              <PlainView artifact={p.artifact} b64={b64() ?? undefined} tid={`${p.tid}-source`} onViewed={p.onViewed} />
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

async function sourceBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  } catch {
    return null;
  }
}

function PortalView(p: { url: string; tid: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="artifact-portal" data-grade="portal" data-testid={p.tid}>
      <p class="grade-label">portal · live remote content · no guarantee · cannot be attested</p>
      <Show when={open()} fallback={<button data-testid={`${p.tid}-open`} onClick={() => setOpen(true)}>Open</button>}>
        <iframe class="artifact-frame" src={p.url} sandbox="" title="Live portal" referrerPolicy="no-referrer" />
      </Show>
    </div>
  );
}
