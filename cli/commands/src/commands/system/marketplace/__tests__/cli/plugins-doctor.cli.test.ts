import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

vi.mock('../../http.js', () => ({ get: vi.fn() }));
vi.mock('../../scope.js', () => ({
  resolveCliScope: vi.fn(),
  CliScopeError: class CliScopeError extends Error {},
}));

import { get } from '../../http.js';
import { resolveCliScope } from '../../scope.js';
import doctorCommand from '../../commands/plugins/doctor.js';

const mockedGet = vi.mocked(get);
const mockedResolveCliScope = vi.mocked(resolveCliScope);

beforeEach(() => {
  vi.resetAllMocks();
  mockedResolveCliScope.mockResolvedValue({ scope: 'project', projectRoot: '/workspace', reason: 'auto-detect' });
  mockedGet.mockResolvedValue({
    ok: false,
    total: 1,
    provenance: [],
    issues: [{
      severity: 'error',
      packageId: '@kb-labs/blocked',
      diagnosticCode: 'PLUGIN_POLICY_TYPE_INVALID',
      message: 'plugins.block must be an array of package names',
      path: '/workspace/.kb/kb.config.json',
      remediation: 'Repair the project policy, then run `kb marketplace plugins doctor --scope project`.',
    }],
  });
});

describe('marketplace:plugins:doctor', () => {
  // case: S-203.25
  it('returns the same failure result in human mode', async () => {
    const { ui } = createCapturedUI();
    const result = await doctorCommand.execute(
      createMockContext({ ui }),
      mockCLIInput({ flags: { scope: 'project' } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        diagnostics: [{
          code: 'PLUGIN_POLICY_TYPE_INVALID',
          severity: 'error',
          path: '/workspace/.kb/kb.config.json',
        }],
      },
    });
    expect(result).not.toHaveProperty('data');
  });

  // case: S-203.25
  it('returns the same failure result in JSON mode', async () => {
    const { ui } = createCapturedUI();
    const result = await doctorCommand.execute(
      createMockContext({ ui }),
      mockCLIInput({ flags: { json: true, scope: 'project' } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        diagnostics: [{
          code: 'PLUGIN_POLICY_TYPE_INVALID',
          severity: 'error',
          path: '/workspace/.kb/kb.config.json',
        }],
      },
    });
    expect(result).not.toHaveProperty('data');
  });
});
