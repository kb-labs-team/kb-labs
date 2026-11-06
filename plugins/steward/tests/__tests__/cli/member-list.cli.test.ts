import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listMembers: vi.fn(),
}));

import { listMembers } from '../../../src/core/index.js';
import command from '../../../src/commands/member-list.js';

const mockedListMembers = vi.mocked(listMembers);

beforeEach(() => {
  mockedListMembers.mockReset();
});

describe('steward:member.list', () => {
  it('lists members of a project', async () => {
    mockedListMembers.mockResolvedValue([
      { id: 'mem_1', personId: 'per_1', projectId: 'prj_1', role: 'lead', priority: 0, createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['prj_1'] }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedListMembers).toHaveBeenCalledWith('prj_1');
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('missing projectId is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedListMembers).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
