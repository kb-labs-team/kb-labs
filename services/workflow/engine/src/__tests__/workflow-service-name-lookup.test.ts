/**
 * Tests for WorkflowService name-based lookup (F8).
 *
 * Problem: workflow files are named with prefixes (e.g. 03-dev-cycle.yml) but
 * the `name:` field inside is just `dev-cycle`.  Before the fix, users had to
 * pass the filename stem as --workflow-id; now they can pass the `name:` value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowService } from '../workflow-service.js';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { PlatformServices } from '@kb-labs/plugin-contracts';

// Minimal cliApi stub — returns no manifest-based workflows so we test the
// standalone (file-based) path only, without pulling in the full registry.
function makeCLIApi(): IEntityRegistry {
  return {
    initialize: async () => {},
    listPlugins: () => [],
    getManifest: () => null,
    getOpenAPISpec: () => null,
    getStudioRegistry: () => ({ widgets: [], pages: [], slots: [] }),
    queryEntities: () => [],
    getEntity: () => null,
    getEntityKinds: () => [],
    snapshot: () => ({ manifests: [], entities: [], version: '0', ts: new Date().toISOString() }),
  } as unknown as IEntityRegistry;
}

function makePlatform(): PlatformServices {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as PlatformServices;
}

const PREFIXED_WORKFLOW = `
name: dev-cycle
version: "1.0.0"
description: Dev-cycle workflow with a numeric filename prefix
on:
  manual: true
jobs:
  run:
    runsOn: local
    steps:
      - name: step
        uses: builtin:shell
        with:
          run: echo ok
`;

describe('WorkflowService.get — name-based lookup (F8)', () => {
  let workspaceRoot: string;
  let service: WorkflowService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'kb-wf-svc-'));
    await mkdir(join(workspaceRoot, '.kb', 'workflows'), { recursive: true });
    service = new WorkflowService({
      cliApi: makeCLIApi(),
      platform: makePlatform(),
      workspaceRoot,
    });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('get() by canonical filename id still works (B-016 unchanged)', async () => {
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', '03-dev-cycle.yml'),
      PREFIXED_WORKFLOW,
      'utf-8',
    );

    const wf = await service.get('03-dev-cycle');
    expect(wf).not.toBeNull();
    expect(wf!.id).toBe('03-dev-cycle');
  });

  it('get() by name: field works when filename has a numeric prefix (F8)', async () => {
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', '03-dev-cycle.yml'),
      PREFIXED_WORKFLOW,
      'utf-8',
    );

    // Before the fix this returned null — user had to know the filename.
    const wf = await service.get('dev-cycle');
    expect(wf).not.toBeNull();
    // Canonical id is still the filename stem (B-016 intact)
    expect(wf!.id).toBe('03-dev-cycle');
    expect(wf!.name).toBe('dev-cycle');
  });

  it('get() returns null when neither filename nor name matches', async () => {
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', '03-dev-cycle.yml'),
      PREFIXED_WORKFLOW,
      'utf-8',
    );

    const wf = await service.get('nonexistent-workflow');
    expect(wf).toBeNull();
  });

  it('get() by name works with plain (non-prefixed) filenames too', async () => {
    // e.g. file is hello.yml, name: hello — both lookups resolve the same entry
    const plain = PREFIXED_WORKFLOW.replace('name: dev-cycle', 'name: hello');
    await writeFile(
      join(workspaceRoot, '.kb', 'workflows', 'hello.yml'),
      plain,
      'utf-8',
    );

    const byId = await service.get('hello');
    const byName = await service.get('hello');
    expect(byId).not.toBeNull();
    expect(byName!.id).toBe(byId!.id);
  });
});
