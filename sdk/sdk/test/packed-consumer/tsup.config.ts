import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/manifest.ts', 'src/handler.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
