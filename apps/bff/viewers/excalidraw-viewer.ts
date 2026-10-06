// Excalidraw scene, read-only: restored and exported to SVG with the
// vendored library (fonts from this origin), then shown with pan/zoom.
// No editor is mounted.
// @ts-expect-error — plain JS helper served beside this bundle
import { embeddedSource, panZoom, showError } from '/viewer-assets/panzoom.js';

// The library reads its asset base when it loads: set it first (fonts from this origin, never a CDN), then load it.
// Absolute: this sandboxed page has an opaque origin, so a path relative to `location.origin` would not resolve.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('/viewer-assets/excalidraw/', location.href).href;

try {
  const { exportToSvg, restore } = await import('@excalidraw/excalidraw');
  const scene = JSON.parse(embeddedSource() as string);
  if (scene?.type !== 'excalidraw' || !Array.isArray(scene.elements)) throw new Error('not an Excalidraw scene');
  const data = restore(scene, null, null);
  const svg = await exportToSvg({
    elements: data.elements,
    appState: { ...data.appState, exportBackground: true, exportWithDarkMode: false },
    files: data.files,
  });
  const content = document.getElementById('content')!;
  content.appendChild(svg);
  document.getElementById('status')!.textContent = '';
  panZoom(document.getElementById('stage'), content);
  document.body.dataset.rendered = 'yes';
  report('rendered');
} catch (err) {
  const reason = `Cannot render this scene: ${err instanceof Error ? err.message : String(err)}`;
  showError(reason);
  report('failed', reason);
}

/** Tells the embedding cockpit whether the scene was actually drawn (it mints a display token only then). */
function report(state: 'rendered' | 'failed', reason?: string) {
  parent.postMessage({ gunnflowViewer: state, digest: document.documentElement.dataset.digest, ...(reason ? { reason } : {}) }, '*');
}
