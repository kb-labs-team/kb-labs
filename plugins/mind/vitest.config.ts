import { defineConfig } from 'vitest/config';
import baseConfig from '@kb-labs/devkit/vitest/node';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    globals: true,
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
