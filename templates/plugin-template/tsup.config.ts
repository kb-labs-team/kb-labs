import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/index.ts',
    'src/manifest.v3.ts',
    'src/cli/index.ts',
    'src/cli/commands/**/*.ts',
    'src/rest/index.ts',
    'src/rest/handlers/**/*.ts',
    'src/rest/schemas/**/*.ts',
    'src/core/index.ts',
    'src/contracts/index.ts',
    'src/contracts/**/*.ts',
    'src/lifecycle/index.ts',
  ],
  dts: true,
});
