/**
 * Mind configuration (`configSection: 'mind'`).
 *
 * Pure wire/config types — no platform internals. `resolveMindConfig` merges a
 * partial file config onto defaults so callers always get a complete config.
 */

import { z } from 'zod';

export const ChunkConfigSchema = z.object({
  /** Target chunk size in tokens. */
  maxTokens: z.number().int().positive().default(400),
  /** Overlap between adjacent chunks, in tokens. */
  overlapTokens: z.number().int().nonnegative().default(50),
  /** Use AST-aware chunking where a parser exists (falls back to sliding window). */
  ast: z.boolean().default(true),
});

/** Per-mode pipeline budget. Modes are configs of one pipeline, not code paths. */
export const ModeBudgetSchema = z.object({
  /** Max chunks fed into the answer stage. */
  maxChunks: z.number().int().positive(),
  /** Max sub-queries from decomposition (0 = no decomposition). */
  maxSubqueries: z.number().int().nonnegative(),
  /** Completeness-check iterations. */
  maxIterations: z.number().int().nonnegative(),
  /** Whether the synthesize stage calls the LLM. */
  useLLM: z.boolean(),
});

export const ModesConfigSchema = z.object({
  instant: ModeBudgetSchema.default({
    maxChunks: 5,
    maxSubqueries: 0,
    maxIterations: 0,
    useLLM: false,
  }),
  auto: ModeBudgetSchema.default({
    maxChunks: 8,
    maxSubqueries: 3,
    maxIterations: 1,
    useLLM: true,
  }),
  thinking: ModeBudgetSchema.default({
    maxChunks: 12,
    maxSubqueries: 5,
    maxIterations: 3,
    useLLM: true,
  }),
});

export const RetrievalConfigSchema = z.object({
  /** Default number of results returned by `search`. */
  limit: z.number().int().positive().default(10),
  /** Reciprocal-rank-fusion constant. */
  rrfK: z.number().int().positive().default(60),
  /** Enable heuristic reranking of fused candidates. */
  rerank: z.boolean().default(true),
  /** Enable semantic dedup of retrieved chunks. */
  dedup: z.boolean().default(true),
  /**
   * HyDE (Hypothetical Document Embeddings): embed an LLM-generated hypothetical
   * answer instead of the raw query for the vector search (BM25 still uses the
   * raw query). Trades one LLM call per query for better concept-query recall.
   * Off by default — enable only where the bench A/B shows a lift.
   */
  hyde: z.boolean().default(false),
  /**
   * Query expansion: ask the LLM for related identifiers/synonyms and append
   * them to the BM25 (lexical) query, so vocabulary mismatch between the query
   * wording and the code/doc terms still surfaces lexical hits. Orthogonal to
   * HyDE (which bridges the vector side). Trades one LLM call per query.
   * Off by default — enable only where the bench A/B shows a lift.
   */
  expand: z.boolean().default(false),
});

export const ConfidenceConfigSchema = z.object({
  /** Below this, agent answers abstain in strict mode. */
  floor: z.number().min(0).max(1).default(0.3),
});

/**
 * Index scope. Either a single path/glob (shorthand) or an explicit
 * include/exclude set. Paths are repo-relative; a bare dir means "everything
 * under it". `exclude` globs are subtracted from `include` at discovery time.
 *
 *   "core"                                   just core/
 *   { include: ["core","plugins","sdk"] }    those roots
 *   { include: ["."], exclude: ["sites/**"] } whole repo minus noise
 */
export const IndexScopeSchema = z.union([
  z.string(),
  z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .strict(),
]);
export type IndexScope = z.infer<typeof IndexScopeSchema>;

/** Normalized scope the engine consumes. */
export interface ResolvedScope {
  /** Repo-relative roots/globs to index (default: whole repo). */
  include: string[];
  /** Globs subtracted from the include set. */
  exclude: string[];
}

/** Normalize the config/shorthand scope into `{ include, exclude }`. */
export function resolveScope(scope: IndexScope | undefined): ResolvedScope {
  if (scope === undefined) {
    return { include: ['.'], exclude: [] };
  }
  if (typeof scope === 'string') {
    return { include: [scope], exclude: [] };
  }
  return {
    include: scope.include && scope.include.length > 0 ? scope.include : ['.'],
    exclude: scope.exclude ?? [],
  };
}

export const IndexConfigSchema = z.object({
  /** Path/glob or include/exclude set indexed into this index (CLI `--scope` overrides). */
  scope: IndexScopeSchema.optional(),
  /** Human label (optional, for status/UX). */
  label: z.string().optional(),
  /** Per-index chunk overrides; unset fields fall back to the global `chunk`. */
  chunk: ChunkConfigSchema.partial().optional(),
  /** Per-index retrieval overrides; unset fields fall back to global `retrieval`. */
  retrieval: RetrievalConfigSchema.partial().optional(),
});

export const MindConfigSchema = z.object({
  /** Default index used when a command omits `--index`. */
  defaultIndex: z.string().default('default'),
  /** Named indexes with per-index scope + overrides. */
  indexes: z.record(z.string(), IndexConfigSchema).default({}),
  chunk: ChunkConfigSchema.default({}),
  retrieval: RetrievalConfigSchema.default({}),
  modes: ModesConfigSchema.default({}),
  confidence: ConfidenceConfigSchema.default({}),
});

export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;
export type IndexConfig = z.infer<typeof IndexConfigSchema>;
export type MindConfig = z.infer<typeof MindConfigSchema>;
export type MindConfigInput = z.input<typeof MindConfigSchema>;
export type ModeBudget = z.infer<typeof ModeBudgetSchema>;

/** Chunk + retrieval settings effective for a given index, overrides applied. */
export interface EffectiveIndexConfig {
  /** Normalized include/exclude the engine discovers against. */
  scope: ResolvedScope;
  chunk: ChunkConfig;
  retrieval: RetrievalConfig;
}

/**
 * Resolve the effective settings for an index: global config with the named
 * index's overrides layered on top. Unknown index → global defaults.
 */
export function effectiveIndexConfig(config: MindConfig, indexId: string): EffectiveIndexConfig {
  const idx = config.indexes[indexId];
  return {
    scope: resolveScope(idx?.scope),
    chunk: { ...config.chunk, ...idx?.chunk },
    retrieval: { ...config.retrieval, ...idx?.retrieval },
  };
}

/**
 * Merge a partial file config onto schema defaults. Always returns a fully
 * populated, validated config.
 */
export function resolveMindConfig(input: MindConfigInput | undefined): MindConfig {
  return MindConfigSchema.parse(input ?? {});
}
