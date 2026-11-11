import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock clickup-core before importing the command
vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  getTask: vi.fn(),
  getTaskComments: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error {
    constructor(public override message: string, public status: number, public code: string) {
      super(message);
    }
  },
}));

import { requireApiKey, getTask, getTaskComments } from '../../../src/core/index.js';
import taskGetCommand from '../../../src/commands/task-get.js';
import { mockTask, mockComment } from '../helpers/fixtures.js';

const mockComments = [{ ...mockComment, id: 'comment-1', comment_text: 'Hello' }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:task.get', () => {
  it('TG-01: retrieves task and renders sideBox', async () => {
    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskGetCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'] }),
    );

    expect(result).not.toHaveProperty('ok');
  });

  it('TG-02: --json outputs slim task object', async () => {
    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskGetCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const slim = result as Record<string, unknown>;
    expect(slim.id).toBe('task-001');
    expect(slim.status).toBe('open');
    expect(slim).toHaveProperty('description');
    expect(slim).toHaveProperty('due_date');
    expect(slim).toHaveProperty('url');
    expect(slim).not.toHaveProperty('comments');
    expect(slim).not.toHaveProperty('task');
  });

  it('TG-02b: --json --full outputs { task, comments }', async () => {
    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskGetCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ task: { id: 'task-001' } });
  });

  it('TG-03: missing taskId returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskGetCommand.execute(
      ctx,
      mockCLIInput({ argv: [] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TG-04: core error returns exitCode 1', async () => {
    vi.mocked(getTask).mockRejectedValue(new Error('Not found'));
    vi.mocked(getTaskComments).mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskGetCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
