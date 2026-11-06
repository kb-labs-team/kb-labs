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

import { requireApiKey, updateFolder } from '../../../src/core/index.js';
import folderUpdateCommand from '../../../src/commands/folder-update.js';
import { mockFolder } from '../helpers/fixtures.js';

// Variant with updated name for update tests
const mockUpdatedFolder = { ...mockFolder, name: 'Updated Folder' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:folder.update', () => {
  it('FU-01: updates folder — exitCode 0, success message', async () => {
    vi.mocked(updateFolder).mockResolvedValue(mockUpdatedFolder);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { name: 'Updated Folder' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Folder updated');
    expect(vi.mocked(updateFolder)).toHaveBeenCalledWith('test-api-key', 'folder-1', { name: 'Updated Folder' });
  });

  it('FU-02: --json outputs slim updated folder', async () => {
    vi.mocked(updateFolder).mockResolvedValue(mockUpdatedFolder);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { name: 'Updated Folder', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ id: 'folder-1', name: 'Updated Folder' });
    expect(Object.keys(result as object)).toEqual(['id', 'name']);
  });

  it('FU-02b: --json --full outputs raw updated folder', async () => {
    vi.mocked(updateFolder).mockResolvedValue(mockUpdatedFolder);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { name: 'Updated Folder', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockUpdatedFolder;
    expect(raw.lists).toBeDefined();
    expect(raw.orderindex).toBeDefined();
  });

  it('FU-03: missing folderId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { name: 'Updated Folder' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FU-04: missing --name — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FU-05: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(updateFolder).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { name: 'Updated Folder' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('FU-06: --dry-run shows intent, updateFolder is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await folderUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['folder-1'], flags: { name: 'New Name', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(updateFolder)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('folder-1');
  });
});
