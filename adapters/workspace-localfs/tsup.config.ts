import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node.js';

// Include the runtime workspace-provider manifest in the master baseline build outputs.
export default defineConfig({ ...nodePreset });
