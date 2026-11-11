import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  // No banner here: src/bin.ts carries its own shebang. Adding a banner
  // would also prepend it to index.js, the pure library entry point.
});
