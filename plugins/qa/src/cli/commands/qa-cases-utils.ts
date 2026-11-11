import { isAbsolute, resolve } from 'node:path';
export function resolveCatalogPath(cwd: string, configuredPath?: string): string {
  const value = configuredPath ?? 'docs/qa/scenarios';
  return isAbsolute(value) ? value : resolve(cwd, value);
}
