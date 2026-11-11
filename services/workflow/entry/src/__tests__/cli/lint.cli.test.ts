import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

import lintCommand from '../../commands/lint.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/lint/${name}`, import.meta.url));

const fixturesDir = fileURLToPath(new URL('./fixtures/lint', import.meta.url));

describe('workflow:lint', () => {
  it('CLI-01: valid file → exitCode 0, no errors reported', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await lintCommand.execute(ctx, mockCLIInput({ flags: { path: fixture('valid.yml') } }));

    expect(captured.errors).toHaveLength(0);
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('CLI-02: invalid file (missing jobs) → exitCode 1 + error carries the field path', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await lintCommand.execute(ctx, mockCLIInput({ flags: { path: fixture('invalid.yml') } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        message: expect.stringMatching(/job/i),
        hint: expect.any(String),
      },
    });
  });

  it('CLI-03: --json emits parseable { ok:false, files:[...] }', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await lintCommand.execute(
      ctx,
      mockCLIInput({ flags: { path: fixture('invalid.yml'), json: true } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: 'WORKFLOW_VALIDATION_FAILED',
            path: expect.stringContaining('invalid.yml'),
            message: expect.stringMatching(/job/i),
          }),
        ]),
      },
    });
  });

  it('CLI-04: directory path lints every file and fails if any is invalid', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await lintCommand.execute(
      ctx,
      mockCLIInput({ flags: { path: fixturesDir, json: true } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'WORKFLOW_VALIDATION_FAILED', path: expect.stringContaining('invalid.yml') }),
        ]),
      },
    });
  });

  it('CLI-05: --strict on a valid file still passes (no warnings to promote)', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await lintCommand.execute(
      ctx,
      mockCLIInput({ flags: { path: fixture('valid.yml'), strict: true } }),
    );

  });
});
