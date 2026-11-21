import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

// Include the CLI fixture's logger adapter in the master baseline build outputs.
export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: ['src/index.ts', 'src/manifest.ts'],
  dts: true,
});
