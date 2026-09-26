/**
 * Location of the CLI manifest discovery cache.
 *
 * It is per-project runtime state (ADR-0044), so it lives in
 * `<KB_HOME>/state/<projectId>/cache/`, not in `<project>/.kb/`. The legacy
 * in-repo file is still read for one release; after that it is simply ignored.
 */
import { resolveRuntimeReadPath, resolveRuntimeStatePath } from '@kb-labs/core-project-registry';

const MANIFEST_CACHE_SEGMENTS = ['cache', 'cli-manifests.json'] as const;

/** Where the cache is written. */
export function manifestCacheWritePath(cwd: string): string {
  return resolveRuntimeStatePath(cwd, MANIFEST_CACHE_SEGMENTS).path;
}

/** Where the cache is read from: the new location, else the legacy in-repo file. */
export function manifestCacheReadPath(cwd: string): string {
  return resolveRuntimeReadPath(cwd, MANIFEST_CACHE_SEGMENTS);
}
