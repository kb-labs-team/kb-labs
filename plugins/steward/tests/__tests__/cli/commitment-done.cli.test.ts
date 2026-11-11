import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  commitmentDone: vi.fn(),
}));

import { commitmentDone } from '../../../src/core/index.js';
import command from '../../../src/commands/commitment-done.js';

const mockedCommitmentDone = vi.mocked(commitmentDone);

beforeEach(() => {
  mockedCommitmentDone.mockReset();
});

describe('steward:commitment.done', () => {
  it('marks a commitment done', async () => {
    mockedCommitmentDone.mockResolvedValue({
      id: 'cmt_1',
      text: 'Send X',
      status: 'done',
      staleAfterDays: 14,
      createdAt: 1,
      updatedAt: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['cmt_1'] }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedCommitmentDone).toHaveBeenCalledWith({ id: 'cmt_1' });
    expect(captured.infos[0]?.message).toContain('Send X');
  });

  it('not found — NOT_FOUND', async () => {
    mockedCommitmentDone.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['missing'] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    }
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('missing id is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedCommitmentDone).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
