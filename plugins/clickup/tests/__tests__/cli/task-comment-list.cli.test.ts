import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock clickup-core before importing the command
vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  getTaskComments: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error {
    constructor(public override message: string, public status: number, public code: string) {
      super(message);
    }
  },
}));

import { requireApiKey, getTaskComments } from '../../../src/core/index.js';
import taskCommentListCommand from '../../../src/commands/task-comment-list.js';
import { mockComment } from '../helpers/fixtures.js';

const mockComments = [
  { ...mockComment, id: 'comment-1', comment_text: 'First comment' },
  { ...mockComment, id: 'comment-2', comment_text: 'Second comment', date: '1700001000000' },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:task comments list', () => {
  it('TCL-01: lists comments and renders chain', async () => {
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'] }),
    );

    expect(result).not.toHaveProperty('ok');
  });

  it('TCL-02: --json outputs slim comments array', async () => {
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(Array.isArray(result)).toBe(true);
    const slim = (result as Array<Record<string, unknown>>)[0]!;
    expect(slim.id).toBe('comment-1');
    expect(typeof slim.user).toBe('string');
    expect(slim).not.toHaveProperty('resolved');
    expect(slim).not.toHaveProperty('comment');
  });

  it('TCL-02b: --json --full outputs raw comments array', async () => {
    vi.mocked(getTaskComments).mockResolvedValue(mockComments);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = (result as typeof mockComments)[0]!;
    expect(typeof raw.user).toBe('object');
    expect(raw.resolved).toBeDefined();
  });

  it('TCL-03: empty comments prints info message', async () => {
    vi.mocked(getTaskComments).mockResolvedValue([]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'] }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.infos.length).toBeGreaterThan(0);
  });

  it('TCL-04: missing taskId returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: [] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TCL-05: core error returns exitCode 1', async () => {
    vi.mocked(getTaskComments).mockRejectedValue(new Error('Unauthorized'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCommentListCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
