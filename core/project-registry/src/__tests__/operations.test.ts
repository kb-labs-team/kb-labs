import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectRegistry } from '../registry.js';
import { addProject, listProjects, showProject } from '../operations.js';
import { ProjectRegistryError } from '../errors.js';

let sandbox: string;
let root: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-registry-ops-')));
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

describe('addProject', () => {
  it('registers a folder that already has .kb/', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('with-kb', true);

    const outcome = await addProject(registry, { path: dir });

    expect(outcome.status).toBe('added');
    if (outcome.status === 'added') {
      expect(outcome.project.path).toBe(dir);
      expect(outcome.initialized).toBe(false);
      expect(outcome.created).toEqual([]);
    }
    const listed = await listProjects(registry);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toBe(dir);
  });

  it('reports initialization-required for a folder without .kb/ and registers nothing', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('no-kb');

    const outcome = await addProject(registry, { path: dir });

    expect(outcome).toEqual({ status: 'initialization-required', path: dir });
    expect(await listProjects(registry)).toHaveLength(0);
  });

  it('creates the minimal .kb/ and registers when init is set', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('needs-init');

    const outcome = await addProject(registry, { path: dir, init: true });

    expect(outcome.status).toBe('added');
    if (outcome.status === 'added') {
      expect(outcome.initialized).toBe(true);
      expect(outcome.created.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(dir, '.kb'))).toBe(true);
  });

  it('dry-run plans without registering or writing files', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('dry-run-init');

    const outcome = await addProject(registry, { path: dir, init: true, dryRun: true });

    expect(outcome.status).toBe('planned');
    if (outcome.status === 'planned') {
      expect(outcome.wouldInitialize).toBe(true);
    }
    expect(existsSync(join(dir, '.kb'))).toBe(false);
    expect(await listProjects(registry)).toHaveLength(0);
  });

  it('resolves a relative path against the provided cwd', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('relative', true);
    const cwd = join(sandbox, 'projects');

    const outcome = await addProject(registry, { path: 'relative', cwd });

    expect(outcome.status).toBe('added');
    if (outcome.status === 'added') {
      expect(outcome.project.path).toBe(dir);
    }
  });

  it('rejects a duplicate registration with the registry catalog code', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('dup', true);
    await addProject(registry, { path: dir });

    await expect(addProject(registry, { path: dir })).rejects.toMatchObject({
      code: 'KB_PROJECT_ALREADY_REGISTERED',
    });
  });
});

describe('showProject', () => {
  it('returns the summary shape for a registered project', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('show-me', true);
    const { project } = await registry.add(dir);

    const summary = await showProject(registry, project.id);

    expect(summary).toMatchObject({
      id: project.id,
      name: project.name,
      path: dir,
      pathExists: true,
      declaration: 'present',
    });
  });

  it('throws KB_PROJECT_UNKNOWN for a missing ref', async () => {
    const registry = createProjectRegistry({ root });
    await expect(showProject(registry, 'prj_does_not_exist')).rejects.toBeInstanceOf(ProjectRegistryError);
  });
});
