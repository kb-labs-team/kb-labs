import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  requireApiKey: vi.fn().mockReturnValue('test-api-key'),
  deleteTask: vi.fn(),
  ClickUpApiError: class ClickUpApiError extends Error {
    constructor(public override message: string, public status: number, public code: string) {
      super(message);
    }
  },
}));

import { requireApiKey, deleteTask } from '../../../src/core/index.js';
import taskDeleteCommand from '../../../src/commands/task-delete.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireApiKey).mockReturnValue('test-api-key');
});

describe('clickup:task.delete', () => {
  it('TD-01: deletes a task with --yes and prints success', async () => {
    vi.mocked(deleteTask).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { yes: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('task-001');
  });

  it('TD-02: --json outputs { ok, deleted, taskId }', async () => {
    vi.mocked(deleteTask).mockResolvedValue(undefined);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { yes: true, json: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(result).toMatchObject({ deleted: true, taskId: 'task-001' });
  });

  it('TD-03: missing taskId returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { yes: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TD-04: missing --yes returns exitCode 1 with hint', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TD-05: core error returns exitCode 1', async () => {
    vi.mocked(deleteTask).mockRejectedValue(new Error('Not found'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { yes: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('TD-06: --dry-run shows intent, deleteTask is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { 'dry-run': true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(deleteTask).not.toHaveBeenCalled();
    expect(captured.infos.length).toBeGreaterThan(0);
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('task-001');
  });

  it('TD-07: --dry-run with --yes still shows intent only (dry-run wins)', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await taskDeleteCommand.execute(
      ctx,
      mockCLIInput({ argv: ['task-001'], flags: { 'dry-run': true, yes: true } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(deleteTask).not.toHaveBeenCalled();
    expect(captured.infos.length).toBeGreaterThan(0);
  });
});
