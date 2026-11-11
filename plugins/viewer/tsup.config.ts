import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: ['src/**/*.ts',
    'src/index.ts', 'src/manifest.ts', 'src/rest/schemas.ts', 'src/rest/handlers/*.ts'],
  external: ['@kb-labs/sdk', '@kb-labs/viewer/contracts', '@kb-labs/viewer/core'],
  dts: { resolve: false, skipLibCheck: true },
  clean: true,
  sourcemap: true,
});
