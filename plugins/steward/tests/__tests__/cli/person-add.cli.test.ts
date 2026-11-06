import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addPerson: vi.fn(),
}));

import { addPerson } from '../../../src/core/index.js';
import command from '../../../src/commands/person-add.js';

const mockedAddPerson = vi.mocked(addPerson);

beforeEach(() => {
  mockedAddPerson.mockReset();
});

describe('steward:person.add', () => {
  it('adds a person and forwards parsed topics', async () => {
    mockedAddPerson.mockResolvedValue({
      person: { id: 'per_1', name: 'Ivanov', contacts: [], globalTopics: ['frontend'], createdAt: 1, updatedAt: 1 },
      possibleDuplicates: [],
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { name: 'Ivanov', topics: 'frontend, architecture' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddPerson).toHaveBeenCalledWith({
      name: 'Ivanov',
      contacts: [],
      companyId: undefined,
      globalTopics: ['frontend', 'architecture'],
    });
    expect(captured.infos[0]?.message).toContain('Ivanov');
    expect(captured.warnings).toEqual([]);
  });

  it('warns (not errors) on a possible duplicate', async () => {
    mockedAddPerson.mockResolvedValue({
      person: { id: 'per_2', name: 'Ivanov', contacts: [], globalTopics: [], createdAt: 1, updatedAt: 1 },
      possibleDuplicates: [{ id: 'per_1', name: 'Ivanov', contacts: [], globalTopics: [], createdAt: 0, updatedAt: 0 }],
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { name: 'Ivanov' } }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.warnings.length).toBeGreaterThan(0);
    expect(captured.errors).toEqual([]);
  });

  it('missing --name is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddPerson).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
