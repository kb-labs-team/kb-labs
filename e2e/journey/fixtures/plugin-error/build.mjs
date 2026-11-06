import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [resolve(directory, '../build-manifest.mjs'), directory], { stdio: 'inherit' });
