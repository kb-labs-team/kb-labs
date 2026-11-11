import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';

const mocks = vi.hoisted(() => ({
  analyzeLayering: vi.fn(),
  useConfig: vi.fn(),
}));

vi.mock('@kb-labs/quality/core', () => ({
  analyzeLayering: mocks.analyzeLayering,
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: mocks.useConfig };
});

import checkLayersCommand from '../../../src/cli/commands/check-layers.js';

const violation = {
  file: 'src/cli.ts',
  fromPackage: '@kb-labs/core-runtime',
  fromLayer: 1,
  toPackage: '@kb-labs/studio',
  toLayer: 4,
  importSpecifier: '@kb-labs/studio',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useConfig.mockResolvedValue(undefined);
  mocks.analyzeLayering.mockResolvedValue({
    violations: [violation],
    totalViolations: 1,
    affectedPackages: ['@kb-labs/core-runtime'],
    layerMap: {},
  });
});

describe('quality:check-layers', () => {
  // case: S-203.1
  it('returns the same typed failure with structured diagnostics in JSON and human modes', async () => {
    const jsonUI = createCapturedUI().ui;
    const jsonResult = await checkLayersCommand.execute(
      createMockContext({ ui: jsonUI, cwd: '/project' }) as never,
      mockCLIInput({ flags: { json: true } }),
    );
    const humanUI = createCapturedUI().ui;
    const humanResult = await checkLayersCommand.execute(
      createMockContext({ ui: humanUI, cwd: '/project' }) as never,
      mockCLIInput({ flags: {} }),
    );

    expect(jsonResult).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        hint: 'Review the reported imports, then rerun `kb quality check layers run`.',
        diagnostics: [{
          code: 'KB_QUALITY_LAYERING_VIOLATION',
          severity: 'error',
          path: 'src/cli.ts',
        }],
      },
    });
    expect(humanResult).toEqual(jsonResult);
    expect(jsonResult).not.toHaveProperty('result');
  });
});
