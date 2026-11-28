import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [resolve(directory, '../build-manifest.mjs'), directory], { stdio: 'inherit' });
mkdirSync(resolve(directory, 'dist'), { recursive: true });
cpSync(resolve(directory, 'src/settings-schema.mjs'), resolve(directory, 'dist/settings-schema.mjs'));
