import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listResources: vi.fn(),
}));

import { listResources } from '../../../src/core/index.js';
import command from '../../../src/commands/resource-list.js';

const mockedListResources = vi.mocked(listResources);

beforeEach(() => {
  mockedListResources.mockReset();
});

describe('steward:resource.list', () => {
  it('lists resources for a project', async () => {
    mockedListResources.mockResolvedValue([
      { id: 'res_1', projectId: 'prj_1', type: 'repo', label: 'Repo', url: 'https://x', createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['prj_1'] }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedListResources).toHaveBeenCalledWith('prj_1');
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('prints a friendly message with no resources', async () => {
    mockedListResources.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await command.execute(ctx, mockCLIInput({ argv: ['prj_1'] }));

    expect(captured.infos[0]?.message).toMatch(/no resources/i);
  });

  it('missing projectId is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedListResources).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
