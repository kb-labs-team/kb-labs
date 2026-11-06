import { defineConfig } from 'tsup'
import nodePreset from '@kb-labs/devkit/tsup/node'

export default defineConfig({
  ...nodePreset,
  tsconfig: "tsconfig.build.json",
  entry: {
    index: 'src/index.ts',
    'command/index': 'src/command/index.ts',
    'manifest/index': 'src/manifest/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'adapters/infra/index': 'src/adapters/infra/index.ts',
    'hooks/index': 'src/hooks/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    'types/index': 'src/types/index.ts',
    'errors/index': 'src/errors/index.ts',
    'testing/index': 'src/testing/index.ts',
    'studio/index': 'src/studio/index.ts',
    'studio/catalog': 'src/studio/catalog.ts',
    'studio-build/index': 'src/studio-build/index.ts',
    'platform/index': 'src/platform/index.ts',
    'gateway/index': 'src/gateway/index.ts',
  },
  dts: { resolve: true },
  treeshake: false,
});
