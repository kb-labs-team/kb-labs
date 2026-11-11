import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  whoToContact: vi.fn(),
}));

import { whoToContact } from '../../../src/core/index.js';
import command from '../../../src/commands/who.js';

const mockedWhoToContact = vi.mocked(whoToContact);

beforeEach(() => {
  mockedWhoToContact.mockReset();
});

describe('steward:who', () => {
  it('finds candidates for a topic, forwarding the project scope', async () => {
    mockedWhoToContact.mockResolvedValue([
      {
        person: { id: 'per_1', name: 'Ivanov', contacts: [], globalTopics: ['frontend'], createdAt: 1, updatedAt: 1 },
        source: 'project',
        priority: 0,
      },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['frontend'], flags: { project: 'prj_1' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedWhoToContact).toHaveBeenCalledWith({ topic: 'frontend', projectId: 'prj_1' });
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('prints a friendly message when nobody matches', async () => {
    mockedWhoToContact.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await command.execute(ctx, mockCLIInput({ argv: ['grafana'] }));

    expect(captured.infos[0]?.message).toMatch(/nobody found/i);
  });

  it('missing topic is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedWhoToContact).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
