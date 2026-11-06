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

import { requireApiKey, createListInFolder, createListInSpace } from '../../../src/core/index.js';
import listCreateCommand from '../../../src/commands/list-create.js';
import { mockList } from '../helpers/fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:list.create', () => {
  it('LC-01: creates list in folder — exitCode 0, success message', async () => {
    vi.mocked(createListInFolder).mockResolvedValue(mockList);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1', name: 'My List' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('List created');
    expect(vi.mocked(createListInFolder)).toHaveBeenCalledWith('test-api-key', 'folder-1', { name: 'My List' });
  });

  it('LC-02: creates list in space when --space provided', async () => {
    vi.mocked(createListInSpace).mockResolvedValue(mockList);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { space: 'space-1', name: 'My List' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(createListInSpace)).toHaveBeenCalledWith('test-api-key', 'space-1', { name: 'My List' });
  });

  it('LC-03: --json outputs slim list object', async () => {
    vi.mocked(createListInFolder).mockResolvedValue(mockList);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1', name: 'My List', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ id: 'list-1', name: 'My List' });
    expect(Object.keys(result as object)).toEqual(['id', 'name']);
  });

  it('LC-03b: --json --full outputs raw list object', async () => {
    vi.mocked(createListInFolder).mockResolvedValue(mockList);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1', name: 'My List', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockList;
    expect(raw.orderindex).toBeDefined();
    expect(raw.taskCount).toBeDefined();
  });

  it('LC-04: missing --name — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1' } }) as Parameters<typeof listCreateCommand.execute>[1],
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LC-05: missing --folder and --space — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My List' } }) as Parameters<typeof listCreateCommand.execute>[1],
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LC-06: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(createListInFolder).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1', name: 'My List' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LC-07: --dry-run shows intent, HTTP is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { folder: 'folder-1', name: 'My List', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(createListInFolder)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('My List');
  });
});
