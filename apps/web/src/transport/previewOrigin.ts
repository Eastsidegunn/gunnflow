/**
 * The isolated preview origin (charter §25): agent-generated/executable content
 * is only ever loaded from this SEPARATE origin, inside a sandboxed iframe,
 * under the preview server's strict CSP. Never same-origin.
 */
export const PREVIEW_ORIGIN: string =
  (import.meta.env.VITE_PREVIEW_ORIGIN as string | undefined) ?? 'http://127.0.0.1:8788';

export function previewUrl(deliverableId: string): string {
  return `${PREVIEW_ORIGIN}/preview/${encodeURIComponent(deliverableId)}`;
}

/** One artifact version on the isolated origin, addressed immutably by its digest. */
export function previewArtifactUrl(artifactId: string, digest: string): string {
  return `${PREVIEW_ORIGIN}/artifact/${encodeURIComponent(artifactId)}/${encodeURIComponent(digest)}`;
}

/** A mermaid source version rendered to SVG on the isolated origin (shown as <img>). */
export function previewMermaidUrl(artifactId: string, digest: string): string {
  return `${PREVIEW_ORIGIN}/render/mermaid/${encodeURIComponent(artifactId)}/${encodeURIComponent(digest)}`;
}

/** The isolated read-only Excalidraw viewer page for one scene version. */
export function previewExcalidrawUrl(artifactId: string, digest: string): string {
  return `${PREVIEW_ORIGIN}/viewer/excalidraw?id=${encodeURIComponent(artifactId)}&digest=${encodeURIComponent(digest)}`;
}

/** The same version, offered as a verified download (never rendered). */
export function previewDownloadUrl(artifactId: string, digest: string): string {
  return `${previewArtifactUrl(artifactId, digest)}?download=1`;
}

/**
 * Why isolation does not hold, if it does not: a preview origin that equals
 * (or cannot be told apart from) the page's own origin would run agent content
 * same-origin. A misconfiguration must refuse loudly, not degrade silently.
 */
export function isolationProblem(previewOrigin: string, pageOrigin: string): string | undefined {
  let preview: string;
  try {
    preview = new URL(previewOrigin).origin;
  } catch {
    return `preview origin '${previewOrigin}' is not a URL`;
  }
  if (preview === 'null') return `preview origin '${previewOrigin}' has no origin`;
  if (preview === pageOrigin) return `preview origin ${preview} is this page's own origin — isolation would not hold`;
  return undefined;
}

/** The isolation check for this page. */
export function pageIsolationProblem(): string | undefined {
  return isolationProblem(PREVIEW_ORIGIN, typeof window === 'undefined' ? '' : window.location.origin);
}
