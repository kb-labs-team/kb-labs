import { defineConfig } from "tsup";
import nodePreset from "@kb-labs/devkit/tsup/node";

// Include default cache discovery in the master baseline build outputs.
export default defineConfig({
  ...nodePreset,
  tsconfig: "tsconfig.json",
  entry: ["src/index.ts", "src/manifest.ts"],
  dts: true,
});
