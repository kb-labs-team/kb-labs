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
import updateCommand from '../../commands/update.js';

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

describe('marketplace:update', () => {
  it('CUP-01: updates packages, prints success message', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'my-plugin', version: '2.0.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Update');
  });

  it('CUP-02: nothing to update — prints info message', async () => {
    mockedPost.mockResolvedValue({ installed: [], warnings: [], scope: 'project' });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos.length).toBeGreaterThan(0);
    expect(captured.infos[0]?.message).toContain('Nothing to update');
  });

  it('CUP-03: --json flag outputs JSON result', async () => {
    const updateResult = {
      installed: [{ id: 'my-plugin', version: '2.0.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    };
    mockedPost.mockResolvedValue(updateResult);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { json: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ installed: expect.any(Array) });
  });

  it('CUP-04: HTTP error — returns exitCode 1 with error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Marketplace /packages/update failed (503): Service unavailable'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: ['pkg'], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('CUP-05: scope resolution failure — returns exitCode 1', async () => {
    const { CliScopeError } = await import('../../scope.js');
    mockedResolveCliScope.mockRejectedValue(
      new CliScopeError('SCOPE_PROJECT_ROOT_NOT_FOUND', 'No config found'),
    );

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CUP-06: update all — no argv, sends request without packageIds', async () => {
    mockedPost.mockResolvedValue({
      installed: [
        { id: 'plugin-a', version: '2.0.0', primaryKind: 'plugin' },
        { id: 'plugin-b', version: '1.5.0', primaryKind: 'adapter' },
      ],
      warnings: [],
      scope: 'project',
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    // No packageIds in body when argv is empty
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/update',
      expect.not.objectContaining({ packageIds: expect.anything() }),
    );
  });

  it('CUP-07: specific packages — sends packageIds in body', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'plugin-a', version: '2.0.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await updateCommand.execute(ctx, mockCLIInput({ argv: ['plugin-a', 'plugin-b'], flags: {} }));

    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/update',
      expect.objectContaining({ packageIds: ['plugin-a', 'plugin-b'] }),
    );
  });

  it('CUP-08: warnings present — result still exitCode 0', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'pkg', version: '2.0.0', primaryKind: 'plugin' }],
      warnings: ['Breaking change in v2.0.0'],
      scope: 'project',
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: ['pkg'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect((result as { warnings: string[] }).warnings).toContain('Breaking change in v2.0.0');
  });

  it('CUP-09: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await updateCommand.execute(ctx, mockCLIInput({ argv: ['plugin-a'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
