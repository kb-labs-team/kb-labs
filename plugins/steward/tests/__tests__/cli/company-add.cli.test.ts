import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addCompany: vi.fn(),
}));

import { addCompany } from '../../../src/core/index.js';
import command from '../../../src/commands/company-add.js';

const mockedAddCompany = vi.mocked(addCompany);

beforeEach(() => {
  mockedAddCompany.mockReset();
});

describe('steward:company.add', () => {
  it('adds a company', async () => {
    mockedAddCompany.mockResolvedValue({ id: 'co_1', name: 'Acme Corp', createdAt: 1, updatedAt: 1 });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { name: 'Acme Corp' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddCompany).toHaveBeenCalledWith({ name: 'Acme Corp' });
    expect(captured.infos[0]?.message).toContain('Acme Corp');
  });

  it('missing --name is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddCompany).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
