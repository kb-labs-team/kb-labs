import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  restoreSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
  };
});

import { restoreSnapshot } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import rollbackCommand from '../../../src/cli/commands/rollback.js';

interface RollbackFlags {
  json?: boolean;
  'dry-run'?: boolean;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(restoreSnapshot).mockResolvedValue(undefined);
});

describe('release:rollback', () => {
  it('ROLL-01: restores snapshot and returns a successful command result', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await rollbackCommand.execute(ctx as never, mockCLIInput<RollbackFlags>());

    expect(result).toEqual({ message: 'Rollback completed' });
    expect(restoreSnapshot).toHaveBeenCalledOnce();
  });

  it('ROLL-02: --json outputs structured result', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await rollbackCommand.execute(ctx as never, mockCLIInput<RollbackFlags>({ flags: { json: true } }));

    expect(result).toEqual({ message: 'Rollback completed' });
  });

  it('ROLL-03: --dry-run shows intent, restoreSnapshot is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await rollbackCommand.execute(ctx as never, mockCLIInput<RollbackFlags>({ flags: { 'dry-run': true } }));

    expect(result).toMatchObject({ summary: 'Rollback last release from backup snapshot', operations: expect.any(Array) });
    expect(restoreSnapshot).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
