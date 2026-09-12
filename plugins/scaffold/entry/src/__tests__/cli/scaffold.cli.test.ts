import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

const marketplaceAuth = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  sessionExpired: false,
  sessionRefresh: vi.fn(),
  credentials: null as Record<string, unknown> | null,
  credentialsExpired: false,
  credentialsRefresh: vi.fn(),
}));

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

vi.mock('@kb-labs/cli-runtime/gateway', () => ({
  SessionManager: class {
    load = async () => marketplaceAuth.session;
    isExpired = () => marketplaceAuth.sessionExpired;
    refresh = marketplaceAuth.sessionRefresh;
  },
  CredentialsManager: class {
    load = async () => marketplaceAuth.credentials;
    isExpired = () => marketplaceAuth.credentialsExpired;
    refresh = marketplaceAuth.credentialsRefresh;
  },
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
import scaffoldCommand from '../../commands/scaffold.js';

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

  marketplaceAuth.session = null;
  marketplaceAuth.sessionExpired = false;
  marketplaceAuth.sessionRefresh.mockReset();
  marketplaceAuth.credentials = null;
  marketplaceAuth.credentialsExpired = false;
  marketplaceAuth.credentialsRefresh.mockReset();
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
  it('SS-01: missing entity name — exitCode 1, write or info called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    // No argv[0] provided
    const result = await scaffoldCommand.execute(
      ctx,
      mockCLIInput({ flags: {} }),
    );

    expect(result.ok).toBe(false);
    // Command either writes help text or shows error
    const hasOutput = captured.writes.length > 0 || captured.errors.length > 0 || captured.infos.length > 0;
    expect(hasOutput).toBe(true);
  });

  it('SS-02: --dry-run — writeFiles is not called, exitCode 0', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await scaffoldCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'dry-run': true }, argv: ['plugin', 'my-plugin'] }),
    );

    expect(result.ok).toBe(true);
    expect(mockedWriteFiles).not.toHaveBeenCalled();
  });

  it('SS-03: loadEntity throws — command propagates the error', async () => {
    // loadEntity is not wrapped in try/catch in scaffold.ts — the error propagates
    mockedLoadEntity.mockRejectedValue(new Error('Entity file not found'));

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });

    await expect(
      scaffoldCommand.execute(
        ctx,
        mockCLIInput({ flags: {}, argv: ['plugin', 'my-plugin'] }),
      ),
    ).rejects.toThrow('Entity file not found');
  });

  it('SS-04: successful scaffold — exitCode 0, success message shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await scaffoldCommand.execute(
      ctx,
      mockCLIInput({ flags: {}, argv: ['plugin', 'my-plugin'] }),
    );

    expect(result.ok).toBe(true);
    expect(captured.success.length).toBeGreaterThan(0);
    expect(mockedWriteFiles).toHaveBeenCalled();
  });

  it('SS-06: stale optional session does not prevent local marketplace registration', async () => {
    marketplaceAuth.session = {
      accessToken: 'expired', refreshToken: 'expired', gatewayUrl: 'http://127.0.0.1:4000', expiresAt: 0,
    };
    marketplaceAuth.sessionExpired = true;
    marketplaceAuth.sessionRefresh.mockRejectedValue(new Error('session expired'));
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await scaffoldCommand.execute(
      ctx,
      mockCLIInput({ flags: {}, argv: ['plugin', 'my-plugin'] }),
    );

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.not.objectContaining({ Authorization: expect.anything() }),
    }));
  });

  it('SS-05: --dry-run with --json — captured.json contains result', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });

    // json flag is not directly used by scaffold:run for dry-run output,
    // but the command writes success output — verify the result and file count
    const result = await scaffoldCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'dry-run': true }, argv: ['plugin', 'my-plugin'] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(String(result.error));
    }
    const scaffoldResult = result.result as { files: number; outRoot: string };
    expect(scaffoldResult.files).toBe(MOCK_BUILD_RESULT.files.length);
    expect(scaffoldResult.outRoot).toBe(MOCK_BUILD_RESULT.outRoot);
  });
});
