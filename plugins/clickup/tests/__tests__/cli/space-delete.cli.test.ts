import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock ../../../src/core/index.js before importing the command
vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  requireTeamId: vi.fn().mockReturnValue('team-123'),
  getWorkspaceHierarchy: vi.fn(),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
  createListInFolder: vi.fn(),
  createListInSpace: vi.fn(),
  updateList: vi.fn(),
  deleteList: vi.fn(),
  getListTasks: vi.fn(),
  getListStatuses: vi.fn(),
  createSpace: vi.fn(),
  updateSpace: vi.fn(),
  deleteSpace: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error { status = 0; code = ''; },
}));

import { requireApiKey, deleteSpace } from '../../../src/core/index.js';
import spaceDeleteCommand from '../../../src/commands/space-delete.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:space.delete', () => {
  it('SD-01: deletes space with --force — exitCode 0, success message', async () => {
    vi.mocked(deleteSpace).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { force: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(vi.mocked(deleteSpace)).toHaveBeenCalledWith('test-api-key', 'space-1');
  });

  it('SD-02: --json outputs { ok: true, deleted: true, spaceId }', async () => {
    vi.mocked(deleteSpace).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { force: true, json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ deleted: true, spaceId: 'space-1' });
  });

  it('SD-03: missing spaceId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SD-04: missing --force — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SD-05: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(deleteSpace).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SD-06: --dry-run shows intent, deleteSpace is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(deleteSpace)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('space-1');
  });
});
