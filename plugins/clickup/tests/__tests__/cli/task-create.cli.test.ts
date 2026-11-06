import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock clickup-core before importing the command
vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  createTask: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error {
    constructor(public override message: string, public status: number, public code: string) {
      super(message);
    }
  },
}));

import { requireApiKey, createTask } from '../../../src/core/index.js';
import taskCreateCommand from '../../../src/commands/task-create.js';
import { mockTask } from '../helpers/fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:task.create', () => {
  it('TC-01: creates a task and prints success', async () => {
    vi.mocked(createTask).mockResolvedValue(mockTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1', name: 'My Task' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Task created');
  });

  it('TC-02: --json outputs slim task object', async () => {
    vi.mocked(createTask).mockResolvedValue(mockTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1', name: 'My Task', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const slim = result as Record<string, unknown>;
    expect(slim.id).toBe('task-001');
    expect(typeof slim.status).toBe('string');
    expect(slim).not.toHaveProperty('date_created');
    expect(slim).not.toHaveProperty('assignees');
  });

  it('TC-02b: --json --full outputs raw task object', async () => {
    vi.mocked(createTask).mockResolvedValue(mockTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1', name: 'My Task', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockTask;
    expect(typeof raw.status).toBe('object');
    expect(raw.date_created).toBeDefined();
  });

  it('TC-03: missing --list returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { name: 'My Task' } }) as Parameters<typeof taskCreateCommand.execute>[1],
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TC-04: missing --name returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1' } }) as Parameters<typeof taskCreateCommand.execute>[1],
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TC-08: --dry-run shows intent, createTask is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1', name: 'My Task', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('My Task');
  });

  it('TC-05: core error returns exitCode 1', async () => {
    vi.mocked(createTask).mockRejectedValue(new Error('API error'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskCreateCommand.execute(
      ctx,
      mockCLIInput({ flags: { list: 'list-1', name: 'My Task' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
