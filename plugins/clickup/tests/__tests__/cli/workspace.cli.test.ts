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

import { requireApiKey, requireTeamId, getWorkspaceHierarchy } from '../../../src/core/index.js';
import workspaceCommand from '../../../src/commands/workspace.js';
import { mockWorkspace } from '../helpers/fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
  vi.mocked(requireTeamId).mockReturnValue('team-123');
});

describe('clickup:workspace', () => {
  it('W-01: shows workspace hierarchy — exitCode 0, info rendered', async () => {
    vi.mocked(getWorkspaceHierarchy).mockResolvedValue(mockWorkspace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workspaceCommand.execute(
      ctx,
      mockCLIInput({ flags: {} }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos.length).toBeGreaterThan(0);
    expect(vi.mocked(getWorkspaceHierarchy)).toHaveBeenCalledWith('test-api-key', 'team-123');
  });

  it('W-02: --json outputs compact workspace object', async () => {
    vi.mocked(getWorkspaceHierarchy).mockResolvedValue(mockWorkspace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workspaceCommand.execute(
      ctx,
      mockCLIInput({ flags: { json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ id: 'ws-1', name: 'My Workspace' });
    // Compact format: spaces array should be present
    expect((result as typeof mockWorkspace).spaces).toBeDefined();
  });

  it('W-03: --json --full outputs full workspace object', async () => {
    vi.mocked(getWorkspaceHierarchy).mockResolvedValue(mockWorkspace);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workspaceCommand.execute(
      ctx,
      mockCLIInput({ flags: { json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    // Full mode returns the raw workspace object
    expect(result).toMatchObject({ id: 'ws-1', name: 'My Workspace' });
  });

  it('W-04: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(getWorkspaceHierarchy).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workspaceCommand.execute(
      ctx,
      mockCLIInput({ flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
