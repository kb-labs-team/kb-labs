import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock scaffold-core before importing the command
vi.mock('@kb-labs/scaffold-core', () => ({
  build: vi.fn(),
  inspectTarget: vi.fn(),
  formatTree: vi.fn(),
  listEntities: vi.fn(),
  loadEntity: vi.fn(),
  resolveBlocks: vi.fn(),
  runValidator: vi.fn(),
  writeFiles: vi.fn(),
}));

// Mock shared-cli-ui to prevent ESM issues with formatCommandHelp
vi.mock('@kb-labs/shared-cli-ui', () => ({
  formatCommandHelp: vi.fn(() => 'scaffold help text'),
}));

import {
  build,
  inspectTarget,
  formatTree,
  listEntities,
  loadEntity,
  resolveBlocks,
  runValidator,
  writeFiles,
} from '@kb-labs/scaffold-core';
import type { BuildResult, TargetState, ResolveResult } from '@kb-labs/scaffold-core';
import type { EntityDefinition } from '@kb-labs/scaffold-contracts';
import { scaffoldRun } from '../../commands/scaffold.js';

const mockedListEntities = vi.mocked(listEntities);
const mockedLoadEntity = vi.mocked(loadEntity);
const mockedBuild = vi.mocked(build);
const mockedInspectTarget = vi.mocked(inspectTarget);
const mockedFormatTree = vi.mocked(formatTree);
const mockedResolveBlocks = vi.mocked(resolveBlocks);
const mockedRunValidator = vi.mocked(runValidator);
const mockedWriteFiles = vi.mocked(writeFiles);

// Minimal entity fixture
const MOCK_ENTITY = {
  id: 'plugin',
  name: 'Plugin',
  description: 'A KB Labs plugin',
  variables: [],
  blocks: [{ id: 'core', name: 'Core', variables: [], files: [] }],
  defaults: { blocks: ['core'] },
};

// Minimal build result
const MOCK_BUILD_RESULT = {
  outRoot: '/tmp/test-output/my-plugin',
  files: [
    { path: 'package.json', content: '{}' },
    { path: 'src/index.ts', content: '' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(''),
    json: vi.fn().mockResolvedValue({ id: 'demo', scope: 'project' }),
  }));

  // Default happy-path mocks
  mockedListEntities.mockResolvedValue(['plugin', 'adapter']);
  mockedLoadEntity.mockResolvedValue(MOCK_ENTITY as unknown as EntityDefinition);
  mockedBuild.mockResolvedValue(MOCK_BUILD_RESULT as unknown as BuildResult);
  mockedInspectTarget.mockResolvedValue({ exists: false, empty: true } as unknown as TargetState);
  mockedFormatTree.mockReturnValue('package.json\nsrc/index.ts');
  mockedResolveBlocks.mockReturnValue(undefined as unknown as ResolveResult);
  mockedRunValidator.mockReturnValue(null);
  mockedWriteFiles.mockResolvedValue(undefined);
});

describe('scaffold:run', () => {
  it('SS-01: missing entity name — exits with an error and does not write files', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    // No argv[0] provided
    const exitCode = await scaffoldRun.run(ctx, [], { json: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(mockedWriteFiles).not.toHaveBeenCalled();
  });

  it('SS-02: --dry-run — writeFiles is not called, exitCode 0', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const exitCode = await scaffoldRun.run(ctx, ['plugin', 'my-plugin'], { 'dry-run': true, json: true });

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({
      ok: true,
      data: { outRoot: MOCK_BUILD_RESULT.outRoot, files: MOCK_BUILD_RESULT.files.length },
    });
    expect(mockedWriteFiles).not.toHaveBeenCalled();
  });

  it('SS-03: loadEntity throws — command boundary reports a sanitized error', async () => {
    mockedLoadEntity.mockRejectedValue(new Error('Entity file not found'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const exitCode = await scaffoldRun.run(ctx, ['plugin', 'my-plugin'], { json: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
    expect(JSON.stringify(captured.json)).not.toContain('Entity file not found');
  });

  it('SS-04: successful scaffold — exitCode 0, success message shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const exitCode = await scaffoldRun.run(ctx, ['plugin', 'my-plugin'], {});

    expect(exitCode).toBe(0);
    expect(captured.success.length).toBeGreaterThan(0);
    expect(mockedWriteFiles).toHaveBeenCalledWith(expect.objectContaining({
      outRoot: MOCK_BUILD_RESULT.outRoot,
      files: MOCK_BUILD_RESULT.files,
    }));
  });

  it('prints an explicit marketplace plugins add step after generating files', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const exitCode = await scaffoldRun.run(ctx, ['plugin', 'my-plugin'], {});

    expect(exitCode).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(captured.success)).toContain('kb marketplace plugins add --link');
  });

  it('SS-05: --dry-run returns the plain scaffold result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const exitCode = await scaffoldRun.run(ctx, ['plugin', 'my-plugin'], { 'dry-run': true, json: true });

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({
      ok: true,
      data: { files: MOCK_BUILD_RESULT.files.length, outRoot: MOCK_BUILD_RESULT.outRoot },
    });
  });
});
