import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addProject: vi.fn(),
}));

import { addProject } from '../../../src/core/index.js';
import command from '../../../src/commands/project-add.js';

const mockedAddProject = vi.mocked(addProject);

beforeEach(() => {
  mockedAddProject.mockReset();
});

describe('steward:project.add', () => {
  it('creates a project and prints a confirmation', async () => {
    mockedAddProject.mockResolvedValue({
      id: 'prj_1',
      name: 'Acme API',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { name: 'Acme API' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddProject).toHaveBeenCalledWith({ name: 'Acme API', status: 'active', description: undefined });
    expect(captured.infos[0]?.message).toContain('Acme API');
  });

  it('--json emits a structured result', async () => {
    mockedAddProject.mockResolvedValue({
      id: 'prj_1',
      name: 'Acme API',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: { name: 'Acme API', json: true } }));

    expect(result).toMatchObject({ id: 'prj_1' });
  });

  it('missing --name is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddProject).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
