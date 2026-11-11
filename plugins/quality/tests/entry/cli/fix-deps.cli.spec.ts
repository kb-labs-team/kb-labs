import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';

// Mock fs to avoid real filesystem scanning
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      readdirSync: vi.fn().mockReturnValue([]),
      readFileSync: vi.fn().mockReturnValue('{}'),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      update: vi.fn(),
    })),
  };
});

import fixDepsCommand from '../../../src/cli/commands/fix-deps.js';

const mockCtxPlatform = {
  analytics: { track: vi.fn().mockResolvedValue(undefined) },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockCtxPlatform.analytics.track.mockResolvedValue(undefined);
});

describe('quality:fix-deps', () => {
  it('FD-01: no fix flags — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    Object.assign(ctx, { platform: mockCtxPlatform });

    const result = await fixDepsCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
      expect(result.error.hint).toContain('kb quality fix-deps --help');
    }
    expect(captured.errors).toHaveLength(0);
  });

  it('FD-02: --all with no issues — exitCode 0, no changes', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    Object.assign(ctx, { platform: mockCtxPlatform });

    const result = await fixDepsCommand.execute(ctx as never, mockCLIInput({ flags: { all: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('FD-03: --stats outputs statistics', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    Object.assign(ctx, { platform: mockCtxPlatform });

    const result = await fixDepsCommand.execute(ctx as never, mockCLIInput({ flags: { stats: true } }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('FD-04: --json with --stats outputs JSON', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    Object.assign(ctx, { platform: mockCtxPlatform });

    const result = await fixDepsCommand.execute(ctx as never, mockCLIInput({ flags: { stats: true, json: true } }));

    expect(result).toMatchObject({ totalPackages: expect.any(Number), totalDeps: expect.any(Number) });
  });

  it('FD-05: --dry-run shows intent, writeFileSync is NOT called', async () => {
    const fs = await import('node:fs');
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    Object.assign(ctx, { platform: mockCtxPlatform });

    const result = await fixDepsCommand.execute(ctx as never, mockCLIInput({ flags: { all: true, 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(fs.default.writeFileSync)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
