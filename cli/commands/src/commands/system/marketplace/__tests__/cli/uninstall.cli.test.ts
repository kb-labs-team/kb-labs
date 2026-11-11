import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

// Mock HTTP client before importing the command
vi.mock('../../http.js', () => ({
  post: vi.fn(),
}));

// Mock scope resolution to avoid filesystem walks
vi.mock('../../scope.js', () => ({
  resolveCliScope: vi.fn(),
  scopeBody: vi.fn(),
  CliScopeError: class CliScopeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'CliScopeError';
    }
  },
}));

import { post } from '../../http.js';
import { resolveCliScope, scopeBody } from '../../scope.js';
import uninstallCommand from '../../commands/uninstall.js';

const mockedPost = vi.mocked(post);
const mockedResolveCliScope = vi.mocked(resolveCliScope);
const mockedScopeBody = vi.mocked(scopeBody);

const DEFAULT_SCOPE_CTX = { scope: 'project' as const, projectRoot: '/workspace', reason: 'auto-detect' as const };
const DEFAULT_SCOPE_BODY = { scope: 'project' as const, projectRoot: '/workspace' };

beforeEach(() => {
  vi.resetAllMocks();
  mockedResolveCliScope.mockResolvedValue(DEFAULT_SCOPE_CTX);
  mockedScopeBody.mockReturnValue(DEFAULT_SCOPE_BODY);
});

describe('marketplace:uninstall', () => {
  it('CU-01: uninstalls package successfully, prints success message', async () => {
    // 204 No Content — post resolves to undefined
    mockedPost.mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('my-plugin');
  });

  it('CU-02: --json flag outputs JSON result', async () => {
    mockedPost.mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { json: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ removed: ['my-plugin'] });
  });

  it('CU-03: HTTP error — returns exitCode 1 with error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Marketplace /packages/uninstall failed (404): Not found'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['missing-pkg'], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('CU-04: missing argv — returns exitCode 1 without calling HTTP', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CU-05: scope resolution failure — returns exitCode 1', async () => {
    const { CliScopeError } = await import('../../scope.js');
    mockedResolveCliScope.mockRejectedValue(
      new CliScopeError('SCOPE_PROJECT_ROOT_NOT_FOUND', 'No config found'),
    );

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['pkg'], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CU-06: result.result contains removed packages and scope', async () => {
    mockedPost.mockResolvedValue(undefined);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['plugin-a', 'plugin-b'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    const uninstallResult = result as { removed: string[]; scope: string };
    expect(uninstallResult.removed).toEqual(['plugin-a', 'plugin-b']);
    expect(uninstallResult.scope).toBe('project');
  });

  it('CU-07: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await uninstallCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
