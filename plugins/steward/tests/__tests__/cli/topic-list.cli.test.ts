import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listTopics: vi.fn(),
}));

import { listTopics } from '../../../src/core/index.js';
import command from '../../../src/commands/topic-list.js';

const mockedListTopics = vi.mocked(listTopics);

beforeEach(() => {
  mockedListTopics.mockReset();
});

describe('steward:topic.list', () => {
  it('lists the topic dictionary', async () => {
    mockedListTopics.mockResolvedValue([{ id: 'top_1', name: 'frontend', aliases: [], createdAt: 1, updatedAt: 1 }]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('prints a friendly message with no topics', async () => {
    mockedListTopics.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.infos[0]?.message).toMatch(/no topics/i);
  });
});
