import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/registry-http.js', () => ({
  registryPost: vi.fn(),
}));

import { registryPost } from '../../../src/registry-http.js';
import shareCommand from '../../../src/commands/share.js';

const mockedPost = vi.mocked(registryPost);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('marketplace:share', () => {
  it('SH-01: --with adds handle to allowlist, shows success', async () => {
    mockedPost.mockResolvedValue(undefined);
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { with: 'bob' },
    }));

    expect(result).toBeUndefined();
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/kirill/my-plugin/share/allowlist',
      expect.objectContaining({ namespaceId: 'bob' }),
    );
    expect(captured.success[0]?.message).toContain('bob');
  });

  it('SH-02: --link generates share token, shows install command with --token', async () => {
    mockedPost.mockResolvedValue({
      token: 'kbrt_abc123',
      pkg: 'kirill/my-plugin',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { link: true },
    }));

    expect(result).toEqual({
      token: 'kbrt_abc123',
      pkg: 'kirill/my-plugin',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(captured.errors).toHaveLength(0);
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/kirill/my-plugin/share/token',
      expect.objectContaining({ ttlDays: 7 }),
    );
    expect(captured.success[0]?.message).toContain('Share link');
    expect(captured.success[0]?.opts?.summary?.['Token']).toBe('kbrt_abc123');
  });

  it('SH-03: --link --ttl 14 passes ttlDays=14', async () => {
    mockedPost.mockResolvedValue({ token: 'kbrt_x', pkg: 'kirill/my-plugin', expiresAt: '' });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { link: true, ttl: '14' },
    }));

    expect(mockedPost).toHaveBeenCalledWith(
      expect.stringContaining('/packages/kirill/my-plugin/share/token'),
      expect.objectContaining({ ttlDays: 14 }),
    );
  });

  it('SH-04: --link --json outputs JSON token', async () => {
    const tokenResult = { token: 'kbrt_abc', pkg: 'kirill/my-plugin', expiresAt: '' };
    mockedPost.mockResolvedValue(tokenResult);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { link: true, json: true },
    }));

    expect(result).toMatchObject({ token: 'kbrt_abc' });
  });

  it('SH-05: missing package arg — exitCode 1, no HTTP call', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('SH-06: missing --with and --link — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('SH-07: invalid kb: spec (missing slash) — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:no-slash'],
      flags: { with: 'bob' },
    }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('SH-08: non-kb: spec — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['my-plugin'],
      flags: { with: 'bob' },
    }));

    expect(result).toMatchObject({ ok: false });
  });

  it('SH-09: HTTP error — exitCode 1, error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Registry /share failed (403): Forbidden'));
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await shareCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { with: 'bob' },
    }));

    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
