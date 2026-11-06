import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/registry-http.js', () => ({
  registryPost: vi.fn(),
}));

import { registryPost } from '../../../src/registry-http.js';
import deprecateCommand from '../../../src/commands/deprecate.js';

const mockedPost = vi.mocked(registryPost);

beforeEach(() => {
  vi.resetAllMocks();
  mockedPost.mockResolvedValue(undefined);
});

describe('marketplace:deprecate', () => {
  it('DP-01: deprecates package successfully, prints confirmation', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: {},
    }));

    expect(result).toBeUndefined();
    expect(mockedPost).toHaveBeenCalledWith(
      '/packages/kirill/my-plugin/deprecate',
      expect.any(Object),
    );
    expect(captured.success[0]?.message).toContain('deprecated');
  });

  it('DP-02: --message passed to registry', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { message: 'use v2 instead' },
    }));

    expect(mockedPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'use v2 instead' }),
    );
  });

  it('DP-03: --json outputs structured result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: { json: true },
    }));

    expect(result).toEqual({ deprecated: true, pkg: 'kb:kirill/my-plugin' });

  });

  it('DP-04: missing pkg — exitCode 1, no HTTP call', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({ argv: [], flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('DP-05: non-kb: spec — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['npm-package'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('DP-06: invalid kb: spec (no slash) — exitCode 1', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['kb:noslash'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
  });

  it('DP-07: HTTP error — exitCode 1, error captured', async () => {
    mockedPost.mockRejectedValue(new Error('Registry failed (403): Forbidden'));
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await deprecateCommand.execute(ctx, mockCLIInput({
      argv: ['kb:kirill/my-plugin'],
      flags: {},
    }));

    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
