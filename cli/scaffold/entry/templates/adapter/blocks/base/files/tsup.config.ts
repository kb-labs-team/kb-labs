import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  entry: ['src/index.ts', 'src/manifest.ts'],
  dts: { resolve: true, skipLibCheck: true },
  clean: true,
  sourcemap: true,
});
