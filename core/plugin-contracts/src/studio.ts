/**
 * @module @kb-labs/plugin-contracts/studio
 *
 * Studio V2 types — Module Federation pages.
 * Re-exports from manifest.ts for convenience.
 */

export type {
  StudioConfig,
  StudioPageEntry,
  StudioMenuEntry,
} from './manifest.js';

import type { StudioMenuEntry, StudioPageEntry } from './manifest.js';

/** One installed plugin's browser-safe Studio V2 contribution. */
export interface StudioPluginEntryV2 {
  pluginId: string;
  displayName?: string;
  pluginVersion?: string;
  remoteName: string;
  remoteEntryUrl: string;
  pages: StudioPageEntry[];
  menus: StudioMenuEntry[];
}

/** Registry returned by `GET /api/v1/studio/registry`. */
export interface StudioRegistryV2 {
  schema: 'kb.studio/2';
  schemaVersion: 2;
  generatedAt: string;
  plugins: StudioPluginEntryV2[];
}
