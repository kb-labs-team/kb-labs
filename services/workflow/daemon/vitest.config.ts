import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import nodePreset from "@kb-labs/devkit/vitest/node.js";

export default defineConfig({
  ...nodePreset,
  resolve: {
    alias: {
      "@kb-labs/workflow-engine": fileURLToPath(
        new URL("../engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    ...nodePreset.test,
  },
});
