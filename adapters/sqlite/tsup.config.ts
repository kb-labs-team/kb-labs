import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

// Include runtime manifest defaults in the master baseline build outputs.
export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: ['src/index.ts', 'src/kv.ts', 'src/vector-store.ts', 'src/manifest.ts'],
  dts: true,
});
