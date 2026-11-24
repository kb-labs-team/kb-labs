import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

const presetExternal = nodePreset.external || [];
const sharedExternal = [
  ...Array.isArray(presetExternal) ? presetExternal : [],
  // Keep the runtime package external to avoid duplicate platform singletons.
  '@kb-labs/core-runtime',
  '@kb-labs/core-sandbox',
];

export default defineConfig([
  {
    ...nodePreset,
    entry: {
      index: 'src/index.ts',
      'runtime/execution-error': 'src/runtime/execution-error.ts',
    },
    tsconfig: 'tsconfig.build.json', // Keep workspace package boundaries in the runtime bundle.
    clean: false,
    dts: { resolve: false },
    external: sharedExternal,
  },
  {
    // Keep the launcher unbundled so its preflight and dynamic imports remain ordered,
    // without changing the CLI runtime bundle's evaluation order.
    entry: {
      bin: 'src/bin.ts',
      'runtime/result-serializer': 'src/runtime/result-serializer.ts',
    },
    outDir: 'dist',
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    bundle: false,
    clean: false,
    dts: false,
  },
]);
