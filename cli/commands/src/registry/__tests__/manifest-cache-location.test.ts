/**
 * ADR-0044: the CLI manifest discovery cache is per-project runtime state.
 * It must be written to `<KB_HOME>/state/<projectId>/cache/`, never into the
 * project's `.kb/`, while an existing in-repo cache is still readable for one
 * release. Uses the real file system (no fs mocks).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectStateDir } from '@kb-labs/core-project-registry';
import { discoverManifests, resetInProcCache } from '../discover';
import { manifestCacheReadPath, manifestCacheWritePath } from '../manifest-cache-path';

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'kb-manifest-cache-')));
  mkdirSync(join(project, '.kb'), { recursive: true });
  resetInProcCache();
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('manifest cache location', () => {
  it('is under the project state directory, not the repository', () => {
    const written = manifestCacheWritePath(project);
    expect(written).toBe(join(resolveProjectStateDir(project), 'cache', 'cli-manifests.json'));
    expect(written.startsWith(project)).toBe(false);
  });

  it('discovery writes the cache to the state directory and leaves .kb/ free of cache files', async () => {
    await discoverManifests(project, true, { platformRoot: project, projectRoot: project });

    expect(existsSync(manifestCacheWritePath(project))).toBe(true);
    expect(existsSync(join(project, '.kb', 'cache'))).toBe(false);
  });

  it('reads the legacy in-repo cache while no cache exists in the state directory', () => {
    const legacy = join(project, '.kb', 'cache', 'cli-manifests.json');
    mkdirSync(join(project, '.kb', 'cache'), { recursive: true });
    writeFileSync(legacy, '{}');

    expect(manifestCacheReadPath(project)).toBe(legacy);
  });

  it('prefers the state-directory cache once it exists', () => {
    const legacy = join(project, '.kb', 'cache', 'cli-manifests.json');
    mkdirSync(join(project, '.kb', 'cache'), { recursive: true });
    writeFileSync(legacy, '{}');
    const fresh = manifestCacheWritePath(project);
    mkdirSync(join(fresh, '..'), { recursive: true });
    writeFileSync(fresh, '{}');

    expect(manifestCacheReadPath(project)).toBe(fresh);
  });
});
