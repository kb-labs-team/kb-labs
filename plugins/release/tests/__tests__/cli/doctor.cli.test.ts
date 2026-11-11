import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/shared/run-preflight.js', () => ({ runPreflightFor: vi.fn() }));
vi.mock('../../../src/shared/utils.js', () => ({ findRepoRoot: vi.fn().mockResolvedValue('/project') }));
vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: vi.fn().mockResolvedValue({}) };
});

import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import { runPreflightFor } from '../../../src/shared/run-preflight.js';
import doctorCommand from '../../../src/cli/commands/doctor.js';

beforeEach(() => {
  vi.mocked(runPreflightFor).mockReset();
});

describe('release:doctor', () => {
  it('PF-01: green preflight -> ok, --json carries preflight + report with a preflight stage row', async () => {
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: true, durationMs: 3,
      checks: [{ id: 'branch', status: 'passed', durationMs: 1, message: 'On master' }],
    } as never);
    const { ui, captured } = createCapturedUI();
    const result = await doctorCommand.execute(createMockContext({ ui, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true, flow: 'platform' } }));
    expect(result).not.toHaveProperty('result');
    expect(result).toMatchObject({
      ok: true,
      report: { stages: expect.arrayContaining([expect.objectContaining({ stage: 'preflight', status: 'passed' })]) },
    });
    expect(runPreflightFor).toHaveBeenCalledWith(expect.objectContaining({ flow: 'platform' }));
  });

  it('PF-02: failing preflight -> ok:false with the failure in the report', async () => {
    const error = { code: 'KB_RELEASE_TREE_DIRTY', area: 'release', stage: 'preflight', severity: 'error', retryable: false, message: 'dirty', cause: '2 paths', hint: 'commit' };
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: false, durationMs: 3,
      checks: [{ id: 'clean-tree', status: 'failed', durationMs: 1, message: '2 uncommitted change(s)', error }],
    } as never);
    const { ui, captured } = createCapturedUI();
    const result = await doctorCommand.execute(createMockContext({ ui, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true } }));
    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('preflight:clean-tree'), severity: 'error' })],
      },
    });
  });
});
