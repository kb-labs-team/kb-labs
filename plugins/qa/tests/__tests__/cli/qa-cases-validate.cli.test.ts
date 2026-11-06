import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: vi.fn().mockResolvedValue(null) };
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import type { CommandFailure } from '@kb-labs/sdk/contracts';
import command from '../../../src/cli/commands/qa-cases-validate.js';

const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('qa:cases-validate', () => {
  it('returns findings in the shared error diagnostics field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cases-validate-'));
    dirs.push(root);
    mkdirSync(join(root, 'docs', 'qa', 'scenarios'), { recursive: true });
    const { ui } = createCapturedUI();

    const result = await command.execute(createMockContext({ ui, cwd: root }) as never, mockCLIInput({ flags: { json: true } }) as never);

    const failure = result as CommandFailure;
    expect(failure).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    // The empty catalog also reports every release-claim baseline entry as stale, so match the catalog finding among them.
    expect(failure.error.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'QA_CASE_INVALID', severity: 'error', path: expect.any(String), line: 1 }),
    ]));
    expect(failure.error.diagnostics?.every(item => item.code === 'QA_CASE_INVALID' && item.severity === 'error')).toBe(true);
    expect(failure).not.toHaveProperty('result');
  });
});
