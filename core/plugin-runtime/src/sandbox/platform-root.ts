import { dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePlatformRoot } from '@kb-labs/core-workspace';

/** Resolve only from trusted execution metadata or this runtime's installed module location. */
export async function resolveExecutionPlatformRoot(
  explicitRoot: string | undefined,
  moduleUrl: string,
): Promise<string | undefined> {
  if (explicitRoot) {
    return realpath(explicitRoot);
  }
  const result = await resolvePlatformRoot({
    moduleUrl,
    startDir: dirname(fileURLToPath(moduleUrl)),
    env: {},
  });
  return result.source === 'module' ? realpath(result.rootDir) : undefined;
}
