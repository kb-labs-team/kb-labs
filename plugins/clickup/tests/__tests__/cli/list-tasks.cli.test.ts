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

import { requireApiKey, getListTasks } from '../../../src/core/index.js';
import listTasksCommand from '../../../src/commands/list-tasks.js';
import { mockTask } from '../helpers/fixtures.js';

// Use fixture task with a recognisable id for assertions
const mockTasks = [{ ...mockTask, id: 'task-1', name: 'Task One' }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:list.tasks', () => {
  it('LT-01: lists tasks — exitCode 0, table rendered', async () => {
    vi.mocked(getListTasks).mockResolvedValue(mockTasks);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.table.length).toBeGreaterThan(0);
    expect(vi.mocked(getListTasks)).toHaveBeenCalledWith('test-api-key', 'list-1', expect.any(Object));
  });

  it('LT-02: --json outputs slim tasks array', async () => {
    vi.mocked(getListTasks).mockResolvedValue(mockTasks);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(Array.isArray(result)).toBe(true);
    const slim = (result as Array<Record<string, unknown>>)[0]!;
    expect(slim.id).toBe('task-1');
    expect(typeof slim.status).toBe('string');
    expect(slim).toHaveProperty('due_date');
    expect(slim).toHaveProperty('url');
    expect(slim).not.toHaveProperty('assignees');
    expect(slim).not.toHaveProperty('date_created');
  });

  it('LT-02b: --json --full outputs raw tasks array', async () => {
    vi.mocked(getListTasks).mockResolvedValue(mockTasks);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: { json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = (result as typeof mockTasks)[0]!;
    expect(typeof raw.status).toBe('object');
    expect(raw.date_created).toBeDefined();
  });

  it('LT-03: empty task list — exitCode 0, info message shown', async () => {
    vi.mocked(getListTasks).mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos.length).toBeGreaterThan(0);
  });

  it('LT-04: missing listId argv — exitCode 1, error shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('LT-05: core function throws — exitCode 1, error shown', async () => {
    vi.mocked(getListTasks).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await listTasksCommand.execute(
      ctx,
      mockCLIInput({ argv: ['list-1'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
