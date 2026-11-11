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

// Mock fs/path to control config file reading
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { post } from '../../http.js';
import { resolveCliScope, scopeBody } from '../../scope.js';
import * as fsPromises from 'node:fs/promises';
import syncCommand from '../../commands/sync.js';

const mockedPost = vi.mocked(post);
const mockedResolveCliScope = vi.mocked(resolveCliScope);
const mockedScopeBody = vi.mocked(scopeBody);
const mockedReadFile = vi.mocked(fsPromises.readFile);

const DEFAULT_SCOPE_CTX = { scope: 'project' as const, projectRoot: '/workspace', reason: 'auto-detect' as const };
const DEFAULT_SCOPE_BODY = { scope: 'project' as const, projectRoot: '/workspace' };

/** Return a config that has a valid sync.include to pass validation. */
function mockValidSyncConfig(): void {
  mockedReadFile.mockResolvedValueOnce(
    JSON.stringify({
      marketplace: { sync: { include: ['plugins/*'] } },
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedResolveCliScope.mockResolvedValue(DEFAULT_SCOPE_CTX);
  mockedScopeBody.mockReturnValue(DEFAULT_SCOPE_BODY);
  // Default: config not found — readFile throws ENOENT
  mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
});

describe('marketplace:sync', () => {
  it('CS-01: syncs new entries, prints success message', async () => {
    mockValidSyncConfig();
    mockedPost.mockResolvedValue({
      added: [{ id: 'my-plugin', primaryKind: 'plugin', version: '1.0.0' }],
      skipped: [],
      total: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Synced');
  });

  it('CS-02: nothing new added — prints info "up to date"', async () => {
    mockValidSyncConfig();
    mockedPost.mockResolvedValue({ added: [], skipped: [], total: 5 });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos.length).toBeGreaterThan(0);
    expect(captured.infos[0]?.message).toContain('up to date');
  });

  it('CS-03: --json flag outputs JSON result', async () => {
    mockValidSyncConfig();
    const syncResult = {
      added: [{ id: 'my-plugin', primaryKind: 'plugin', version: '1.0.0' }],
      skipped: [],
      total: 1,
    };
    mockedPost.mockResolvedValue(syncResult);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ added: expect.any(Array), total: 1 });
  });

  it('S-179.33: parses slash-star workspace globs in JSONC sync config', async () => {
    mockedReadFile.mockResolvedValueOnce(
      '{ "marketplace": { "sync": { "include": ["plugins/*",], }, }, }',
    );
    mockedPost.mockResolvedValue({ added: [], skipped: [], total: 0 });

    const ctx = createMockContext();
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ include: ['plugins/*'] }));
  });

  it('S-179.34: reports invalid JSONC at its config path', async () => {
    mockedReadFile.mockResolvedValueOnce('{ "marketplace": /* broken */ }');

    const ctx = createMockContext();
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        message: expect.stringContaining('/workspace/.kb/kb.config.jsonc'),
        hint: expect.stringContaining('kb marketplace sync --scope project'),
      },
    });
    expect(result).not.toMatchObject({ error: { message: expect.stringContaining('No marketplace.sync.include') } });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CS-04: HTTP error — returns exitCode 1 with error captured', async () => {
    mockValidSyncConfig();
    mockedPost.mockRejectedValue(new Error('Marketplace /workspace/sync failed (500): Server error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('CS-05: no sync.include configured — returns exitCode 1 with validation error', async () => {
    // readFile returns config WITHOUT marketplace.sync.include
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ marketplace: { sync: {} } }),
    );

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CS-06: scope resolution failure — returns exitCode 1', async () => {
    const { CliScopeError } = await import('../../scope.js');
    mockedResolveCliScope.mockRejectedValue(
      new CliScopeError('SCOPE_PROJECT_ROOT_NOT_FOUND', 'No config found'),
    );

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('CS-07: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await syncCommand.execute(ctx, mockCLIInput({ flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
