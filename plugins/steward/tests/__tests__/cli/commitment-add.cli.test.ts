import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addCommitment: vi.fn(),
}));

import { addCommitment } from '../../../src/core/index.js';
import command from '../../../src/commands/commitment-add.js';

const mockedAddCommitment = vi.mocked(addCommitment);

beforeEach(() => {
  mockedAddCommitment.mockReset();
});

describe('steward:commitment.add', () => {
  it('records a commitment and parses the ISO reminder date', async () => {
    mockedAddCommitment.mockResolvedValue({
      id: 'cmt_1',
      text: 'Send X',
      personId: 'per_1',
      status: 'open',
      staleAfterDays: 14,
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ flags: { text: 'Send X', person: 'per_1', 'remind-at': '2026-09-01' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Send X', personId: 'per_1', staleAfterDays: 14 }),
    );
    expect(captured.infos[0]?.message).toContain('Send X');
  });

  it('an invalid --remind-at date is a validation error via handleError', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ flags: { text: 'Send X', 'remind-at': 'not-a-date' } }),
    );

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('missing --text is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddCommitment).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
