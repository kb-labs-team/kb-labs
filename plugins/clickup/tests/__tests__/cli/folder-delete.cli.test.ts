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

import { requireApiKey, deleteFolder } from '../../../src/core/index.js';
import folderDeleteCommand from '../../../src/commands/folder-delete.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:folder.delete', () => {
  it('FD-01: deletes folder with --force — exitCode 0, success message', async () => {
    vi.mocked(deleteFolder).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { force: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(vi.mocked(deleteFolder)).toHaveBeenCalledWith('test-api-key', 'folder-1');
  });

  it('FD-02: --json outputs { ok: true, deleted: true, folderId }', async () => {
    vi.mocked(deleteFolder).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { force: true, json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ deleted: true, folderId: 'folder-1' });
  });

  it('FD-03: missing folderId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FD-04: missing --force — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FD-05: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(deleteFolder).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FD-06: --dry-run shows intent, deleteFolder is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(deleteFolder)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('folder-1');
  });
});
