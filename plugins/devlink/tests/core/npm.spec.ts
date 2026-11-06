import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the mock variable is defined before vi.mock factories run.
// Without vi.hoisted(), `mockSpawnSync` may be `undefined` when the factory
// executes under Vitest's hoisting pass — causing spawnSync: undefined in the
// mock and intermittent failures in the forks pool (~10% flake rate).
const mockSpawnSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

// Hermetic: stub the SDK so the unit-under-test resolves a no-op cache instead
// of loading the real @kb-labs/sdk barrel.
//
// Why: importing @kb-labs/sdk (any entrypoint, incl. /hooks) eagerly drags
// @kb-labs/core-runtime in via shared-command-kit's top-level
// `import { platform } from '@kb-labs/core-runtime'` (helpers/use-platform.ts).
// That graph costs ~400ms cold and, under CI fork-pool contention, spikes past
// Vitest's 5s default and flakes this argv-only test. Measured: barrel & /hooks
// ~400ms vs /platform ~16ms; deps.optimizer doesn't help (dist already built,
// nothing to transpile) and can't even bundle core-runtime. This test asserts
// spawnSync argv shape — it has no business loading the real cache infra.
//
// TODO(sdk-core-decouple): drop this mock once the platform fallback in
// @kb-labs/shared-command-kit is injected/lazy instead of a static
// core-runtime import, so importing SDK hooks stops dragging the whole runtime.
vi.mock('@kb-labs/sdk', () => ({
  useCache: () => null,
}));

// Regression: getLatestNpmVersion must use spawnSync with discrete argv,
// not execSync with a template string — prevents command injection via packageName.
describe('getLatestNpmVersion — no shell injection', () => {
  beforeEach(() => {
    // Reset call history between tests so `.mock.calls[0]` and `.at(-1)`
    // always refer to the current test's invocations only.
    mockSpawnSync.mockReset();
  });

  it('calls spawnSync with packageName as a discrete argv element', async () => {
    mockSpawnSync.mockReturnValue({ stdout: '"1.0.0"', status: 0, error: undefined });

    const { getLatestNpmVersion } = await import('../../src/core/npm/index.js');
    await getLatestNpmVersion('some-package');

    expect(mockSpawnSync).toHaveBeenCalled();
    const firstCall = mockSpawnSync.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('spawnSync was not called');
    const [cmd, args] = firstCall;
    expect(cmd).toBe('npm');
    expect(args).toContain('some-package');
  });

  it('treats malicious packageName as a single argv element, not a shell command', async () => {
    const malicious = 'legit; rm -rf /';
    mockSpawnSync.mockReturnValue({ stdout: '', status: 1, error: undefined });

    const { getLatestNpmVersion } = await import('../../src/core/npm/index.js');
    const result = await getLatestNpmVersion(malicious);

    expect(result).toBeNull();
    const lastCall = mockSpawnSync.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (!lastCall) throw new Error('spawnSync was not called');
    const [, args] = lastCall;
    // Must be a single discrete element — the OS never interprets it as a shell command
    expect(args).toContain(malicious);
  });
});
