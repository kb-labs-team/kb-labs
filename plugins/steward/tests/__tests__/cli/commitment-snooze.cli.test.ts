import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  commitmentSnooze: vi.fn(),
}));

import { commitmentSnooze } from '../../../src/core/index.js';
import command from '../../../src/commands/commitment-snooze.js';

const mockedCommitmentSnooze = vi.mocked(commitmentSnooze);

beforeEach(() => {
  mockedCommitmentSnooze.mockReset();
});

describe('steward:commitment.snooze', () => {
  it('snoozes a commitment, parsing the ISO date', async () => {
    mockedCommitmentSnooze.mockResolvedValue({
      id: 'cmt_1',
      text: 'Send X',
      status: 'open',
      staleAfterDays: 14,
      snoozedUntil: Date.parse('2026-09-15'),
      createdAt: 1,
      updatedAt: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['cmt_1'], flags: { until: '2026-09-15', reason: 'Waiting on client' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedCommitmentSnooze).toHaveBeenCalledWith({
      id: 'cmt_1',
      until: Date.parse('2026-09-15'),
      reason: 'Waiting on client',
    });
    expect(captured.infos[0]?.message).toContain('Send X');
  });

  it('not found — NOT_FOUND', async () => {
    mockedCommitmentSnooze.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['missing'], flags: { until: '2026-09-15' } }),
    );

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    }
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('missing --until is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['cmt_1'] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedCommitmentSnooze).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
