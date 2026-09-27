import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

vi.mock('../../http.js', () => ({
  post: vi.fn(),
}));

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

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(),
  default: { unlink: vi.fn() },
}));

import { post } from '../../http.js';
import { resolveCliScope, scopeBody } from '../../scope.js';
import enableCommand from '../../commands/plugins/enable.js';
import disableCommand from '../../commands/plugins/disable.js';
import linkCommand from '../../commands/plugins/link.js';
import unlinkCommand from '../../commands/plugins/unlink.js';

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

describe('marketplace:plugins:enable', () => {
  it('PE-01: enables plugin successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await enableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result.ok).toBe(true);
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PE-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await enableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result.ok).toBe(true);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('my-plugin');
  });
});

describe('marketplace:plugins:disable', () => {
  it('PD-01: disables plugin successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await disableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result.ok).toBe(true);
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PD-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await disableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result.ok).toBe(true);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});

describe('marketplace:plugins:link', () => {
  it('PL-01: links local plugin successfully', async () => {
    mockedPost.mockResolvedValue({ id: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await linkCommand.execute(ctx, mockCLIInput({ argv: ['/path/to/plugin'], flags: {} }));

    expect(result.ok).toBe(true);
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PL-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await linkCommand.execute(ctx, mockCLIInput({ argv: ['/path/to/plugin'], flags: { 'dry-run': true } }));

    expect(result.ok).toBe(true);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});

describe('marketplace:plugins:unlink', () => {
  it('PU-01: unlinks plugin successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await unlinkCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result.ok).toBe(true);
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PU-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await unlinkCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result.ok).toBe(true);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
