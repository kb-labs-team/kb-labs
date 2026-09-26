import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: ['src/index.ts', 'src/bin.ts', 'src/manifest.ts'],
  define: {
    '__REST_API_VERSION__': JSON.stringify('1.6.0'),
  },
});
