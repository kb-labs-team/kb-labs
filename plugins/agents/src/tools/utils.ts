/**
 * Shared utilities for agent tool implementations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Normalize offset and limit parameters from tool input.
 *
 * Handles NaN, negative values, and enforces configured max/default limits.
 * Previously duplicated in filesystem.ts and search.ts.
 *
 * @example
 * const { offset, limit } = normalizeOffsetLimit(input, {
 *   defaultLimit: FILESYSTEM_CONFIG.defaultLines,
 *   maxLimit: FILESYSTEM_CONFIG.maxLinesPerRead,
 * });
 */
export function normalizeOffsetLimit(
  input: Record<string, unknown>,
  config: { defaultLimit: number; maxLimit: number },
): { offset: number; limit: number } {
  const rawOffset = Number(input.offset);
  const rawLimit = Number(input.limit);

  const offset =
    Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(config.maxLimit, Math.floor(rawLimit))
      : config.defaultLimit;

  return { offset, limit };
}

/**
 * Validate that a file path stays within the working directory.
 *
 * Resolves symlinks to prevent symlink-based traversal bypasses.
 * Uses path.relative() which is more robust than startsWith().
 *
 * Previously duplicated in filesystem.ts and mass-replace.ts.
 */
export function validatePath(
  workingDir: string,
  filePath: string,
): { valid: boolean; resolved: string; error?: string } {
  let resolved = path.resolve(workingDir, filePath);

  // Resolve symlinks to prevent symlink-based bypasses
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch {
    // If realpath fails, continue with resolved path (might be a non-existent file)
  }

  const relative = path.relative(workingDir, resolved);

  if (relative.startsWith('..')) {
    return {
      valid: false,
      resolved,
      error: `PATH_TRAVERSAL_ERROR: Cannot access "${filePath}" - path is outside working directory.

HOW TO FIX: Use paths relative to the working directory. Do not use ".." to navigate above it.
WORKING_DIR: ${workingDir}
ATTEMPTED_PATH: ${resolved}`,
    };
  }

  return { valid: true, resolved };
}

/**
 * Suggest a similar directory when the requested one doesn't exist.
 *
 * Handles common agent mistakes like nested paths (e.g. "foo/bar" when "foo-bar/" exists).
 * Returns null if no good suggestion found.
 */
export function suggestDirectory(workingDir: string, requestedDir: string): string | null {
  // Normalize: strip leading ./ and trailing /
  const clean = requestedDir.replace(/^\.\//, '').replace(/\/$/, '');
  if (!clean || clean === '.') {return null;}

  // Only suggest for paths that look like nested mistakes (contain /)
  const parts = clean.split('/');
  if (parts.length < 2) {return null;}

  // Strategy: join first two segments with - instead of /
  // e.g. "kb-labs/agents" → "kb-labs-agents"
  const candidate = `${parts[0]}-${parts[1]}`;
  const rest = parts.slice(2).join('/');
  const fullCandidate = rest ? path.join(candidate, rest) : candidate;
  const resolved = path.resolve(workingDir, fullCandidate);

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return fullCandidate;
  }

  return null;
}
