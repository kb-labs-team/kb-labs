import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  listProjects: vi.fn(),
}));

import { listProjects } from '../../../src/core/index.js';
import command from '../../../src/commands/project-list.js';

const mockedListProjects = vi.mocked(listProjects);

beforeEach(() => {
  mockedListProjects.mockReset();
});

describe('steward:project.list', () => {
  it('lists projects and forwards the status filter', async () => {
    mockedListProjects.mockResolvedValue([
      { id: 'prj_1', name: 'Acme API', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { status: 'active' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedListProjects).toHaveBeenCalledWith({ status: 'active' });
    expect(captured.chain[0]).toHaveLength(1);
  });

  it('prints a friendly message when there are no projects', async () => {
    mockedListProjects.mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.infos[0]?.message).toMatch(/no projects/i);
  });

  it('--json emits the raw array', async () => {
    mockedListProjects.mockResolvedValue([
      { id: 'prj_1', name: 'Acme API', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject([{ id: 'prj_1' }]);
  });
});
