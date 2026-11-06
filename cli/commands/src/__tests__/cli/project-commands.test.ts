/**
 * Tests for `kb project add | list | show | remove`.
 *
 * They run against a real registry file inside a temp KB_HOME and real temp
 * project folders; the real HOME / ~/.kb is never touched.
 */

import { mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { projectAdd, projectList, projectRemove, projectShow } from '../../commands/system/project/index.js';

let sandbox: string;
let kbHome: string;
let cwd: string;

type Payload = Record<string, unknown> & {
  ok?: boolean;
  data?: {
    projects?: Array<{ id: string; name: string; path: string; pathExists: boolean }>;
    diagnostics?: Array<{ path: string; code: string; message: string; severity: string; hint: string }>;
    project?: { id: string; name: string; path: string };
    [key: string]: unknown;
  };
  error?: { code: string; hint: string; message: string };
};

function makeCtx(): { ctx: PluginContextV3; json: Payload[]; text: string[] } {
  const json: Payload[] = [];
  const text: string[] = [];
  const ctx: PluginContextV3 = {
    host: 'cli',
    requestId: 'test-project',
    pluginId: '@kb-labs/system',
    pluginVersion: '1.0.0',
    cwd,
    ui: {
      ...noopUI,
      json: (data: unknown) => json.push(data as Payload),
      write: (t: string) => {
        text.push(t);
      },
      error: (e: unknown) => {
        text.push(String(e));
      },
      warn: (m: string, options) => {
        text.push(m);
        if (options?.title) text.push(options.title);
        for (const section of options?.sections ?? []) {
          if (section.header) text.push(section.header);
          for (const item of section.items) text.push(typeof item === 'string' ? item : item.text);
        }
      },
      info: (m: string) => {
        text.push(m);
      },
      success: (m: string) => {
        text.push(m);
      },
    },
    platform: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } } as never,
    runtime: { fs: {} as never, fetch: vi.fn(), env: vi.fn() },
    api: {} as never,
    hostContext: { host: 'cli' as const, binaryName: 'kb', argv: [], flags: {} },
    trace: noopTraceContext,
  };
  return { ctx, json, text };
}

function dataOf(output: Payload | undefined): NonNullable<Payload['data']> | undefined {
  expect(output).toMatchObject({ ok: true, data: expect.anything() });
  return output?.data;
}

function makeProject(name: string, withKb: boolean): string {
  const dir = join(sandbox, 'projects', name);
  mkdirSync(dir, { recursive: true });
  if (withKb) {
    mkdirSync(join(dir, '.kb'));
  }
  return dir;
}

async function run(
  command: { run: (ctx: PluginContextV3, argv: string[], flags: Record<string, unknown>) => Promise<number> },
  argv: string[],
  flags: Record<string, unknown> = {},
) {
  const harness = makeCtx();
  const code = await command.run(harness.ctx, argv, { json: true, ...flags });
  return { code, json: harness.json, text: harness.text };
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-project-cmd-')));
  kbHome = join(sandbox, 'kb-home');
  cwd = join(sandbox, 'cwd');
  mkdirSync(cwd);
  vi.stubEnv('KB_HOME', kbHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('project add / list', () => {
  it('registers two projects that then show up in `project list`', async () => {
    const a = makeProject('alpha', true);
    const b = makeProject('beta', true);

    const addA = await run(projectAdd, [a]);
    const addB = await run(projectAdd, [b], { name: 'second' });
    expect(addA.code).toBe(0);
    expect(addB.code).toBe(0);
    expect(dataOf(addB.json[0])?.project?.name).toBe('second');

    const list = await run(projectList, []);
    expect(list.code).toBe(0);
    expect(dataOf(list.json[0])?.projects?.map((p) => p.path).sort()).toEqual([a, b].sort());
    expect(existsSync(join(kbHome, 'projects.json'))).toBe(true);
  });

  it('prints a human table when --json is off', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a], { json: false });
    const list = await run(projectList, [], { json: false });
    expect(list.text.join('')).toContain('alpha');
    expect(list.text.join('')).toContain(a);
  });

  it('does not print human text beside the JSON envelope for an empty registry', async () => {
    const list = await run(projectList, []);
    expect(list.code).toBe(0);
    expect(list.json).toEqual([{ ok: true, data: { projects: [], total: 0, diagnostics: [] } }]);
    expect(list.text).toEqual([]);
  });

  // case: S-124.12
  it('lists identity-corrupt registry records as structured diagnostics and human warnings', async () => {
    const validPath = makeProject('valid-project', false);
    const anotherValidPath = makeProject('another-valid-project', false);
    const corruptPath = makeProject('corrupt-project', false);
    const valid = await run(projectAdd, [validPath]);
    const anotherValid = await run(projectAdd, [anotherValidPath]);
    const corrupt = await run(projectAdd, [corruptPath]);
    const validId = dataOf(valid.json[0])?.project?.id;
    const anotherValidId = dataOf(anotherValid.json[0])?.project?.id;
    const corruptId = dataOf(corrupt.json[0])?.project?.id;
    expect(validId).toBeTruthy();
    expect(anotherValidId).toBeTruthy();
    expect(corruptId).toBeTruthy();

    const registryFile = join(kbHome, 'projects.json');
    const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
    const badRecord = registry.projects.find((project: { id: string }) => project.id === corruptId);
    expect(badRecord).toBeDefined();
    badRecord.id = 'prj_0000000000000000';
    writeFileSync(registryFile, JSON.stringify(registry));
    const corruptBytes = readFileSync(registryFile);

    const jsonList = await run(projectList, []);
    expect(jsonList.code).toBe(0);
    const data = dataOf(jsonList.json[0]);
    expect(data?.projects?.map((project) => project.id)).toEqual(expect.arrayContaining([validId, anotherValidId]));
    expect(data?.projects?.map((project) => project.id)).not.toContain(badRecord.id);
    expect(data?.diagnostics).toEqual([expect.objectContaining({
      path: corruptPath,
      code: 'KB_PROJECT_REGISTRY_CORRUPT',
      severity: 'warning',
      message: expect.stringContaining(badRecord.id),
      hint: expect.stringContaining('kb project add'),
    })]);
    expect(data?.diagnostics?.[0]).not.toHaveProperty('id');

    const human = await run(projectList, [], { json: false });
    expect(human.code).toBe(0);
    expect(human.text.join('\n')).toContain('Project registry warnings');
    expect(human.text.join('\n')).toContain(badRecord.id);
    expect(human.text.join('\n')).toContain(corruptPath);
    expect(human.text.join('\n')).toContain(data?.diagnostics?.[0]?.message ?? '');
    expect(human.text.join('\n')).toContain(data?.diagnostics?.[0]?.hint ?? '');
    expect(readFileSync(registryFile)).toEqual(corruptBytes);
  });

  it('registers the current folder without requiring or creating .kb/', async () => {
    const res = await run(projectAdd, []);
    expect(res.code).toBe(0);
    expect(dataOf(res.json[0])?.project?.path).toBe(cwd);
    expect(existsSync(join(cwd, '.kb'))).toBe(false);
  });

  it('registers an uninitialized project without writing into its repository', async () => {
    const bare = makeProject('bare', false);
    const filesBefore = readdirSync(bare);

    const res = await run(projectAdd, [bare]);

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, data: { project: { path: bare } } });
    expect(Object.keys(res.json[0] ?? {})).not.toContain('initialized');
    expect(readdirSync(bare)).toEqual(filesBefore);
    expect(existsSync(join(bare, '.kb'))).toBe(false);
    const list = await run(projectList, []);
    expect(dataOf(list.json[0])?.projects).toHaveLength(1);
  });

  it('does not print human text beside project add JSON output', async () => {
    const bare = makeProject('add-json', false);
    const added = await run(projectAdd, [bare]);
    expect(added.code).toBe(0);
    expect(added.json).toHaveLength(1);
    expect(added.text).toEqual([]);
  });

  it('--dry-run plans registration without requiring or creating .kb/', async () => {
    const bare = makeProject('bare', false);
    const declared = makeProject('declared', true);

    const plain = await run(projectAdd, [declared], { 'dry-run': true });
    const uninitialized = await run(projectAdd, [bare], { 'dry-run': true });

    expect(plain.json[0]).toMatchObject({ ok: true, data: { dryRun: true, project: { path: declared } } });
    expect(uninitialized.json[0]).toMatchObject({ ok: true, data: { dryRun: true, project: { path: bare } } });
    expect(readdirSync(bare)).toEqual([]);
    expect(existsSync(join(kbHome, 'projects.json'))).toBe(false);
  });

  it('--dry-run returns the existing record for a duplicate registration', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);
    const res = await run(projectAdd, [a], { 'dry-run': true });
    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, data: { dryRun: true, alreadyExisted: true, project: { path: a } } });
  });

  it('reports failures as envelopes with a mandatory hint', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const dup = await run(projectAdd, [a], { name: 'different' });
    const missing = await run(projectAdd, [join(sandbox, 'nope')]);
    const file = join(sandbox, 'file.txt');
    writeFileSync(file, 'x');
    const notDir = await run(projectAdd, [file]);

    expect(dup.json[0]?.error).toMatchObject({ code: 'KB_PROJECT_ALREADY_REGISTERED' });
    expect(missing.json[0]?.error).toMatchObject({ code: 'KB_PROJECT_PATH_NOT_FOUND' });
    expect(notDir.json[0]?.error).toMatchObject({ code: 'KB_PROJECT_NOT_A_DIRECTORY' });
    for (const r of [dup, missing, notDir]) {
      expect(r.code).toBe(1);
      expect(r.json[0]?.error?.hint.length).toBeGreaterThan(0);
    }
  });

  // case: S-124.14
  it('returns the existing project for the same canonical path', async () => {
    const a = makeProject('idempotent-add', true);
    const first = await run(projectAdd, [a]);
    const second = await run(projectAdd, [a]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.json[0]).toMatchObject({
      ok: true,
      data: { alreadyExisted: true, project: { path: a } },
    });
  });

  it('surfaces a corrupt registry as KB_PROJECT_REGISTRY_CORRUPT without redacting the file into nothing', async () => {
    mkdirSync(kbHome, { recursive: true });
    writeFileSync(join(kbHome, 'projects.json'), '{ nope');
    const res = await run(projectList, []);
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_REGISTRY_CORRUPT');
  });

  it('prints the message and hint for humans', async () => {
    const res = await run(projectAdd, [join(sandbox, 'nope')], { json: false });
    expect(res.code).toBe(1);
    const out = res.text.join('\n');
    expect(out).toContain('KB_PROJECT_PATH_NOT_FOUND');
    expect(out).toContain('Hint:');
  });
});

describe('project show', () => {
  it('does not print human text beside project show JSON output', async () => {
    const project = makeProject('show-json', true);
    const added = await run(projectAdd, [project]);
    const id = dataOf(added.json[0])?.project?.id ?? '';

    const shown = await run(projectShow, [id]);

    expect(shown.code).toBe(0);
    expect(shown.json).toHaveLength(1);
    expect(shown.text).toEqual([]);
  });

  it('finds a project by name, id, path and the current folder', async () => {
    const a = makeProject('alpha', true);
    const added = await run(projectAdd, [a]);
    const id = dataOf(added.json[0])?.project?.id ?? '';

    for (const ref of ['alpha', id, a]) {
      const res = await run(projectShow, [ref]);
      expect(res.code).toBe(0);
      expect(dataOf(res.json[0])?.project?.path).toBe(a);
    }
    cwd = a;
    const here = await run(projectShow, []);
    expect(dataOf(here.json[0])?.project?.id).toBe(id);
  });

  it('reports an unknown project (e.g. a moved folder) with a hint to add it', async () => {
    const res = await run(projectShow, ['ghost']);
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_UNKNOWN');
    expect(res.json[0]?.error?.hint).toContain('kb project add');
  });

  // case: S-204.7
  it('does not infer the current project from an unregistered repository', async () => {
    const unregistered = makeProject('unregistered', true);
    writeFileSync(join(unregistered, '.kb', 'kb.config.json'), '{}');
    cwd = unregistered;

    const res = await run(projectShow, []);

    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_UNKNOWN');
    expect(res.json[0]?.error?.hint).toContain('kb project add');
    expect(readdirSync(unregistered).sort()).toEqual(['.kb']);
  });
});

describe('project remove', () => {
  it('asks for confirmation first (ADR-0025) and removes nothing without --yes', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha']);

    expect(res.code).toBe(1);
    expect(res.json[0]).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_CONFIRMATION_REQUIRED',
        details: { action: 'project remove', reversible: 'true', confirmWith: '--yes' },
      },
    });
    expect(dataOf((await run(projectList, [])).json[0])?.projects).toHaveLength(1);
  });

  it('--dry-run reports the plan and changes nothing', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha'], { 'dry-run': true });

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(dataOf((await run(projectList, [])).json[0])?.projects).toHaveLength(1);
  });

  it('--yes unregisters the project but never deletes files', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha'], { yes: true });

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, data: expect.anything() });
    expect(dataOf((await run(projectList, [])).json[0])?.projects).toEqual([]);
    expect(existsSync(join(a, '.kb'))).toBe(true);
  });

  it('reports an unknown project before asking for confirmation', async () => {
    const res = await run(projectRemove, ['ghost']);
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_UNKNOWN');
  });
});
