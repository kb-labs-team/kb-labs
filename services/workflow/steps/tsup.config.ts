import { defineConfig } from 'tsup'
import nodePreset from '@kb-labs/devkit/tsup/node'

export default defineConfig({
  ...nodePreset,
  dts: true,
  tsconfig: "tsconfig.build.json",
  entry: {
    index: 'src/index.ts',
    shell: 'src/shell.ts',
    approval: 'src/approval.ts',
    gate: 'src/gate.ts',
  },
})
