import { defineConfig } from 'vitest/config';
import nodePreset from '@kb-labs/devkit/vitest/node';

export default defineConfig({
  ...nodePreset,
  test: {
    ...nodePreset.test,
    coverage: {
      ...nodePreset.test?.coverage,
      exclude: [
        ...(nodePreset.test?.coverage?.exclude ?? []),
        '**/dist/**',
        '**/fixtures/**',
        '**/__tests__/**',
        '**/*.spec.*',
        '**/*.test.*',
        '**/vitest.config.ts',
        '**/tsup.config.ts',
        '**/tsconfig*.json',
        '**/index.ts',
      ],
    },
  },
});
