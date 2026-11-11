import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addResource: vi.fn(),
}));

import { addResource } from '../../../src/core/index.js';
import command from '../../../src/commands/resource-add.js';

const mockedAddResource = vi.mocked(addResource);

beforeEach(() => {
  mockedAddResource.mockReset();
});

describe('steward:resource.add', () => {
  it('attaches a resource to a project', async () => {
    mockedAddResource.mockResolvedValue({
      id: 'res_1',
      projectId: 'prj_1',
      type: 'repo',
      label: 'Repo',
      url: 'https://example.com',
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['prj_1'], flags: { type: 'repo', label: 'Repo', url: 'https://example.com' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddResource).toHaveBeenCalledWith({
      projectId: 'prj_1',
      type: 'repo',
      label: 'Repo',
      url: 'https://example.com',
      content: undefined,
    });
    expect(captured.infos[0]?.message).toContain('Repo');
  });

  it('missing projectId/type/label is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddResource).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });

  it('requires at least one of --url/--content', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ argv: ['prj_1'], flags: { type: 'repo', label: 'Repo' } }),
    );

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddResource).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
