import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listCompanies: vi.fn(),
}));

import { listCompanies } from '../../../src/core/index.js';
import command from '../../../src/commands/company-list.js';

const mockedListCompanies = vi.mocked(listCompanies);

beforeEach(() => {
  mockedListCompanies.mockReset();
});

describe('steward:company.list', () => {
  it('lists companies', async () => {
    mockedListCompanies.mockResolvedValue([{ id: 'co_1', name: 'Acme Corp', createdAt: 1, updatedAt: 1 }]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('prints a friendly message with no companies', async () => {
    mockedListCompanies.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.infos[0]?.message).toMatch(/no companies/i);
  });
});
