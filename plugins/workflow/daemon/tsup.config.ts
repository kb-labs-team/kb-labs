import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';
import { readFileSync } from 'node:fs';

// Read package.json at build time
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  ...nodePreset,
  entry: ['src/index.ts', 'src/bin.ts', 'src/manifest.ts'],
  outDir: 'dist',
  // Inject version at build time
  define: {
    '__WORKFLOW_DAEMON_VERSION__': JSON.stringify(pkg.version),
  },
});
