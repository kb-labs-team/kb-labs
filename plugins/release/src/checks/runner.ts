/**
 * @module @kb-labs/release/checks/runner
 * Simple checks runner implementation
 */

import type { CheckConfig, CheckResult, RunChecksOptions } from './types';

/**
 * Run a single check
 */
async function runSingleCheck(
  check: CheckConfig,
  options: RunChecksOptions
): Promise<CheckResult> {
  const startTime = Date.now();
  const cwd = check.cwd || options.cwd || process.cwd();
  const timeout = check.timeout || 60000;

  try {
    // Use provided shell API or throw error
    if (!options.shell) {
      throw new Error('Shell API is required. Pass options.shell with exec() method.');
    }

    const result = await options.shell.exec(check.command, [], { cwd, timeout });

    return {
      id: check.id,
      name: check.name,
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      timingMs: Date.now() - startTime,
      error: result.code !== 0 ? `Command failed with exit code ${result.code}` : undefined,
    };
  } catch (error) {
    return {
      id: check.id,
      name: check.name,
      ok: false,
      exitCode: 1,
      timingMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Run multiple checks
 *
 * @example
 * ```typescript
 * const checks = [
 *   { id: 'build', name: 'Build', command: 'npm run build' },
 *   { id: 'test', name: 'Tests', command: 'npm test' },
 * ];
 *
 * const results = await runChecks(checks, {
 *   cwd: '/path/to/repo',
 *   shell: ctx.api.shell,
 * });
 *
 * const allPassed = results.every(r => r.ok);
 * ```
 */
export async function runChecks(
  checks: CheckConfig[],
  options: RunChecksOptions = {}
): Promise<CheckResult[]> {
  if (!checks || checks.length === 0) {
    return [];
  }

  if (options.parallel) {
    // Run all checks in parallel
    return Promise.all(checks.map((check) => runSingleCheck(check, options)));
  } else {
    // Run checks sequentially
    const results: CheckResult[] = [];
    for (const check of checks) {
      const result = await runSingleCheck(check, options);
      results.push(result);

      // Optional: stop on first failure (can be made configurable)
      // if (!result.ok) break;
    }
    return results;
  }
}
