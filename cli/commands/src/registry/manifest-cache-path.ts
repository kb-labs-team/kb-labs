/**
 * Location of the CLI manifest discovery cache.
 *
 * It is per-project runtime state (ADR-0044), so it lives in
 * `<KB_HOME>/state/<projectId>/cache/`, never in `<project>/.kb/`. A cache an
 * older version left in the repository is not read.
 */
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';

/** Where the cache is read from and written to. */
export function manifestCachePath(cwd: string): string {
  return resolveRuntimeStatePath(cwd, ['cache', 'cli-manifests.json']);
}
