/**
 * @module @kb-labs/release/checks
 * Simple checks runner for release manager
 *
 * @example
 * ```typescript
 * import { runChecks } from '@kb-labs/release/checks';
 *
 * const checks = [
 *   { id: 'build', name: 'Build', command: 'npm run build' },
 *   { id: 'test', name: 'Tests', command: 'npm test' },
 *   { id: 'lint', name: 'Lint', command: 'npm run lint' },
 * ];
 *
 * const results = await runChecks(checks, {
 *   cwd: repoRoot,
 *   shell: ctx.api.shell,
 * });
 *
 * const allPassed = results.every(r => r.ok);
 * if (!allPassed) {
 *   const failed = results.filter(r => !r.ok);
 *   console.error('Failed checks:', failed.map(f => f.name).join(', '));
 * }
 * ```
 */

export { runChecks } from './runner';
export type { CheckConfig, CheckResult, RunChecksOptions } from './types';
