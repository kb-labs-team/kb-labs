import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  getProject: vi.fn(),
}));

import { getProject } from '../../../src/core/index.js';
import command from '../../../src/commands/project-get.js';

const mockedGetProject = vi.mocked(getProject);

beforeEach(() => {
  mockedGetProject.mockReset();
});

describe('steward:project.get', () => {
  it('returns the project card', async () => {
    const project = { id: 'prj_1', name: 'Acme API', status: 'active' as const, createdAt: 1, updatedAt: 1 };
    mockedGetProject.mockResolvedValue({ project, resources: [], members: [] });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['prj_1'] }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos[0]?.message).toContain('Acme API');
  });

  it('--json emits the full card', async () => {
    const project = { id: 'prj_1', name: 'Acme API', status: 'active' as const, createdAt: 1, updatedAt: 1 };
    mockedGetProject.mockResolvedValue({ project, resources: [], members: [] });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: ['prj_1'], flags: { json: true } }));

    expect(result).toMatchObject({ project: { id: 'prj_1' } });
  });

  it('not found — NOT_FOUND, exitOk false', async () => {
    mockedGetProject.mockResolvedValue(null);

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
    expect(mockedGetProject).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
