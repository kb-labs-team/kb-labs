import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listPeople: vi.fn(),
}));

import { listPeople } from '../../../src/core/index.js';
import command from '../../../src/commands/person-list.js';

const mockedListPeople = vi.mocked(listPeople);

beforeEach(() => {
  mockedListPeople.mockReset();
});

describe('steward:person.list', () => {
  it('lists every contact', async () => {
    mockedListPeople.mockResolvedValue([
      { id: 'per_1', name: 'Ivanov', contacts: [], globalTopics: [], createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('--json emits the raw array', async () => {
    mockedListPeople.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toEqual([]);
  });

  it('prints a friendly message with no contacts', async () => {
    mockedListPeople.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.infos[0]?.message).toMatch(/no contacts/i);
  });
});
