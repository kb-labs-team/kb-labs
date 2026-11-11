import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listCommitments: vi.fn(),
}));

import { listCommitments } from '../../../src/core/index.js';
import command from '../../../src/commands/commitment-list.js';

const mockedListCommitments = vi.mocked(listCommitments);

beforeEach(() => {
  mockedListCommitments.mockReset();
});

describe('steward:commitment.list', () => {
  it('lists commitments and forwards --stale-only', async () => {
    mockedListCommitments.mockResolvedValue([
      { id: 'cmt_1', text: 'Send X', status: 'open', staleAfterDays: 14, createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { 'stale-only': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedListCommitments).toHaveBeenCalledWith({ status: undefined, projectId: undefined, staleOnly: true });
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('defaults staleOnly to false', async () => {
    mockedListCommitments.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(mockedListCommitments).toHaveBeenCalledWith({ status: undefined, projectId: undefined, staleOnly: false });
    expect(captured.infos[0]?.message).toMatch(/nothing here/i);
  });
});
