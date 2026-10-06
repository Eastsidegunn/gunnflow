// G4b: viewer choice follows the wiring, isolated display tokens need the served digest, portals never yield one.
import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '@gunnflow/contract';
import { viewerPlan } from '../src/state/viewerPlan.js';
import { displayRecord, markRendered, markServedAfterLoad, pinServed } from '../src/state/editorLogic.js';
import { isolationProblem, previewArtifactUrl, previewDownloadUrl, previewExcalidrawUrl, previewMermaidUrl } from '../src/transport/previewOrigin.js';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { EMPTY_WIRING } from '../src/wiring/loadWiring.js';

const D = 'a'.repeat(64);
const snap = (id: string, mediaType: string, digest: string | undefined = D): ArtifactRef => ({
  id,
  mediaType,
  ...(digest ? { digest } : {}),
  access: { kind: 'snapshot' },
});
const live: ArtifactRef = { id: 'dash', mediaType: 'text/html', access: { kind: 'live', url: 'https://example.test/dash' } };
const embed = (src: string, connected = true) => ({ isConnected: connected, textContent: '', getAttribute: (n: string) => (n === 'src' ? src : null) });

describe('viewer plan (wiring viewers → engine viewers)', () => {
  it('maps text/markdown to plain, html/pdf to the isolated frame, images to img, the rest to fallback', () => {
    expect(viewerPlan(snap('a', 'text/plain'), DEFAULT_WIRING)).toBe('plain');
    expect(viewerPlan(snap('a', 'text/markdown'), DEFAULT_WIRING)).toBe('plain');
    expect(viewerPlan(snap('a', 'text/html'), DEFAULT_WIRING)).toBe('frame');
    expect(viewerPlan(snap('a', 'application/pdf'), DEFAULT_WIRING)).toBe('frame');
    expect(viewerPlan(snap('a', 'image/png'), DEFAULT_WIRING)).toBe('image');
    expect(viewerPlan(snap('a', 'image/svg+xml'), DEFAULT_WIRING)).toBe('fallback');
    expect(viewerPlan(snap('a', 'application/zip'), DEFAULT_WIRING)).toBe('fallback');
    expect(viewerPlan(snap('a', 'text/html'), EMPTY_WIRING)).toBe('fallback');
  });

  it('mermaid renders on the isolated origin as an image; Excalidraw in the isolated scene viewer; generic JSON is neither', () => {
    expect(viewerPlan(snap('a', 'text/vnd.mermaid'), DEFAULT_WIRING)).toBe('mermaid');
    expect(viewerPlan(snap('a', 'text/x-mermaid'), DEFAULT_WIRING)).toBe('mermaid');
    expect(viewerPlan(snap('a', 'application/vnd.excalidraw+json'), DEFAULT_WIRING)).toBe('scene');
    expect(viewerPlan(snap('a', 'application/json'), DEFAULT_WIRING)).toBe('fallback');
    expect(previewMermaidUrl('art', D)).toBe(`http://127.0.0.1:8788/render/mermaid/art/${D}`);
    expect(previewExcalidrawUrl('art', D)).toBe(`http://127.0.0.1:8788/viewer/excalidraw?id=art&digest=${D}`);
  });

    it('live access is always a portal, whatever the media type maps to', () => {
    expect(viewerPlan(live, DEFAULT_WIRING)).toBe('portal');
    expect(viewerPlan(live, EMPTY_WIRING)).toBe('portal');
  });
});

describe('isolated display token', () => {
  const ref = snap('art-build-report', 'text/html');
  const src = previewArtifactUrl(ref.id, D);

  it('addresses the version by digest; downloads are a separate, explicit query', () => {
    expect(src).toBe(`http://127.0.0.1:8788/artifact/art-build-report/${D}`);
    expect(previewDownloadUrl(ref.id, D)).toBe(`${src}?download=1`);
  });

  it('is minted only when, after the load, the origin re-confirms the same digest address', async () => {
    const pinned = pinServed(ref, src)!;
    const asked: string[] = [];
    const token = await markServedAfterLoad(pinned, embed(src), async (s) => (asked.push(s), D));
    expect(asked).toEqual([src]);
    expect(displayRecord(token)).toMatchObject({ artifactId: ref.id, mediaType: 'text/html', digest: D });
  });

  it('an error document load mints nothing: 404/409 (no digest), another digest, a failed check, or a detached/other embed', async () => {
    const pinned = pinServed(ref, src)!;
    expect(await markServedAfterLoad(pinned, embed(src), async () => null)).toBeUndefined();
    expect(await markServedAfterLoad(pinned, embed(src), async () => 'b'.repeat(64))).toBeUndefined();
    expect(await markServedAfterLoad(pinned, embed(src), () => Promise.reject(new Error('network')))).toBeUndefined();
    expect(await markServedAfterLoad(pinned, embed(src, false), async () => D)).toBeUndefined();
    expect(await markServedAfterLoad(pinned, embed(previewArtifactUrl(ref.id, 'b'.repeat(64))), async () => D)).toBeUndefined();
  });

  it('served pins never mint through the plain-text path', () => {
    const pinned = pinServed(ref, src)!;
    expect(markRendered(pinned, { isConnected: true, textContent: '' })).toBeUndefined();
    expect(markRendered(pinned, embed(src))).toBeUndefined();
  });

  it('limit, pinned: bytes that vanish (the load showed an error document) and reappear before the re-check still mint', async () => {
    const pinned = pinServed(ref, src)!;
    // The re-check can only see the address now, not what the embed rendered earlier.
    const token = await markServedAfterLoad(pinned, embed(src), async () => D);
    expect(displayRecord(token)).toBeDefined();
  });

  it('cannot pin without a declared digest or a snapshot; a live portal never yields a token', () => {
    expect(pinServed(snap('r', 'text/html', ''), 'x')).toBeUndefined();
    expect(pinServed(undefined, 'x')).toBeUndefined();
    expect(pinServed(live, live.access.kind === 'live' ? live.access.url : '')).toBeUndefined();
  });
});

describe('origin isolation check (F3)', () => {
  it('refuses a preview origin equal to the page origin, or one that is not a URL', () => {
    expect(isolationProblem('http://127.0.0.1:8788', 'http://127.0.0.1:5173')).toBeUndefined();
    expect(isolationProblem('http://127.0.0.1:5173', 'http://127.0.0.1:5173')).toContain('own origin');
    expect(isolationProblem('http://127.0.0.1:5173/sub/', 'http://127.0.0.1:5173')).toContain('own origin');
    expect(isolationProblem('', 'http://127.0.0.1:5173')).toContain('not a URL');
    expect(isolationProblem('/preview', 'http://127.0.0.1:5173')).toContain('not a URL');
  });
});
