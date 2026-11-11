import { spawnSync } from 'child_process';
import { useCache } from '@kb-labs/sdk';

/** Default TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the latest published version of a package on npm, or null if not published.
 * Results are cached via useCache() with the given TTL.
 */
export async function getLatestNpmVersion(
  packageName: string,
  ttlMs = DEFAULT_TTL_MS
): Promise<string | null> {
  const cacheKey = `devlink:npm-version:${packageName}`;
  const cache = useCache();

  if (cache) {
    const cached = await cache.get<string | null>(cacheKey);
    // cache.get returns null for missing keys — only return if explicitly cached
    if (cached !== null && cached !== undefined) {return cached;}
  }

  let version: string | null;
  // spawnSync passes packageName as a discrete argv element — the OS never
  // interprets it as a shell command, preventing command injection.
  const proc = spawnSync('npm', ['view', packageName, 'version', '--json'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (proc.error || proc.status !== 0 || !proc.stdout?.trim()) {
    version = null;
  } else {
    try {
      // npm view returns a JSON string like "1.4.0" (with quotes)
      version = JSON.parse(proc.stdout.trim()) as string;
    } catch {
      version = null;
    }
  }

  if (cache) {
    await cache.set(cacheKey, version, ttlMs);
  }

  return version;
}

/**
 * Checks if a package exists on the npm registry.
 * Results are cached via useCache() with the given TTL.
 */
export async function isPublishedOnNpm(
  packageName: string,
  ttlMs = DEFAULT_TTL_MS
): Promise<boolean> {
  return (await getLatestNpmVersion(packageName, ttlMs)) !== null;
}

/**
 * Filters a list of package names to only those published on npm.
 * Runs checks concurrently.
 */
export async function filterPublishedPackages(
  packageNames: string[],
  ttlMs = DEFAULT_TTL_MS
): Promise<Set<string>> {
  const results = await Promise.all(
    packageNames.map(async name => ({
      name,
      published: await isPublishedOnNpm(name, ttlMs),
    }))
  );

  return new Set(results.filter(r => r.published).map(r => r.name));
}
