import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
  entry: [
    'src/index.ts',
    'src/manifest.ts',
    'src/contracts/index.ts',
    'src/core/index.ts',
    'src/history/index.ts',
    'src/kernel/index.ts',
    'src/mcp/index.ts',
    'src/runtime/index.ts',
    'src/sdk/index.ts',
    'src/sdk/testing.ts',
    'src/store/index.ts',
    'src/tools/index.ts',
    'src/tracing/index.ts',
    // 'src/lifecycle/setup.ts', // TODO: Lifecycle SDK not available yet
    'src/cli/commands/**/*.ts',   // Auto-include all CLI commands
    'src/rest/handlers/**/*.ts',  // Auto-include all REST handlers
    'src/rest/schemas/**/*.ts',   // Auto-include all REST schemas
    'src/ws/**/*.ts',             // Auto-include all WebSocket handlers
    'src/studio/widgets/**/*.tsx', // Auto-include all Studio widgets
    // 'src/jobs/**/*.ts' // TODO: Jobs not supported in V3 SDK yet
  ],
  external: [
    '@kb-labs/plugin-manifest',
    '@kb-labs/shared-cli-ui',
    '@kb-labs/core-platform',
    'react',
    'react-dom'
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
    return options;
  }
});
