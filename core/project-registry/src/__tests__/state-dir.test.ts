import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveProjectId } from '../project-id.js';
import { createProjectRegistry } from '../registry.js';
import { resolveProjectStateDir, resolveRuntimeReadPath, resolveRuntimeStatePath } from '../state-dir.js';

let sandbox: string;
let kbHome: string;
let project: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-state-dir-')));
  kbHome = join(sandbox, 'home');
  project = join(sandbox, 'project');
  mkdirSync(kbHome);
  mkdirSync(join(project, '.kb'), { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveProjectStateDir', () => {
  it('unregistered project: deterministic id from the canonical path under the given root', () => {
    const dir = resolveProjectStateDir(project, { root: kbHome });
    expect(dir).toBe(join(kbHome, 'state', deriveProjectId(project)));
    expect(resolveProjectStateDir(project, { root: kbHome })).toBe(dir);
  });

  it('registered project: same directory as the registry reports', async () => {
    const registry = createProjectRegistry({ root: kbHome });
    const { project: entry } = await registry.add(project);
    expect(resolveProjectStateDir(project, { root: kbHome })).toBe(registry.stateDir(entry.id));
  });

  it('respects KB_HOME from the environment and never defaults into the repository', () => {
    const dir = resolveProjectStateDir(project, { env: { KB_HOME: kbHome } });
    expect(dir.startsWith(join(kbHome, 'state') + '/')).toBe(true);
    expect(dir.startsWith(project)).toBe(false);
  });

  it('explicit root wins over KB_HOME', () => {
    const other = join(sandbox, 'other-home');
    expect(resolveProjectStateDir(project, { root: other, env: { KB_HOME: kbHome } })).toBe(
      join(other, 'state', deriveProjectId(project)),
    );
  });

  it('a symlink to the project resolves to the same directory', () => {
    const link = join(sandbox, 'project-link');
    symlinkSync(project, link);
    expect(resolveProjectStateDir(link, { root: kbHome })).toBe(resolveProjectStateDir(project, { root: kbHome }));
  });

  it('a trailing separator does not change the directory', () => {
    expect(resolveProjectStateDir(`${project}/`, { root: kbHome })).toBe(
      resolveProjectStateDir(project, { root: kbHome }),
    );
  });

  it('a not-yet-existing folder is canonicalized through its existing ancestor', () => {
    const link = join(sandbox, 'ancestor-link');
    symlinkSync(sandbox, link);
    const viaLink = resolveProjectStateDir(join(link, 'future', 'app'), { root: kbHome });
    const direct = resolveProjectStateDir(join(sandbox, 'future', 'app'), { root: kbHome });
    expect(viaLink).toBe(direct);
  });

  it('different projects get different directories', () => {
    const second = join(sandbox, 'second');
    mkdirSync(second);
    expect(resolveProjectStateDir(second, { root: kbHome })).not.toBe(resolveProjectStateDir(project, { root: kbHome }));
  });
});

describe('runtime state paths and legacy read fallback', () => {
  const segments = ['cache', 'cli-manifests.json'] as const;

  it('returns the state path for writing and the in-repo path as legacy', () => {
    const { path, legacyPath } = resolveRuntimeStatePath(project, segments, { root: kbHome });
    expect(path).toBe(join(resolveProjectStateDir(project, { root: kbHome }), ...segments));
    expect(legacyPath).toBe(join(project, '.kb', ...segments));
  });

  it('reads the new location when nothing exists yet', () => {
    const fresh = join(sandbox, 'fresh');
    mkdirSync(join(fresh, '.kb'), { recursive: true });
    const { path } = resolveRuntimeStatePath(fresh, segments, { root: kbHome });
    expect(resolveRuntimeReadPath(fresh, segments, { root: kbHome })).toBe(path);
  });

  it('falls back to the legacy in-repo file when only it exists', () => {
    const legacyOnly = join(sandbox, 'legacy-only');
    mkdirSync(join(legacyOnly, '.kb', 'cache'), { recursive: true });
    const { legacyPath } = resolveRuntimeStatePath(legacyOnly, segments, { root: kbHome });
    writeFileSync(legacyPath, '{}');
    expect(resolveRuntimeReadPath(legacyOnly, segments, { root: kbHome })).toBe(legacyPath);
  });

  it('prefers the new location once it exists', () => {
    const both = join(sandbox, 'both');
    mkdirSync(join(both, '.kb', 'cache'), { recursive: true });
    const { path, legacyPath } = resolveRuntimeStatePath(both, segments, { root: kbHome });
    writeFileSync(legacyPath, '{"legacy":true}');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"legacy":false}');
    expect(resolveRuntimeReadPath(both, segments, { root: kbHome })).toBe(path);
  });
});
