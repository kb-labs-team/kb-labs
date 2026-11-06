import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    reporters: ['default'],
    include: [
      'src/__tests__/cli/**/*.cli.test.ts',
      'tests/**/*.cli.test.ts',
      'tests/**/*.cli.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 5_000,
    coverage: {
      enabled: false,
    },
  },
})
