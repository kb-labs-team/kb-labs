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

import { requireApiKey, requireTeamId, createSpace } from '../../../src/core/index.js';
import spaceCreateCommand from '../../../src/commands/space-create.js';
import { mockSpaceDetail } from '../helpers/fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
  vi.mocked(requireTeamId).mockReturnValue('team-123');
});

describe('clickup:space.create', () => {
  it('SC-01: creates space — exitCode 0, success message', async () => {
    vi.mocked(createSpace).mockResolvedValue(mockSpaceDetail);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Space' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Space created');
    expect(vi.mocked(createSpace)).toHaveBeenCalledWith(
      'test-api-key',
      'team-123',
      expect.objectContaining({ name: 'My Space' }),
    );
  });

  it('SC-02: --json outputs slim space object', async () => {
    vi.mocked(createSpace).mockResolvedValue(mockSpaceDetail);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Space', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ id: 'space-1', name: 'My Space' });
    expect(Object.keys(result as object)).toEqual(['id', 'name']);
  });

  it('SC-02b: --json --full outputs raw space object', async () => {
    vi.mocked(createSpace).mockResolvedValue(mockSpaceDetail);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Space', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockSpaceDetail;
    expect(raw.folders).toBeDefined();
    expect(raw.statuses).toBeDefined();
  });

  it('SC-03: missing --name — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SC-04: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(createSpace).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Space' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SC-05: --dry-run shows intent, createSpace is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await spaceCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Space', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(createSpace)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('My Space');
  });
});
