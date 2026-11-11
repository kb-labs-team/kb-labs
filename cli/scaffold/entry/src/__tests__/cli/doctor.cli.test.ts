import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock scaffold-core before importing the command
vi.mock('@kb-labs/scaffold-core', () => ({
  scanRoot: vi.fn(),
}));

import { scanRoot } from '@kb-labs/scaffold-core';
import { scaffoldDoctor } from '../../commands/doctor.js';

const mockedScanRoot = vi.mocked(scanRoot);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('scaffold:doctor', () => {
  it('SD-01: successful scan with no findings — exitCode 0, prints package count', async () => {
    mockedScanRoot.mockResolvedValue({
      findings: [],
      packagesScanned: 3,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const exitCode = await scaffoldDoctor.run(ctx, [], {});

    expect(exitCode).toBe(0);
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('3');
  });

  it('SD-02: --json returns the scan report directly', async () => {
    const findings = [
      { severity: 'warn' as const, message: 'missing field', package: 'my-pkg' },
    ];
    mockedScanRoot.mockResolvedValue({
      findings,
      packagesScanned: 2,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const exitCode = await scaffoldDoctor.run(ctx, [], { json: true });

    expect(exitCode).toBe(0);
    expect(captured.json).toEqual([{ ok: true, data: { root: expect.any(String), packagesScanned: 2, findings } }]);
  });

  // case: S-203.1
  it('returns the same typed failure for error findings in JSON and human modes', async () => {
    mockedScanRoot.mockResolvedValue({
      findings: [
        { severity: 'error' as const, message: 'missing manifest', package: 'bad-pkg' },
      ],
      packagesScanned: 1,
    });

    const jsonUI = createCapturedUI();
    const jsonExitCode = await scaffoldDoctor.run(createMockContext({ ui: jsonUI.ui }), [], { json: true });
    const humanUI = createCapturedUI();
    const exitCode = await scaffoldDoctor.run(createMockContext({ ui: humanUI.ui }), [], {});

    expect(jsonExitCode).not.toBe(0);
    expect(exitCode).not.toBe(0);
    expect(jsonUI.captured.json[0]).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        diagnostics: [{ code: 'KB_SCAFFOLD_DOCTOR_FINDING', message: 'bad-pkg: missing manifest' }],
      },
    });
    expect(humanUI.captured.errors.join('\n')).toContain('1 error(s) found');
  });

  it('SD-04: --path is forwarded to scanRoot', async () => {
    mockedScanRoot.mockResolvedValue({
      findings: [],
      packagesScanned: 0,
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await scaffoldDoctor.run(ctx, [], { path: '/custom/path' });

    expect(mockedScanRoot).toHaveBeenCalledWith(
      expect.stringContaining('/custom/path'),
      expect.any(Object),
    );
  });

  it('SD-05: scanRoot throws — command boundary reports a sanitized error', async () => {
    mockedScanRoot.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const exitCode = await scaffoldDoctor.run(ctx, [], { json: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
    expect(JSON.stringify(captured.json)).not.toContain('ENOENT');
  });
});
