import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistryError } from '../errors.js';
import { withFileLock } from '../file-lock.js';
import { deriveProjectId } from '../project-id.js';
import {
  PROJECT_REGISTRY_SCHEMA_VERSION,
  createProjectRegistry,
  projectStateDir,
  resolveKbHome,
} from '../registry.js';

let sandbox: string;
let root: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-registry-')));
  root = join(sandbox, 'kb-home');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function makeProject(name: string, withKb = false): string {
  const dir = join(sandbox, 'projects', name);
  mkdirSync(dir, { recursive: true });
  if (withKb) {
    mkdirSync(join(dir, '.kb'));
  }
  return dir;
}

describe('resolveKbHome', () => {
  it('honors KB_HOME and falls back to ~/.kb', () => {
    expect(resolveKbHome({ KB_HOME: '/custom/root' })).toBe('/custom/root');
    expect(resolveKbHome({})).toMatch(/[\\/]\.kb$/);
    expect(resolveKbHome({ KB_HOME: '   ' })).toMatch(/[\\/]\.kb$/);
  });

  it('uses the env override for a registry created from env', () => {
    const registry = createProjectRegistry({ env: { KB_HOME: root } });
    expect(registry.root).toBe(root);
    expect(registry.filePath).toBe(join(root, 'projects.json'));
  });
});

describe('add / list / get / remove', () => {
  it('registers a project, persists it and reports the declaration state', async () => {
    const dir = makeProject('alpha', true);
    const registry = createProjectRegistry({ root, now: () => new Date('2026-09-26T10:00:00.000Z') });

    const { project, declaration } = await registry.add(dir);

    expect(declaration).toBe('present');
    expect(project).toEqual({
      id: deriveProjectId(dir),
      path: dir,
      name: 'alpha',
      status: 'active',
      addedAt: '2026-09-26T10:00:00.000Z',
      lastUsedAt: null,
    });
    const onDisk = JSON.parse(readFileSync(registry.filePath, 'utf8')) as { schemaVersion: number };
    expect(onDisk.schemaVersion).toBe(PROJECT_REGISTRY_SCHEMA_VERSION);

    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ pathExists: true, declaration: 'present', stateDir: projectStateDir(root, project.id) });
  });

  it('never creates anything inside the project folder or the state dir', async () => {
    const dir = makeProject('bare');
    const registry = createProjectRegistry({ root });
    const { declaration, project } = await registry.add(dir);

    expect(declaration).toBe('missing');
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['projects.json']);
    expect(registry.stateDir(project.id)).toBe(join(root, 'state', project.id));
  });

  it('rejects a duplicate registration, including via a trailing slash', async () => {
    const dir = makeProject('dup');
    const registry = createProjectRegistry({ root });
    await registry.add(dir);
    await expect(registry.add(`${dir}/`)).rejects.toMatchObject({ code: 'KB_PROJECT_ALREADY_REGISTERED' });
  });

  it('deduplicates default names and rejects an explicit name that is taken', async () => {
    const a = join(sandbox, 'x', 'app');
    const b = join(sandbox, 'y', 'app');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const registry = createProjectRegistry({ root });

    expect((await registry.add(a)).project.name).toBe('app');
    expect((await registry.add(b)).project.name).toBe('app-2');
    await expect(registry.add(makeProject('c'), { name: 'app' })).rejects.toMatchObject({
      code: 'KB_PROJECT_NAME_TAKEN',
    });
  });

  it('dryRun validates and returns the record without persisting anything', async () => {
    const dir = makeProject('preview');
    const registry = createProjectRegistry({ root });

    const { project } = await registry.add(dir, { dryRun: true });

    expect(project.path).toBe(dir);
    expect(await registry.list()).toEqual([]);
    expect(readdirSync(sandbox)).not.toContain('kb-home');

    await registry.add(dir);
    await expect(registry.add(dir, { dryRun: true })).rejects.toMatchObject({
      code: 'KB_PROJECT_ALREADY_REGISTERED',
    });
  });

  it('rejects an invalid explicit name', async () => {
    const registry = createProjectRegistry({ root });
    await expect(registry.add(makeProject('d'), { name: '../evil' })).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
    });
  });

  it('finds a project by id, name and path', async () => {
    const dir = makeProject('finder');
    const registry = createProjectRegistry({ root });
    const { project } = await registry.add(dir, { name: 'my-finder' });

    for (const ref of [project.id, 'my-finder', dir, `${dir}/`]) {
      expect((await registry.get(ref)).project.id).toBe(project.id);
    }
    await expect(registry.get('missing')).rejects.toMatchObject({ code: 'KB_PROJECT_UNKNOWN' });
  });

  it('remove only unregisters: the folder and its runtime state stay', async () => {
    const dir = makeProject('gone', true);
    const registry = createProjectRegistry({ root });
    const { project } = await registry.add(dir);
    const state = registry.stateDir(project.id);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'marker'), 'keep');

    const removed = await registry.remove(project.id);

    expect(removed.id).toBe(project.id);
    expect(await registry.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.kb']);
    expect(readFileSync(join(state, 'marker'), 'utf8')).toBe('keep');
    await expect(registry.remove(project.id)).rejects.toMatchObject({ code: 'KB_PROJECT_UNKNOWN' });
  });

  it('can remove a project whose folder has vanished, and flags it as missing in list', async () => {
    const dir = makeProject('vanishing');
    const registry = createProjectRegistry({ root });
    await registry.add(dir);
    rmSync(dir, { recursive: true });

    expect((await registry.list())[0]).toMatchObject({ pathExists: false, declaration: 'missing' });
    await registry.remove(dir);
    expect(await registry.list()).toEqual([]);
  });

  it('touch sets lastUsedAt', async () => {
    const dir = makeProject('used');
    let tick = 0;
    const registry = createProjectRegistry({ root, now: () => new Date(Date.UTC(2026, 8, 26, 0, 0, tick++)) });
    const { project } = await registry.add(dir);
    const touched = await registry.touch(project.id);
    expect(touched.lastUsedAt).toBe('2026-09-26T00:00:01.000Z');
    expect((await registry.get(project.id)).project.lastUsedAt).toBe(touched.lastUsedAt);
  });

  it('treats a moved folder as a different, unknown project', async () => {
    const dir = makeProject('before-move');
    const registry = createProjectRegistry({ root });
    const { project } = await registry.add(dir);
    const moved = join(sandbox, 'projects', 'after-move');
    mkdirSync(moved);
    const { project: second } = await registry.add(moved);
    expect(second.id).not.toBe(project.id);
  });

  it('starts empty when the registry file does not exist, without creating it on read', async () => {
    const registry = createProjectRegistry({ root });
    expect(await registry.list()).toEqual([]);
    expect(() => readFileSync(registry.filePath)).toThrow();
  });
});

describe('concurrent writes', () => {
  it('keeps every entry when many registries add in parallel', async () => {
    const dirs = Array.from({ length: 40 }, (_, i) => makeProject(`p${i}`));
    const registries = [createProjectRegistry({ root }), createProjectRegistry({ root }), createProjectRegistry({ root })];

    await Promise.all(dirs.map((dir, i) => registries[i % registries.length]!.add(dir)));

    const listed = await createProjectRegistry({ root }).list();
    expect(listed.map((v) => v.project.path).sort()).toEqual([...dirs].sort());
    // No leftover temp or lock files.
    expect(readdirSync(root).sort()).toEqual(['projects.json']);
  });

  it('is safe for interleaved add and remove', async () => {
    const keep = Array.from({ length: 10 }, (_, i) => makeProject(`keep${i}`));
    const drop = Array.from({ length: 10 }, (_, i) => makeProject(`drop${i}`));
    const registry = createProjectRegistry({ root });
    await Promise.all(drop.map((d) => registry.add(d)));

    await Promise.all([
      ...keep.map((d) => registry.add(d)),
      ...drop.map((d) => createProjectRegistry({ root }).remove(d)),
    ]);

    const listed = await registry.list();
    expect(listed.map((v) => v.project.path).sort()).toEqual([...keep].sort());
  });

  it('serializes concurrent duplicate adds: exactly one wins', async () => {
    const dir = makeProject('race');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createProjectRegistry({ root }).add(dir)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect((r.reason as ProjectRegistryError).code).toBe('KB_PROJECT_ALREADY_REGISTERED');
      }
    }
    expect(await createProjectRegistry({ root }).list()).toHaveLength(1);
  });
});

describe('file lock', () => {
  it('fails with a typed error when the lock is held past the timeout', async () => {
    mkdirSync(root, { recursive: true });
    const lockPath = join(root, 'projects.json.lock');
    const registry = createProjectRegistry({ root, lock: { timeoutMs: 120, retryMs: 5, staleMs: 60_000 } });

    await withFileLock(lockPath, async () => {
      await expect(registry.add(makeProject('blocked'))).rejects.toMatchObject({
        code: 'KB_PROJECT_REGISTRY_LOCKED',
      });
    });
    // Released afterwards: the same call now succeeds.
    await expect(registry.add(makeProject('blocked2'))).resolves.toBeDefined();
  });

  it('breaks a lock left behind by a dead process', async () => {
    mkdirSync(root, { recursive: true });
    // pid 2^22 + 1 is above the default pid_max on Linux/macOS, so it is not a live process.
    writeFileSync(
      join(root, 'projects.json.lock'),
      JSON.stringify({ pid: 4_194_305, token: 'dead', createdAt: Date.now() }),
    );
    const registry = createProjectRegistry({ root, lock: { timeoutMs: 2_000 } });
    await expect(registry.add(makeProject('after-crash'))).resolves.toBeDefined();
  });
});

describe('unreadable registry file', () => {
  it('reports corrupt JSON with a typed error and leaves the file untouched', async () => {
    mkdirSync(root, { recursive: true });
    const file = join(root, 'projects.json');
    writeFileSync(file, '{ not json');
    const registry = createProjectRegistry({ root });

    await expect(registry.list()).rejects.toMatchObject({ code: 'KB_PROJECT_REGISTRY_CORRUPT' });
    await expect(registry.add(makeProject('nope'))).rejects.toMatchObject({ code: 'KB_PROJECT_REGISTRY_CORRUPT' });
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('reports a structurally invalid file as corrupt', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'projects.json'),
      JSON.stringify({ schemaVersion: 1, projects: [{ id: 'prj_0000000000000000', path: '/x' }] }),
    );
    await expect(createProjectRegistry({ root }).list()).rejects.toMatchObject({
      code: 'KB_PROJECT_REGISTRY_CORRUPT',
    });
  });

  it('rejects a record whose id does not match its path', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'projects.json'),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            id: 'prj_0000000000000000',
            path: '/some/where',
            name: 'x',
            status: 'active',
            addedAt: '2026-09-26T00:00:00.000Z',
            lastUsedAt: null,
          },
        ],
      }),
    );
    await expect(createProjectRegistry({ root }).list()).rejects.toMatchObject({
      code: 'KB_PROJECT_REGISTRY_CORRUPT',
    });
  });

  it('reports an unknown schema version distinctly and does not rewrite the file', async () => {
    mkdirSync(root, { recursive: true });
    const file = join(root, 'projects.json');
    const content = JSON.stringify({ schemaVersion: 99, projects: [] });
    writeFileSync(file, content);
    const registry = createProjectRegistry({ root });

    const error = await registry.add(makeProject('future')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectRegistryError);
    expect(error).toMatchObject({
      code: 'KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED',
      details: { found: '99', supported: '1' },
    });
    expect(readFileSync(file, 'utf8')).toBe(content);
  });
});
