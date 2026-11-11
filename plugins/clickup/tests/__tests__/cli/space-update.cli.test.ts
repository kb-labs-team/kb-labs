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

import { requireApiKey, updateSpace } from '../../../src/core/index.js';
import spaceUpdateCommand from '../../../src/commands/space-update.js';
import { mockSpaceDetail } from '../helpers/fixtures.js';

// Variant with updated name for update tests
const mockUpdatedSpace = { ...mockSpaceDetail, name: 'Updated Space' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:space.update', () => {
  it('SU-01: updates space — exitCode 0, success message', async () => {
    vi.mocked(updateSpace).mockResolvedValue(mockUpdatedSpace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { name: 'Updated Space' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Space updated');
    expect(vi.mocked(updateSpace)).toHaveBeenCalledWith('test-api-key', 'space-1', expect.any(Object));
  });

  it('SU-02: --json outputs slim updated space', async () => {
    vi.mocked(updateSpace).mockResolvedValue(mockUpdatedSpace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { name: 'Updated Space', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ id: 'space-1', name: 'Updated Space' });
    expect(Object.keys(result as object)).toEqual(['id', 'name']);
  });

  it('SU-02b: --json --full outputs raw updated space', async () => {
    vi.mocked(updateSpace).mockResolvedValue(mockUpdatedSpace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { name: 'Updated Space', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockUpdatedSpace;
    expect(raw.folders).toBeDefined();
    expect(raw.statuses).toBeDefined();
  });

  it('SU-03: missing spaceId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { name: 'Updated Space' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SU-04: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(updateSpace).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { name: 'Updated Space' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SU-05: --dry-run shows intent, updateSpace is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['space-1'], flags: { name: 'New Name', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(updateSpace)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('space-1');
  });
});
