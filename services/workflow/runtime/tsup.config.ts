import { defineConfig } from 'tsup'
import nodePreset from '@kb-labs/devkit/tsup/node'

export default defineConfig({
  ...nodePreset,
  dts: true, // Re-enabled after V3 migration
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
  entry: {
    index: 'src/index.ts',
  },
  external: [
    ...(nodePreset.external || []),
    'fast-glob',
  ],
})
