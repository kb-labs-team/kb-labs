import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/**/*.ts',
    'src/index.ts',
    'src/manifest.ts',
    'src/cli/commands/**/*.ts',
  ],
  external: [
    '@kb-labs/sdk',
  ],
  clean: true,
  sourcemap: true,
});
