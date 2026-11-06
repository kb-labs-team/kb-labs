import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  updateProject: vi.fn(),
}));

import { updateProject } from '../../../src/core/index.js';
import command from '../../../src/commands/project-update.js';

const mockedUpdateProject = vi.mocked(updateProject);

beforeEach(() => {
  mockedUpdateProject.mockReset();
});

describe('steward:project.update', () => {
  it('updates a project', async () => {
    mockedUpdateProject.mockResolvedValue({
      id: 'prj_1',
      name: 'Acme API',
      status: 'paused',
      createdAt: 1,
      updatedAt: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['prj_1'], flags: { status: 'paused' } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedUpdateProject).toHaveBeenCalledWith({ id: 'prj_1', status: 'paused', description: undefined });
    expect(captured.infos[0]?.message).toContain('paused');
  });

  it('not found — NOT_FOUND', async () => {
    mockedUpdateProject.mockResolvedValue(null);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['missing'], flags: { status: 'paused' } }));

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
    expect(mockedUpdateProject).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
