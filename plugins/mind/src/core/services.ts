/**
 * Platform services Mind consumes.
 *
 * No custom ports, no platform internals — just a narrow slice of
 * `PlatformServices` from `@kb-labs/sdk`. The engine never knows which concrete
 * adapter (Qdrant, in-memory, …) sits behind these interfaces; `entry` passes
 * `ctx.platform` straight through, tests pass `createTestContext().platform`.
 */

import type { PlatformServices } from '@kb-labs/sdk';

export type MindServices = Pick<
  PlatformServices,
  'vectorStore' | 'embeddings' | 'llm' | 'cache' | 'storage' | 'logger'
>;

// Re-export the platform adapter interfaces so the rest of core imports them
// from one place — still sourced from @kb-labs/sdk, never platform internals.
export type {
  PlatformServices,
  IVectorStore,
  IEmbeddings,
  ILLM,
  ICache,
  IStorage,
  ILogger,
} from '@kb-labs/sdk';

// Vector value types live under the public `@kb-labs/sdk/adapters` subpath.
export type { VectorRecord, VectorSearchResult, VectorFilter } from '@kb-labs/sdk/adapters';
