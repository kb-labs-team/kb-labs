#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveCorepackHome({
  corepackHome = process.env.COREPACK_HOME,
  xdgCacheHome = process.env.XDG_CACHE_HOME,
  home = os.homedir(),
  cwd = process.cwd(),
} = {}) {
  const configuredHome = corepackHome || path.join(xdgCacheHome || path.join(home, '.cache'), 'node', 'corepack');
  return path.resolve(cwd, configuredHome);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(resolveCorepackHome());
}
