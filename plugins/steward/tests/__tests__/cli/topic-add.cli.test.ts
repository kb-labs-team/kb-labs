import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addTopic: vi.fn(),
}));

import { addTopic } from '../../../src/core/index.js';
import command from '../../../src/commands/topic-add.js';

const mockedAddTopic = vi.mocked(addTopic);

beforeEach(() => {
  mockedAddTopic.mockReset();
});

describe('steward:topic.add', () => {
  it('registers a topic with parsed aliases', async () => {
    mockedAddTopic.mockResolvedValue({
      id: 'top_1',
      name: 'frontend',
      aliases: ['фронт', 'фронтенд', 'front-end'],
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ flags: { name: 'frontend', aliases: 'фронт,фронтенд,front-end' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddTopic).toHaveBeenCalledWith({ name: 'frontend', aliases: ['фронт', 'фронтенд', 'front-end'] });
    expect(captured.infos[0]?.message).toContain('frontend');
  });

  it('missing --name is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddTopic).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
