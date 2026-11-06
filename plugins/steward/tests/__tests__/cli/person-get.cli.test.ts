import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  getPerson: vi.fn(),
}));

import { getPerson } from '../../../src/core/index.js';
import command from '../../../src/commands/person-get.js';

const mockedGetPerson = vi.mocked(getPerson);

beforeEach(() => {
  mockedGetPerson.mockReset();
});

describe('steward:person.get', () => {
  it('returns a matching person', async () => {
    mockedGetPerson.mockResolvedValue({
      id: 'per_1',
      name: 'Ivanov',
      contacts: [],
      globalTopics: ['frontend'],
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['Ivanov'] }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos[0]?.message).toContain('Ivanov');
  });

  it('not found — NOT_FOUND', async () => {
    mockedGetPerson.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['missing'] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    }
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('missing idOrName is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedGetPerson).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
