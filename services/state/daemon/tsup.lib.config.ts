import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: "tsconfig.build.json",
  entry: {
    index: 'src/index.ts',
    manifest: 'src/manifest.ts',
  },
  clean: false, // Don't clean (already cleaned by bin build)
});
