// The web suite never reaches a developer's real Gunnflow home (test/setup-home.ts).
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('home isolation', () => {
  it('GUNNFLOW_HOME points into a temp dir', () => {
    expect(process.env.GUNNFLOW_HOME?.startsWith(resolve(tmpdir()))).toBe(true);
  });
});
