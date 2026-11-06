/**
 * Core RAG engine for KB Labs Mind.
 *
 * Dry business logic organized by verb: ingest -> retrieval -> answer, plus
 * the `pipeline` primitive. The engine consumes platform adapters injected via
 * `MindServices` — it never imports platform internals and never knows which
 * concrete tool (Qdrant, in-memory, …) is behind them.
 *
 * @module @kb-labs/mind/core
 */

export { createMind } from './mind';
export type { Mind, CreateMindOptions } from './mind';

export type { MindServices } from './services';
export { Tracer } from './pipeline';
export type { Stage, Clock } from './pipeline';

export type { Chunk, ChunkMeta, IndexManifest } from './types';
export { chunkId, kindFromPath } from './types';

// Stage-level exports for benchmarks and advanced consumers.
export { slidingWindowChunks } from './ingest/chunk';
export { structuralChunks, chunkFile } from './ingest/structural';
export { ingest } from './ingest/ingest';
export type { IngestProgress, IngestInput, IngestResult } from './ingest/ingest';
export { retrieve } from './retrieval/retrieve';
export type { RankedChunk, RetrieveInput, RetrieveOutput } from './retrieval/retrieve';
export { bm25Search, tokenize } from './retrieval/bm25';
export { rrfFuse, intentWeights } from './retrieval/fuse';
export type { QueryIntent } from './retrieval/fuse';
export { rerank } from './retrieval/rerank';
export { dedupRanked } from './retrieval/dedup';
export { verifySources, computeConfidence } from './answer/verify';
export type { VerificationResult, ConfidenceResult } from './answer/verify';
export { checkFields, extractSymbols } from './answer/field-check';
export type { FieldCheckResult } from './answer/field-check';
export { decompose } from './answer/decompose';
export { synthesizeAnswer, buildAgentResponse, toSources } from './answer/answer';
export { recordQuery, recentQueries } from './feedback/history';
export { syncAdd, syncUpdate, syncDelete } from './sync';
export type { SyncOptions, SyncCounts } from './sync';
export { toSearchResults } from './answer/synthesize';
export { loadManifest, saveManifest } from './index-store';
