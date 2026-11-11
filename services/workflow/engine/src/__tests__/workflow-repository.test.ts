/**
 * Tests for WorkflowRepository — file-based standalone workflow storage.
 *
 * Focus: the id reported by list() must be the same id get() resolves, so that
 * a workflow shown in GET /workflows can always be run via POST /workflows/:id/runs
 * (B-016).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRepository } from '../workflow-repository.js';
import type { PlatformServices } from '@kb-labs/plugin-contracts';

function makePlatform(): PlatformServices {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as PlatformServices;
}

// NB: explicit `id:` inside the file that DIFFERS from the filename. This is
// what triggered B-016 — list() reported the inner id while get() resolved by
// filename, so the listed workflow 404'd on POST /runs.
const SIMPLE_WORKFLOW = `
id: hello-world
name: hello-world
version: "1.0.0"
on:
  manual: true
jobs:
  greet:
    runsOn: local
    steps:
      - name: say
        uses: builtin:shell
        with:
          run: echo hi
`;

describe('WorkflowRepository — id consistency (B-016)', () => {
  let workspaceRoot: string;
  let repo: WorkflowRepository;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'kb-wf-repo-'));
    await mkdir(join(workspaceRoot, '.kb', 'workflows'), { recursive: true });
    repo = new WorkflowRepository({ platform: makePlatform(), workspaceRoot });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('list() id matches the filename and get(id) resolves it', async () => {
    // File name differs from the `id:`/`name:` inside — the filename is the
    // canonical identity for file-based workflows.
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'hello.yaml'),
      SIMPLE_WORKFLOW,
      'utf-8',
    );

    const list = await repo.list();
    expect(list).toHaveLength(1);
    const listedId = list[0]!.id;

    // The id shown in the list MUST be runnable via get().
    const fetched = await repo.get(listedId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(listedId);

    // Filename is canonical — id is "hello", not the inner "hello-world".
    expect(listedId).toBe('hello');
  });

  it('get() by a content-only id that has no matching file returns null', async () => {
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'hello.yaml'),
      SIMPLE_WORKFLOW,
      'utf-8',
    );

    // "hello-world" is the inner name but not a filename → not resolvable.
    const fetched = await repo.get('hello-world');
    expect(fetched).toBeNull();
  });
});

describe('WorkflowRepository — invalid spec rejection (B-015)', () => {
  let workspaceRoot: string;
  let repo: WorkflowRepository;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'kb-wf-repo-'));
    await mkdir(join(workspaceRoot, '.kb', 'workflows'), { recursive: true });
    repo = new WorkflowRepository({ platform: makePlatform(), workspaceRoot });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('an incomplete workflow YAML (no jobs) is not listed as active', async () => {
    // Mirrors QA bad.yaml: only id + name, no jobs. Must NOT appear as a valid
    // active workflow — that is a silent acceptance of a broken file (B-015).
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'bad.yaml'),
      'id: bad-workflow\nname: bad-workflow\n',
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'good.yaml'),
      SIMPLE_WORKFLOW,
      'utf-8',
    );

    const list = await repo.list();
    const ids = list.map((w) => w.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
  });

  it('get() on an invalid workflow file returns null', async () => {
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'bad.yaml'),
      'id: bad-workflow\nname: bad-workflow\n',
      'utf-8',
    );
    expect(await repo.get('bad')).toBeNull();
  });
});
