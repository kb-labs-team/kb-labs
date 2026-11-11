import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('@kb-labs/agents/tracing', () => ({
  loadTrace: vi.fn().mockResolvedValue({ ok: true, events: [] }),
  formatTraceLoadError: vi.fn(),
}));
vi.mock('../../cli/commands/trace-event-normalizer.js', () => ({
  normalizeTraceEvents: vi.fn(() => [{
    raw: { timestamp: '2026-10-11T00:00:00.000Z' },
    type: 'error:captured',
    data: { error: 'Task crashed' },
    iteration: 1,
  }]),
}));

import diagnoseCommand from '../../../src/cli/commands/trace-diagnose.js';

describe('agents:trace:diagnose JSON failure parity', () => {
  beforeEach(() => vi.clearAllMocks());

  // case: S-203.1
  it('returns critical trace findings as a typed failure in both modes', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const humanResult = await diagnoseCommand.execute(ctx, { 'task-id': 'trace-1' } as never);
    const jsonResult = await diagnoseCommand.execute(ctx, { 'task-id': 'trace-1', json: true } as never);

    expect(humanResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(humanResult);
  });
});
