/**
 * @module @kb-labs/core-extension-store/store-paths
 * Path layout of `$KB_HOME/store` (ADR-0048 D2). No filesystem access here —
 * these are pure path helpers, callers create directories as needed.
 */

import { join, resolve } from 'node:path';
import { resolveKbHome } from '@kb-labs/core-project-registry';
import { ExtensionStoreError } from './errors.js';

/** A package name or version safe to fold into a filesystem path. */
const SAFE_SEGMENT = /^[^/\\]+$/;

export interface StoreRootOptions {
  /** Machine-level root. Defaults to `resolveKbHome(env)` (`$KB_HOME` or `~/.kb`). */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

/** `<root>/store` — the store root. `root` defaults to `$KB_HOME` (or `~/.kb`). */
export function resolveStoreRoot(options: StoreRootOptions = {}): string {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  return join(root, 'store');
}

/** Dedicated pnpm content-addressed store — never the user's default pnpm store (D2). */
export function storeCasDir(storeRoot: string): string {
  return join(storeRoot, 'cas');
}

/** Staging area: entries appear in `entries/` only via an atomic rename out of here. */
export function storeTmpDir(storeRoot: string): string {
  return join(storeRoot, 'tmp');
}

/** Root of published, immutable entries. */
export function storeEntriesDir(storeRoot: string): string {
  return join(storeRoot, 'entries');
}

/** Exclusive lock file guarding store mutations (same protocol as `projects.json.lock`, ADR-0044 §6). */
export function storeLockPath(storeRoot: string): string {
  return join(storeRoot, 'store.lock');
}

/**
 * Entry key: package name with every `/` replaced by `+`, then `@` + the exact
 * version, e.g. `@kb-labs/commit` @ `2.120.1` -> `@kb-labs+commit@2.120.1`.
 */
export function encodeEntryKey(name: string, version: string): string {
  assertSafeSegment(name, 'name');
  assertSafeVersion(version);
  return `${name.replace(/\//g, '+')}@${version}`;
}

/** `<store>/entries/<key>` for the given name+version. */
export function resolveEntryDir(storeRoot: string, name: string, version: string): string {
  return join(storeEntriesDir(storeRoot), encodeEntryKey(name, version));
}

/** `<entryDir>/node_modules/<name>` — where the installed package lives inside an entry. */
export function entryPackagePath(entryDir: string, name: string): string {
  return join(entryDir, 'node_modules', ...name.split('/'));
}

function assertSafeSegment(name: string, field: string): void {
  if (!name || name.startsWith('.') || name.split('/').some((part) => !part || !SAFE_SEGMENT.test(part))) {
    throw new ExtensionStoreError({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field } });
  }
}

function assertSafeVersion(version: string): void {
  if (!version || !SAFE_SEGMENT.test(version) || version.includes('..')) {
    throw new ExtensionStoreError({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'version' } });
  }
}
