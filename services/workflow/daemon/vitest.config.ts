import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import nodePreset from "@kb-labs/devkit/vitest/node.js";

export default defineConfig({
  ...nodePreset,
  resolve: {
    alias: {
      "@kb-labs/core-project-registry/file-lock": fileURLToPath(
        new URL("../../../core/project-registry/src/file-lock.ts", import.meta.url),
      ),
      "@kb-labs/workflow-engine/project-run-storage": fileURLToPath(
        new URL("../engine/src/project-run-storage.ts", import.meta.url),
      ),
      "@kb-labs/workflow-engine": fileURLToPath(
        new URL("../engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    ...nodePreset.test,
  },
});
