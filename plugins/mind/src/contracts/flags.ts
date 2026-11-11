/**
 * Declarative CLI flag definitions for Mind commands (`defineFlags` from
 * `@kb-labs/sdk`). Shared between the manifest and command handlers.
 */

import { defineFlags } from '@kb-labs/sdk';

const JSON_DESC = 'Output JSON';
const INDEX_DESC = 'Index/corpus id';
const FORMAT_DESC = 'Output format';
const SNIPPET_DESC = 'How much source text per result';

export const indexFlags = defineFlags({
  index: { type: 'string', description: INDEX_DESC, examples: ['code', 'docs'] },
  scope: { type: 'string', description: 'Glob/path scope to index', examples: ['src/**', 'docs/**'] },
  root: { type: 'string', description: 'Project root to index (default: cwd)', examples: ['/path/to/repo'] },
  full: { type: 'boolean', description: 'Full rebuild instead of incremental delta', default: false },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const searchFlags = defineFlags({
  text: { type: 'string', description: 'Query text', required: true },
  index: { type: 'string', description: `${INDEX_DESC} to search` },
  intent: { type: 'string', description: 'Query intent hint', examples: ['lookup', 'concept', 'architecture'] },
  limit: { type: 'number', description: 'Max results' },
  snippet: { type: 'string', description: SNIPPET_DESC, examples: ['none', 'line', 'full'] },
  format: { type: 'string', description: FORMAT_DESC, examples: ['text', 'json'] },
  json: { type: 'boolean', description: `${JSON_DESC} (alias for --format json)`, default: false },
});

export const askFlags = defineFlags({
  text: { type: 'string', description: 'Question to answer', required: true },
  index: { type: 'string', description: `${INDEX_DESC} to query` },
  mode: { type: 'string', description: 'Answer depth', examples: ['instant', 'auto', 'thinking'] },
  snippet: { type: 'string', description: SNIPPET_DESC, examples: ['none', 'line', 'full'] },
  format: { type: 'string', description: FORMAT_DESC, examples: ['text', 'json'] },
  agent: { type: 'boolean', description: 'Emit machine-readable agent JSON (alias for --format json)', default: false },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const exploreFlags = defineFlags({
  task: { type: 'string', description: 'The task to orient around', required: true },
  index: { type: 'string', description: `${INDEX_DESC} to explore` },
  limit: { type: 'number', description: 'Max files in the map' },
  format: { type: 'string', description: FORMAT_DESC, examples: ['text', 'json'] },
  json: { type: 'boolean', description: `${JSON_DESC} (alias for --format json)`, default: false },
});

export const syncPathsFlags = defineFlags({
  index: { type: 'string', description: INDEX_DESC },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const syncDeleteFlags = defineFlags({
  index: { type: 'string', description: INDEX_DESC },
  yes: { type: 'boolean', description: 'Confirm deletion (recoverable via `kb mind sync add`)', default: false },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const syncListFlags = defineFlags({
  index: { type: 'string', description: INDEX_DESC },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const reindexFlags = defineFlags({
  index: { type: 'string', description: INDEX_DESC },
  full: { type: 'boolean', description: 'Full rebuild', default: false },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const statusFlags = defineFlags({
  index: { type: 'string', description: 'Limit to a single index' },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export const dropFlags = defineFlags({
  index: { type: 'string', description: 'Index to drop (vectors + manifest)', required: true },
  yes: { type: 'boolean', description: 'Skip the confirmation prompt', default: false },
  json: { type: 'boolean', description: JSON_DESC, default: false },
});

export type IndexFlags = typeof indexFlags.infer;
export type SearchFlags = typeof searchFlags.infer;
export type AskFlags = typeof askFlags.infer;
export type ExploreFlags = typeof exploreFlags.infer;
export type SyncPathsFlags = typeof syncPathsFlags.infer;
export type SyncDeleteFlags = typeof syncDeleteFlags.infer;
export type SyncListFlags = typeof syncListFlags.infer;
export type ReindexFlags = typeof reindexFlags.infer;
export type StatusFlags = typeof statusFlags.infer;
export type DropFlags = typeof dropFlags.infer;
