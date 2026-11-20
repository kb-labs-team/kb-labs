import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';
import binPreset from '@kb-labs/devkit/tsup/bin';

export default defineConfig([
  // Bin — standalone process entry, bundled as CJS.
  {
    ...binPreset,
    tsconfig: 'tsconfig.build.json',
    entry: { bin: 'src/bin.ts' },
    banner: { js: '#!/usr/bin/env node' },
  },
  // Library — index + manifest re-exported for consumers.
  {
    ...nodePreset,
    tsconfig: 'tsconfig.build.json',
    entry: ['src/index.ts', 'src/manifest.ts', 'src/project-module.ts'],
    clean: false,
  },
]);
