import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/index.ts',
    'src/manifest.v3.ts',
    'src/contracts/index.ts',
    'src/cli/index.ts',
    'src/cli/commands/**/*.ts',
  ],
  external: [
    '@kb-labs/core-platform',
    'react',
    'react-dom',
  ],
});
