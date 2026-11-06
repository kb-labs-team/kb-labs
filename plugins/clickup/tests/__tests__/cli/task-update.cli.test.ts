import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock clickup-core before importing the command
vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  updateTask: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error {
    constructor(public override message: string, public status: number, public code: string) {
      super(message);
    }
  },
}));

import { requireApiKey, updateTask } from '../../../src/core/index.js';
import taskUpdateCommand from '../../../src/commands/task-update.js';
import { mockTask } from '../helpers/fixtures.js';

// Variant with updated name for update tests
const mockUpdatedTask = { ...mockTask, name: 'Updated Task' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:task.update', () => {
  it('TU-01: updates a task and prints success', async () => {
    vi.mocked(updateTask).mockResolvedValue(mockUpdatedTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { name: 'Updated Task' } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Task updated');
  });

  it('TU-02: --json outputs slim updated task', async () => {
    vi.mocked(updateTask).mockResolvedValue(mockUpdatedTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { name: 'Updated Task', json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const slim = result as Record<string, unknown>;
    expect(slim.id).toBe('task-001');
    expect(typeof slim.status).toBe('string');
    expect(slim).not.toHaveProperty('date_created');
    expect(slim).not.toHaveProperty('assignees');
  });

  it('TU-02b: --json --full outputs raw updated task', async () => {
    vi.mocked(updateTask).mockResolvedValue(mockUpdatedTask);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { name: 'Updated Task', json: true, full: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    const raw = result as typeof mockUpdatedTask;
    expect(typeof raw.status).toBe('object');
    expect(raw.date_created).toBeDefined();
  });

  it('TU-03: missing taskId returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: [] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TU-05: --dry-run shows intent, updateTask is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { name: 'New Name', 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('task-001');
  });

  it('TU-04: core error returns exitCode 1', async () => {
    vi.mocked(updateTask).mockRejectedValue(new Error('Forbidden'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskUpdateCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { status: 'done' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });
});
