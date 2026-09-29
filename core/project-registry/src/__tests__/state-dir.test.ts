import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectRegistry } from '../registry.js';
import { resolveProjectStateDir, resolveRuntimeStatePath } from '../state-dir.js';

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
  it('unregistered workspace: uses a deterministic isolated state key', () => {
    const dir = resolveProjectStateDir(project, { root: kbHome });
    expect(dir.startsWith(join(kbHome, 'state', 'prj_'))).toBe(true);
    expect(resolveProjectStateDir(project, { root: kbHome })).toBe(dir);
  });

  it('registered project: same directory as the registry reports', async () => {
    const registry = createProjectRegistry({ root: kbHome });
    const { project: entry } = await registry.add(project);
    expect(resolveProjectStateDir(project, { root: kbHome })).toBe(registry.stateDir(entry.id));
  });

  it('keeps the registered state directory after moving the project and updating its path', async () => {
    const originalPath = join(sandbox, 'movable-project');
    const movedPath = join(sandbox, 'projects', 'movable-project');
    mkdirSync(originalPath);
    const registry = createProjectRegistry({ root: kbHome });
    const { project } = await registry.add(originalPath);
    const originalStateDir = registry.stateDir(project.id);

    mkdirSync(join(sandbox, 'projects'));
    renameSync(originalPath, movedPath);
    await registry.update(project.id, { path: movedPath });

    expect(resolveProjectStateDir(movedPath, { root: kbHome })).toBe(originalStateDir);
    expect(resolveProjectStateDir(originalPath, { root: kbHome })).not.toBe(originalStateDir);
  });

  it('respects KB_HOME from the environment and never defaults into the repository', () => {
    const dir = resolveProjectStateDir(project, { env: { KB_HOME: kbHome } });
    expect(dir.startsWith(join(kbHome, 'state') + '/')).toBe(true);
    expect(dir.startsWith(project)).toBe(false);
  });

  it('explicit root wins over KB_HOME', () => {
    const other = join(sandbox, 'other-home');
    const id = 'prj_0123456789abcdef0123456789abcdef';
    expect(resolveProjectStateDir(project, { root: other, env: { KB_HOME: kbHome }, projectId: id })).toBe(
      join(other, 'state', id),
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

describe('resolveRuntimeStatePath', () => {
  const segments = ['cache', 'cli-manifests.json'] as const;

  it('joins the segments under the project state directory', () => {
    expect(resolveRuntimeStatePath(project, segments, { root: kbHome })).toBe(
      join(resolveProjectStateDir(project, { root: kbHome }), ...segments),
    );
  });

  it('ignores files an older version left in the repository', () => {
    const legacyOnly = join(sandbox, 'legacy-only');
    mkdirSync(join(legacyOnly, '.kb', 'cache'), { recursive: true });
    writeFileSync(join(legacyOnly, '.kb', 'cache', 'cli-manifests.json'), '{}');
    const resolved = resolveRuntimeStatePath(legacyOnly, segments, { root: kbHome });
    expect(resolved.startsWith(legacyOnly)).toBe(false);
    expect(existsSync(resolved)).toBe(false);
  });
});
