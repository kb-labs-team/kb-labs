import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import { isWorkspaceDevelopmentMode, type PlatformModeSource } from './platform-mode.js';

/** Resolve the installed platform version from its receipt, or the release
 * owner's package manifest when running from a development checkout. */
export async function resolvePlatformVersion(
  platformRoot: string,
  mode: PlatformModeSource,
): Promise<string> {
  const development = isWorkspaceDevelopmentMode(mode);
  const file = development
    ? path.join(platformRoot, 'core', 'runtime', 'package.json')
    : path.join(platformRoot, '.kb', 'v2', 'receipt.json');
  let record: unknown;
  try {
    record = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_CLI_PLATFORM_VERSION_UNAVAILABLE'));
  }
  const version = development
    ? (record as { version?: unknown } | null)?.version
    : (record as { plan?: { serviceGraph?: { platformVersion?: unknown } } } | null)
      ?.plan?.serviceGraph?.platformVersion;
  if (typeof version === 'string' && version.trim()) return version;
  throw new ErrorEnvelopeError(createErrorEnvelope('KB_CLI_PLATFORM_VERSION_UNAVAILABLE'));
}
