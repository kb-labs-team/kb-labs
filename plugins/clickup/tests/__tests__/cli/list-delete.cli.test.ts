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

import { requireApiKey, deleteList } from '../../../src/core/index.js';
import listDeleteCommand from '../../../src/commands/list-delete.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:list.delete', () => {
  it('LD-01: deletes list with --force — exitCode 0, success message', async () => {
    vi.mocked(deleteList).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { force: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(vi.mocked(deleteList)).toHaveBeenCalledWith('test-api-key', 'list-1');
  });

  it('LD-02: --json outputs { ok: true, deleted: true, listId }', async () => {
    vi.mocked(deleteList).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { force: true, json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ deleted: true, listId: 'list-1' });
  });

  it('LD-03: missing listId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LD-04: missing --force — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LD-05: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(deleteList).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { force: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LD-06: --dry-run shows intent, deleteList is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(deleteList)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('list-1');
  });
});
