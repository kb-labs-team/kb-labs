import { defineConfig } from "vitest/config";
import nodePreset from "@kb-labs/devkit/vitest/node";

export default defineConfig({
  ...nodePreset,
  test: {
    ...nodePreset.test,
    globals: false,
    coverage: {
      ...(nodePreset.test?.coverage || {}),
      all: true,
      reportsDirectory: "./coverage",
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/__tests__/**",
        "**/*.d.ts",
        "**/types.ts",
        "**/types/**",
      ],
    },
  },
});
