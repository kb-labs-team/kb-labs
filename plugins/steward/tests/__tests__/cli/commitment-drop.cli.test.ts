import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  commitmentDrop: vi.fn(),
}));

import { commitmentDrop } from '../../../src/core/index.js';
import command from '../../../src/commands/commitment-drop.js';

const mockedCommitmentDrop = vi.mocked(commitmentDrop);

beforeEach(() => {
  mockedCommitmentDrop.mockReset();
});

describe('steward:commitment.drop', () => {
  it('drops a commitment with a reason', async () => {
    mockedCommitmentDrop.mockResolvedValue({
      id: 'cmt_1',
      text: 'Send X',
      status: 'dropped',
      staleAfterDays: 14,
      createdAt: 1,
      updatedAt: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['cmt_1'], flags: { reason: 'No longer relevant' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedCommitmentDrop).toHaveBeenCalledWith({ id: 'cmt_1', reason: 'No longer relevant' });
    expect(captured.infos[0]?.message).toContain('No longer relevant');
  });

  it('not found — NOT_FOUND', async () => {
    mockedCommitmentDrop.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['missing'], flags: { reason: 'x' } }),
    );

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    }
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('missing --reason is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['cmt_1'] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedCommitmentDrop).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
