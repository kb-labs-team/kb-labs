import { createHash } from 'node:crypto';
import { promises as fs, realpath } from 'node:fs';
import { promisify } from 'node:util';
import { isAbsolute, parse, resolve } from 'node:path';
import type { ProjectId } from '@kb-labs/core-contracts';
import { ProjectRegistryError } from './errors.js';

/**
 * `realpath(3)` variant: symlinks resolved and the on-disk spelling (case) reported.
 * Resolved at call time so importing this module never touches `node:fs` exports.
 */
const realpathNative = (path: string): Promise<string> => promisify(realpath.native)(path);

export const PROJECT_ID_PREFIX = 'prj_';
const ID_HEX_LENGTH = 16;

/**
 * Normalizes an already-canonical absolute path for hashing: NFC, no trailing
 * separator, and lower-cased on Windows (case-insensitive file system).
 */
function normalizeForHash(canonicalPath: string): string {
  let value = canonicalPath.normalize('NFC');
  const root = parse(value).root;
  while (value.length > root.length && (value.endsWith('/') || value.endsWith('\\'))) {
    value = value.slice(0, -1);
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Pure derivation from a canonical absolute path. The same path always yields the same id. */
export function deriveProjectId(canonicalPath: string): ProjectId {
  if (!isAbsolute(canonicalPath)) {
    throw new ProjectRegistryError({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'path' } }, `Project id can only be derived from an absolute path, got "${canonicalPath}".`);
  }
  const digest = createHash('sha256').update(normalizeForHash(canonicalPath), 'utf8').digest('hex');
  return `${PROJECT_ID_PREFIX}${digest.slice(0, ID_HEX_LENGTH)}`;
}

export function isProjectId(value: string): boolean {
  return new RegExp(`^${PROJECT_ID_PREFIX}[0-9a-f]{${ID_HEX_LENGTH}}$`).test(value);
}

/**
 * Resolves a user-supplied folder to its canonical absolute path: relative
 * paths are resolved against the cwd, symlinks are followed and the on-disk
 * spelling is used (`realpath.native`), so aliases of one folder map to one id.
 * Throws typed errors for a missing, non-directory or unreadable path.
 */
export async function canonicalizeProjectPath(input: string): Promise<string> {
  const absolute = resolve(input);
  let canonical: string;
  try {
    canonical = await realpathNative(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ProjectRegistryError({ code: 'KB_PROJECT_PATH_NOT_FOUND', details: {
        path: absolute,
      } }, `Path does not exist: ${absolute}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ProjectRegistryError({ code: 'KB_PROJECT_NO_ACCESS', details: {
        path: absolute,
      } }, `No permission to read: ${absolute}`);
    }
    throw error;
  }
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) {
    throw new ProjectRegistryError({ code: 'KB_PROJECT_NOT_A_DIRECTORY', details: {
      path: canonical,
    } }, `Not a directory: ${canonical}`);
  }
  try {
    await fs.access(canonical, fs.constants.R_OK);
  } catch {
    throw new ProjectRegistryError({ code: 'KB_PROJECT_NO_ACCESS', details: {
      path: canonical,
    } }, `No permission to read: ${canonical}`);
  }
  return canonical;
}
