/**
 * @module @kb-labs/core-discovery/integrity
 * SRI integrity computation and parsing for marketplace packages.
 *
 * Packages are identified by a hash of their package.json (not the full tarball).
 * This keeps verification fast and stable across tarball recompression.
 */

import * as crypto from 'node:crypto';
import { fs } from './recording-filesystem.js';
import * as path from 'node:path';

/**
 * Compute the SRI integrity string for an arbitrary file.
 *
 * Format: `sha256-<base64>` (SubResource Integrity convention).
 * Throws if the file cannot be read.
 */
export async function computeFileIntegrity(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('base64');
  return `sha256-${hash}`;
}

/**
 * Compute the SRI integrity string for a package by hashing its package.json.
 * Kept for backwards compatibility — delegates to computeFileIntegrity.
 */
export async function computePackageIntegrity(pkgRoot: string): Promise<string> {
  return computeFileIntegrity(path.join(pkgRoot, 'package.json'));
}

/**
 * Compute the SRI integrity string for a manifest file (e.g. dist/index.js).
 * Used by CLI discovery to detect when a plugin was rebuilt.
 */
export async function computeManifestIntegrity(manifestPath: string): Promise<string> {
  return computeFileIntegrity(manifestPath);
}

/**
 * Parse an SRI integrity string (e.g. `sha256-<base64>`) into its components.
 * Returns `null` when the value is malformed.
 */
export function parseIntegrity(value: string): { algorithm: string; hash: string } | null {
  const dash = value.indexOf('-');
  if (dash <= 0 || dash === value.length - 1) {
    return null;
  }
  return {
    algorithm: value.slice(0, dash),
    hash: value.slice(dash + 1),
  };
}
