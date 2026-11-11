export { findRepoRoot } from '@kb-labs/sdk';
export { resolveScopePath } from './resolve-scope';

/**
 * Converts scope to safe directory name
 */
export function scopeToDir(scope: string): string {
  return scope
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .replace(/:/g, '-')
    .replace(/\*/g, '');
}

/**
 * Converts safe directory name back to scope
 */
export function dirToScope(dirName: string): string {
  if (dirName === 'root') {
    return 'root';
  }

  const parts = dirName.split('-');
  if (parts.length >= 2) {
    return '@' + parts[0] + '-' + parts[1] + '/' + parts.slice(2).join('-');
  }

  return dirName;
}
