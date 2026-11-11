/**
 * Public contracts for KB Labs Mind (RAG) plugin.
 *
 * Thin "wire" boundary: schemas, flags, config, and route constants that cross
 * between CLI, REST, and any future consumer. Imports only from `@kb-labs/sdk`
 * and `zod` — never platform internals.
 *
 * @module @kb-labs/mind/contracts
 */

export * from './routes';
export * from './config';
export * from './trace';
export * from './flags';

// Wire schemas
export * from './schema/agent.schema';
export * from './schema/search.schema';
export * from './schema/index.schema';
export * from './schema/query.schema';
export * from './schema/explore.schema';
export * from './schema/drop.schema';
export * from './schema/sync.schema';
export * from './schema/status.schema';
