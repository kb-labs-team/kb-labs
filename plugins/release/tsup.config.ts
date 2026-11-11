import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  entry: [
    'src/**/*.ts',
    'src/index.ts',
    'src/manifest.ts',
    'src/setup/handler.ts',
    'src/contracts/release.schema.ts',
    'src/cli/commands/**/*.ts',  // Auto-include all CLI commands
    'src/rest/handlers/**/*.ts', // Auto-include all REST handlers
  ],
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
});

