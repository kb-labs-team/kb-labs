import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';
import binPreset from '@kb-labs/devkit/tsup/bin';

export default defineConfig([
  // Bin build (bin.js) - standalone executable (build first to clean)
  {
    ...binPreset,
    tsconfig: "tsconfig.build.json",
    entry: {
      bin: 'src/bin.ts',
    },
    dts: true, // No types for bin (already set in binPreset but explicit)
    banner: {
      js: '#!/usr/bin/env node',
    },
  },

  // Library build (index.js) - for importing as module
  {
    ...nodePreset,
    tsconfig: "tsconfig.build.json",
    entry: {
      index: 'src/index.ts',
      manifest: 'src/manifest.ts',
    },
    clean: false, // Don't clean (already cleaned by bin build)
  },
]);
