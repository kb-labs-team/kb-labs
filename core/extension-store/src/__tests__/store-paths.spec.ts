import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeEntryKey,
  entryPackagePath,
  resolveEntryDir,
  resolveStoreRoot,
  storeCasDir,
  storeEntriesDir,
  storeLockPath,
  storeTmpDir,
} from '../store-paths.js';
import { ExtensionStoreError } from '../errors.js';

describe('encodeEntryKey', () => {
  it('replaces "/" with "+" in scoped names and appends the version', () => {
    expect(encodeEntryKey('@kb-labs/commit', '2.120.1')).toBe('@kb-labs+commit@2.120.1');
  });

  it('leaves an unscoped name untouched apart from the version suffix', () => {
    expect(encodeEntryKey('acme-deploy', '1.0.0')).toBe('acme-deploy@1.0.0');
  });

  it('rejects a name with path traversal', () => {
    expect(() => encodeEntryKey('../evil', '1.0.0')).toThrow(ExtensionStoreError);
  });

  it('rejects a version with path separators', () => {
    expect(() => encodeEntryKey('acme-deploy', '1.0.0/../../etc')).toThrow(ExtensionStoreError);
  });
});

describe('resolveStoreRoot', () => {
  it('honors an explicit root', () => {
    expect(resolveStoreRoot({ root: '/tmp/kb-test-home' })).toBe(join('/tmp/kb-test-home', 'store'));
  });

  it('falls back to KB_HOME from env, never the real HOME', () => {
    const root = resolveStoreRoot({ env: { KB_HOME: '/tmp/kb-test-home-2' } });
    expect(root).toBe(join('/tmp/kb-test-home-2', 'store'));
  });
});

describe('store layout paths', () => {
  const storeRoot = '/tmp/kb-test-home/store';

  it('lays out cas, tmp, entries and the lock file directly under the store root', () => {
    expect(storeCasDir(storeRoot)).toBe(join(storeRoot, 'cas'));
    expect(storeTmpDir(storeRoot)).toBe(join(storeRoot, 'tmp'));
    expect(storeEntriesDir(storeRoot)).toBe(join(storeRoot, 'entries'));
    expect(storeLockPath(storeRoot)).toBe(join(storeRoot, 'store.lock'));
  });

  it('resolves one entry directory per exact name+version', () => {
    const dir = resolveEntryDir(storeRoot, '@kb-labs/commit', '2.120.1');
    expect(dir).toBe(join(storeRoot, 'entries', '@kb-labs+commit@2.120.1'));
  });

  it('resolves the installed package path inside an entry, including scoped names', () => {
    const dir = resolveEntryDir(storeRoot, '@kb-labs/commit', '2.120.1');
    expect(entryPackagePath(dir, '@kb-labs/commit')).toBe(
      join(dir, 'node_modules', '@kb-labs', 'commit'),
    );
  });
});
