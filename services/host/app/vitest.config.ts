import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: ['**/*.e2e.test.ts', '**/node_modules/**'],
    testTimeout: 15000,
  },
}));
