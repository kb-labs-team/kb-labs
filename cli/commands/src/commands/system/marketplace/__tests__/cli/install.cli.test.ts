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
import installCommand from '../../commands/install.js';

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

describe('marketplace:install', () => {
  it('CI-01: installs package successfully, prints success message', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'my-plugin', version: '1.0.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('install');
  });

  it('CI-02: --json flag outputs JSON result', async () => {
    const installResult = {
      installed: [{ id: 'my-plugin', version: '1.0.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    };
    mockedPost.mockResolvedValue(installResult);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { json: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ installed: expect.any(Array) });
  });

  it('CI-03: HTTP error — returns exitCode 1 with error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Marketplace /packages/install failed (500): Internal error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['bad-pkg'], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it.each([false, true])('renders KB_PLUGIN_NOT_FOUND through the shared presenter (json=%s)', async (json) => {
    const envelope = {
      code: 'KB_PLUGIN_NOT_FOUND',
      message: 'Plugin @kb-labs/not-published was not found in the registry.',
      hint: 'kb marketplace search',
    };
    mockedPost.mockRejectedValue(Object.assign(new Error(envelope.message), { envelope }));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({
      argv: ['@kb-labs/not-published'],
      flags: { json },
    }));

    expect(result).toHaveProperty('ok', false);
    if (json) {
      expect(result).toMatchObject({ ok: false, error: envelope });
    } else {
      expect(result).toMatchObject({ ok: false, error: envelope });
      expect(captured.errors).toHaveLength(0);
      expect(captured.json).toHaveLength(0);
    }
  });

  it('CI-04: missing argv — returns exitCode 1, validation error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CI-05: scope resolution failure — returns exitCode 1', async () => {
    const { CliScopeError } = await import('../../scope.js');
    mockedResolveCliScope.mockRejectedValue(
      new CliScopeError('SCOPE_PROJECT_ROOT_NOT_FOUND', 'No .kb/kb.config.json found'),
    );

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['pkg'], flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CI-06: installs with --dev flag — passes dev:true to HTTP', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'dev-plugin', version: '0.1.0', primaryKind: 'plugin' }],
      warnings: [],
      scope: 'project',
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['dev-plugin'], flags: { dev: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/install',
      expect.objectContaining({ dev: true, specs: ['dev-plugin'] }),
    );
  });

  it('CI-07: warnings present — success still returned, result includes warnings', async () => {
    mockedPost.mockResolvedValue({
      installed: [{ id: 'pkg', version: '1.0.0', primaryKind: 'plugin' }],
      warnings: ['Peer dependency mismatch'],
      scope: 'project',
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['pkg'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect((result as { warnings: string[] }).warnings).toContain('Peer dependency mismatch');
  });

  it('CI-08: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await installCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('my-plugin');
  });
});
