import { describe, expect, it, vi } from 'vitest';
import {
  createMockPluginContextV3,
  createInfraApiMocks,
  testCommand,
} from '@kb-labs/sdk/testing';
import prepareInfraCommand from '../../src/cli/commands/prepare-infra.js';
import captureSnapshotCommand from '../../src/cli/commands/capture-snapshot.js';
import restoreSnapshotCommand from '../../src/cli/commands/restore-snapshot.js';

describe('infra-worker commands', () => {
  it('prepare should materialize workspace and return IDs', async () => {
    const { ctx, cleanup } = createMockPluginContextV3();

    vi.mocked(ctx.api.workspace.materialize).mockResolvedValue({
      workspaceId: 'ws_custom_1',
      provider: 'mock',
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rootPath: '/tmp/ws_custom_1',
    });

    const result = await prepareInfraCommand.execute(ctx, {
      argv: [],
      flags: {
        'source-ref': 'repo://main',
        'base-path': '/workspace/main',
      },
    });

    expect(result).toEqual({
      workspaceId: 'ws_custom_1',
      environmentId: undefined,
      snapshotId: undefined,
    });
    expect(ctx.api.workspace.materialize).toHaveBeenCalledWith({
      sourceRef: 'repo://main',
      basePath: '/workspace/main',
    });
    expect(ctx.api.environment.create).not.toHaveBeenCalled();
    expect(ctx.api.snapshot.capture).not.toHaveBeenCalled();

    cleanup();
  });

  it('prepare should provision env, attach workspace and capture snapshot when requested', async () => {
    const { ctx, cleanup } = createMockPluginContextV3();
    const infra = createInfraApiMocks();

    vi.mocked(ctx.api.workspace.materialize).mockImplementation(infra.workspace.materialize);
    vi.mocked(ctx.api.environment.create).mockImplementation(infra.environment.create);
    vi.mocked(ctx.api.workspace.attach).mockImplementation(infra.workspace.attach);
    vi.mocked(ctx.api.snapshot.capture).mockImplementation(infra.snapshot.capture);

    const result = await prepareInfraCommand.execute(ctx, {
      argv: [],
      flags: {
        'create-environment': true,
        'template-id': 'node20',
        'ttl-ms': 600000,
        'capture-snapshot': true,
        namespace: 'runs/main',
      },
    });

    expect(result.workspaceId).toBeDefined();
    expect(result.environmentId).toBeDefined();
    expect(result.snapshotId).toBeDefined();
    expect(ctx.api.environment.create).toHaveBeenCalled();
    expect(ctx.api.workspace.attach).toHaveBeenCalled();
    expect(ctx.api.snapshot.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.any(String),
        environmentId: expect.any(String),
        namespace: 'runs/main',
      })
    );

    cleanup();
  });

  it('capture-snapshot should run through sdk/testing harness', async () => {
    const result = await testCommand(captureSnapshotCommand, {
      flags: {
        'workspace-id': 'ws_123',
        'environment-id': 'env_456',
        namespace: 'ns/demo',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toEqual({ snapshotId: 'snap_mock_1' });
    expect(result.ctx.api.snapshot.capture).toHaveBeenCalledWith({
      workspaceId: 'ws_123',
      environmentId: 'env_456',
      namespace: 'ns/demo',
      sourcePath: undefined,
    });

    result.cleanup();
  });

  it('restore-snapshot should fail when snapshotId is missing', async () => {
    const { ctx, cleanup } = createMockPluginContextV3();

    await expect(
      restoreSnapshotCommand.execute(ctx, {
        argv: [],
        flags: {},
      })
    ).rejects.toThrow('Missing required flag: --snapshot-id');

    cleanup();
  });
});
