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

import { requireApiKey, getListStatuses } from '../../../src/core/index.js';
import listStatusesCommand from '../../../src/commands/list-statuses.js';
import { mockStatuses } from '../helpers/fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:list.statuses', () => {
  it('LS-01: lists statuses — exitCode 0, table rendered', async () => {
    vi.mocked(getListStatuses).mockResolvedValue(mockStatuses);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listStatusesCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.table.length).toBeGreaterThan(0);
    expect(vi.mocked(getListStatuses)).toHaveBeenCalledWith('test-api-key', 'list-1');
  });

  it('LS-02: --json outputs slim statuses array', async () => {
    vi.mocked(getListStatuses).mockResolvedValue(mockStatuses);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listStatusesCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(Array.isArray(result)).toBe(true);
    const slim = (result as Array<Record<string, unknown>>)[0];
    expect(slim).toMatchObject({ status: 'open', type: 'open', color: '#000000' });
    expect(slim).not.toHaveProperty('id');
    expect(slim).not.toHaveProperty('orderindex');
  });

  it('LS-02b: --json --full outputs raw statuses array', async () => {
    vi.mocked(getListStatuses).mockResolvedValue(mockStatuses);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listStatusesCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = (result as typeof mockStatuses)[0]!;
    expect(raw.id).toBeDefined();
    expect(raw.orderindex).toBeDefined();
  });

  it('LS-03: missing listId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listStatusesCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LS-04: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(getListStatuses).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listStatusesCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
