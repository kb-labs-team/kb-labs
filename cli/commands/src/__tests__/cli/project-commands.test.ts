/**
 * Tests for `kb project add | list | show | remove`.
 *
 * They run against a real registry file inside a temp KB_HOME and real temp
 * project folders; the real HOME / ~/.kb is never touched.
 */

import { mkdirSync, mkdtempSync, existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  error?: { code: string; hint: string; message: string };
  projects?: Array<{ id: string; name: string; path: string; pathExists: boolean }>;
  project?: { id: string; name: string; path: string };
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
      json: (data: unknown) => {
        json.push(data as Payload);
      },
      write: (t: string) => {
        text.push(t);
      },
      error: (e: unknown) => {
        text.push(String(e));
      },
      warn: (m: string) => {
        text.push(m);
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
    hostContext: { host: 'cli' as const, argv: [], flags: {} },
    trace: noopTraceContext,
  };
  return { ctx, json, text };
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
    expect(addB.json[0]?.project?.name).toBe('second');

    const list = await run(projectList, []);
    expect(list.code).toBe(0);
    expect(list.json[0]?.projects?.map((p) => p.path).sort()).toEqual([a, b].sort());
    expect(existsSync(join(kbHome, 'projects.json'))).toBe(true);
  });

  it('prints a human table when --json is off', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a], { json: false });
    const list = await run(projectList, [], { json: false });
    expect(list.text.join('')).toContain('alpha');
    expect(list.text.join('')).toContain(a);
  });

  it('defaults to the current folder', async () => {
    mkdirSync(join(cwd, '.kb'));
    const res = await run(projectAdd, []);
    expect(res.code).toBe(0);
    expect(res.json[0]?.project?.path).toBe(cwd);
  });

  it('does not create .kb/ silently: returns a typed initializationRequired result and registers nothing', async () => {
    const bare = makeProject('bare', false);

    const res = await run(projectAdd, [bare]);

    expect(res.code).toBe(1);
    expect(res.json[0]).toMatchObject({
      ok: false,
      initializationRequired: true,
      path: bare,
      nextStep: `kb project add ${bare} --init`,
    });
    expect(readdirSync(bare)).toEqual([]);
    expect(existsSync(join(kbHome, 'projects.json'))).toBe(false);
  });

  it('with --init creates the minimal .kb/ and registers the project', async () => {
    const bare = makeProject('bare', false);

    const res = await run(projectAdd, [bare], { init: true });

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, initialized: true });
    expect(existsSync(join(bare, '.kb'))).toBe(true);
    const list = await run(projectList, []);
    expect(list.json[0]?.projects).toHaveLength(1);
  });

  it('--dry-run changes nothing, not even with --init', async () => {
    const bare = makeProject('bare', false);
    const declared = makeProject('declared', true);

    const plain = await run(projectAdd, [declared], { 'dry-run': true });
    const withInit = await run(projectAdd, [bare], { 'dry-run': true, init: true });

    expect(plain.json[0]).toMatchObject({ ok: true, dryRun: true, wouldInitialize: false });
    expect(withInit.json[0]).toMatchObject({ ok: true, dryRun: true, wouldInitialize: true });
    expect(readdirSync(bare)).toEqual([]);
    expect(existsSync(join(kbHome, 'projects.json'))).toBe(false);
  });

  it('--dry-run still reports a duplicate registration', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);
    const res = await run(projectAdd, [a], { 'dry-run': true });
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_ALREADY_REGISTERED');
  });

  it('reports failures as envelopes with a mandatory hint', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const dup = await run(projectAdd, [a]);
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
  it('finds a project by name, id, path and the current folder', async () => {
    const a = makeProject('alpha', true);
    const added = await run(projectAdd, [a]);
    const id = added.json[0]?.project?.id ?? '';

    for (const ref of ['alpha', id, a]) {
      const res = await run(projectShow, [ref]);
      expect(res.code).toBe(0);
      expect(res.json[0]?.project?.path).toBe(a);
    }
    cwd = a;
    const here = await run(projectShow, []);
    expect(here.json[0]?.project?.id).toBe(id);
  });

  it('reports an unknown project (e.g. a moved folder) with a hint to add it', async () => {
    const res = await run(projectShow, ['ghost']);
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_UNKNOWN');
    expect(res.json[0]?.error?.hint).toContain('kb project add');
  });
});

describe('project remove', () => {
  it('asks for confirmation first (ADR-0025) and removes nothing without --yes', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha']);

    expect(res.code).toBe(1);
    expect(res.json[0]).toMatchObject({ confirmationRequired: true, destructive: true, reversible: true });
    expect((await run(projectList, [])).json[0]?.projects).toHaveLength(1);
  });

  it('--dry-run reports the plan and changes nothing', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha'], { 'dry-run': true });

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true, dryRun: true });
    expect((await run(projectList, [])).json[0]?.projects).toHaveLength(1);
  });

  it('--yes unregisters the project but never deletes files', async () => {
    const a = makeProject('alpha', true);
    await run(projectAdd, [a]);

    const res = await run(projectRemove, ['alpha'], { yes: true });

    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ ok: true });
    expect((await run(projectList, [])).json[0]?.projects).toEqual([]);
    expect(existsSync(join(a, '.kb'))).toBe(true);
  });

  it('reports an unknown project before asking for confirmation', async () => {
    const res = await run(projectRemove, ['ghost']);
    expect(res.code).toBe(1);
    expect(res.json[0]?.error?.code).toBe('KB_PROJECT_UNKNOWN');
  });
});
