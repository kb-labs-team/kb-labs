import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/registry-http.js', () => ({
  registryPost: vi.fn(),
}));

import { registryPost } from '../../../src/registry-http.js';
import yankCommand from '../../../src/commands/yank.js';

const mockedPost = vi.mocked(registryPost);

beforeEach(() => {
  vi.resetAllMocks();
  mockedPost.mockResolvedValue(undefined);
});

describe('marketplace:yank', () => {
  it('YK-01: yanks version successfully, prints confirmation', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin', '1.0.0'],
      flags: {},
    }));

    expect(result).toBeUndefined();
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/kirill/my-plugin/1.0.0/yank',
      expect.any(Object),
    );
    expect(captured.success[0]?.message).toContain('1.0.0');
    expect(captured.success[0]?.message).toContain('yanked');
  });

  it('YK-02: --reason passed to registry', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin', '1.0.0'],
      flags: { reason: 'security fix' },
    }));

    expect(mockedPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'security fix' }),
    );
  });

  it('YK-03: --json outputs structured result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin', '1.0.0'],
      flags: { json: true },
    }));

    expect(result).toEqual({ yanked: true, pkg: 'kb:kirill/my-plugin', version: '1.0.0' });

  });

  it('YK-04: missing pkg — exitCode 1, no HTTP call', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('YK-05: missing version — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('YK-06: non-kb: spec — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['my-plugin', '1.0.0'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('YK-07: invalid kb: spec (no slash) — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:noslash', '1.0.0'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
  });

  it('YK-08: HTTP error — exitCode 1, error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Registry failed (404): version not found'));
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await yankCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin', '9.9.9'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
