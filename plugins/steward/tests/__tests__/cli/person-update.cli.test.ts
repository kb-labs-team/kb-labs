import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  updatePerson: vi.fn(),
}));

import { updatePerson } from '../../../src/core/index.js';
import command from '../../../src/commands/person-update.js';

const mockedUpdatePerson = vi.mocked(updatePerson);

beforeEach(() => {
  mockedUpdatePerson.mockReset();
});

describe('steward:person.update', () => {
  it('updates a contact and forwards parsed topics', async () => {
    mockedUpdatePerson.mockResolvedValue({
      id: 'per_1',
      name: 'Ivanov',
      contacts: [],
      globalTopics: ['backend'],
      createdAt: 1,
      updatedAt: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['per_1'], flags: { topics: 'backend' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedUpdatePerson).toHaveBeenCalledWith({
      id: 'per_1',
      name: undefined,
      globalTopics: ['backend'],
      companyId: undefined,
    });
    expect(captured.infos[0]?.message).toContain('Ivanov');
  });

  it('not found — NOT_FOUND', async () => {
    mockedUpdatePerson.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['missing'], flags: { name: 'X' } }));

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
    expect(mockedUpdatePerson).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
