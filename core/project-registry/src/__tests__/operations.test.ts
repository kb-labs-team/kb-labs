import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
    const filesBefore = readdirSync(dir);

    const outcome = await addProject(registry, { path: dir });

    expect(outcome.status).toBe('added');
    if (outcome.status === 'added') {
      expect(outcome.project.path).toBe(dir);
    }
    expect(existsSync(join(dir, '.kb'))).toBe(true);
    expect(readdirSync(dir)).toEqual(filesBefore);
    const listed = await listProjects(registry);
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]!.path).toBe(dir);
  });

  it('registers a folder without .kb/ and does not modify it', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('no-kb');
    const filesBefore = readdirSync(dir);

    const outcome = await addProject(registry, { path: dir });

    expect(outcome.status).toBe('added');
    if (outcome.status === 'added') {
      expect(outcome.project.path).toBe(dir);
    }
    expect(existsSync(join(dir, '.kb'))).toBe(false);
    expect(readdirSync(dir)).toEqual(filesBefore);
    expect((await listProjects(registry)).projects).toHaveLength(1);
  });

  it('dry-run plans registration without writing files', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('dry-run');

    const outcome = await addProject(registry, { path: dir, dryRun: true });

    expect(outcome.status).toBe('planned');
    expect(existsSync(join(dir, '.kb'))).toBe(false);
    expect((await listProjects(registry)).projects).toHaveLength(0);
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

  // case: S-124.14
  it('returns the existing project for an idempotent registration', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('dup', true);
    const first = await addProject(registry, { path: dir });
    const duplicate = await addProject(registry, { path: dir });

    expect(duplicate).toMatchObject({ status: 'added', alreadyExisted: true });
    expect(duplicate.project).toEqual(first.project);
    expect((await listProjects(registry)).projects).toHaveLength(1);
  });

  it('keeps a refusal when a duplicate path requests a different name', async () => {
    const registry = createProjectRegistry({ root });
    const dir = makeProject('dup-name', true);
    await addProject(registry, { path: dir, name: 'original' });

    await expect(addProject(registry, { path: dir, name: 'different' })).rejects.toMatchObject({
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
