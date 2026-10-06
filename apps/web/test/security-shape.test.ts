// Acceptance G1/G2 (web side): L0 never mounts executable agent content
// same-origin, and no UI shape collects credential values.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function allSources(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...allSources(p));
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(p);
  }
  return out;
}

describe('security shape', () => {
  it('G1/H: executable content is never mounted same-origin — iframes are sandboxed and point at the isolated origin (or an opened live portal)', () => {
    for (const file of allSources()) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('<iframe')) {
        // Allowed embeds: the gate preview and the artifact viewer, sandboxed, isolated origin.
        expect(file.endsWith('HumanGateSurface.tsx') || file.endsWith('ArtifactViewer.tsx'), file).toBe(true);
        const frames = text.split('<iframe').slice(1).map((f) => f.slice(0, f.indexOf('/>')));
        for (const f of frames) {
          // Scripts only for the isolated scene viewer page (opaque origin); every other frame runs none.
          if (f.includes('sandbox="allow-scripts"')) expect(file.endsWith('ArtifactViewer.tsx') && text.includes('previewExcalidrawUrl'), file).toBe(true);
          else expect(f, file).toContain('sandbox=""');
        }
        expect(/previewUrl\(|previewArtifactUrl\(/.test(text), file).toBe(true);
        expect(/src=\{?["']\//.test(text), 'no same-origin iframe src').toBe(false);
        expect(text.includes('allow-same-origin'), file).toBe(false);
      }
      expect(text.includes('srcdoc'), file).toBe(false);
      expect(text.includes('dangerouslySetInnerHTML'), file).toBe(false);
      expect(/\binnerHTML\s*=/.test(text), file).toBe(false);
      expect(/\beval\s*\(/.test(text), file).toBe(false);
    }
    // The preview origin helper never points at the app's own origin.
    const previewOrigin = readFileSync(join(SRC, 'transport', 'previewOrigin.ts'), 'utf8');
    expect(previewOrigin).not.toContain("?? ''");
    expect(previewOrigin).not.toContain("?? '/'");
  });

  it('diagram libraries never load in the cockpit: mermaid and Excalidraw run only on the isolated origin', () => {
    for (const file of allSources()) {
      const text = readFileSync(file, 'utf8');
      expect(/from\s+['"](mermaid|@excalidraw\/)|import\(\s*['"](mermaid|@excalidraw\/)/.test(text), file).toBe(false);
    }
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies']) {
      for (const dep of Object.keys(pkg[field] ?? {})) expect(/^(mermaid|@excalidraw\/)/.test(dep), dep).toBe(false);
    }
  });

    it('G2: no input field in the workspace collects passwords/secrets', () => {
    for (const file of allSources()) {
      const text = readFileSync(file, 'utf8');
      expect(/type=["']password["']/.test(text), file).toBe(false);
      expect(/name=["'](password|secret|token|apiKey)["']/.test(text), file).toBe(false);
    }
  });
});
