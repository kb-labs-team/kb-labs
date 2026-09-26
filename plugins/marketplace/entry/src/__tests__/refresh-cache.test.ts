import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { clearDiscoveryCache } from '../commands/plugins/refresh';

const SEGMENTS = ['cache', 'cli-manifests.json'] as const;

let project: string;
let kbHome: string;
let previousKbHome: string | undefined;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'kb-refresh-project-')));
  kbHome = realpathSync(mkdtempSync(join(tmpdir(), 'kb-refresh-home-')));
  previousKbHome = process.env.KB_HOME;
  process.env.KB_HOME = kbHome;
});

afterEach(() => {
  if (previousKbHome === undefined) {
    delete process.env.KB_HOME;
  } else {
    process.env.KB_HOME = previousKbHome;
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(kbHome, { recursive: true, force: true });
});

function writeCache(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{}');
}

describe('clearDiscoveryCache', () => {
  it('removes the cache from the project state directory and the legacy in-repo location', async () => {
    const { path, legacyPath } = resolveRuntimeStatePath(project, SEGMENTS);
    writeCache(path);
    writeCache(legacyPath);

    expect(await clearDiscoveryCache(project)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('reports false when there is nothing to clear', async () => {
    expect(await clearDiscoveryCache(project)).toBe(false);
  });
});
