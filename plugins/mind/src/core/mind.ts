/**
 * Mind facade — the single object the plugin (CLI + REST) talks to.
 *
 * `createMind(services, config)` returns verbs that both the CLI commands and
 * REST handlers call identically, so behaviour is shared by construction.
 * Phase 2 ships `index` / `search` / `status`; `ask`, `sync`, `reindex` are
 * layered in later phases.
 */

import type {
  MindConfig,
  IndexRequest,
  IndexResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
  IndexSummary,
  HealthResponse,
  QueryRequest,
  AgentResponse,
  AgentQueryMode,
  ExploreRequest,
  ExploreResponse,
  SyncResponse,
  SyncListResponse,
  SyncStatusResponse,
  ReindexRequest,
  DropRequest,
  DropResponse,
} from '../contracts/index.js';
import { effectiveIndexConfig, resolveScope } from '../contracts/index.js';
import type { MindServices } from './services';
import type { RankedChunk } from './retrieval/retrieve';
import { ingest, type IngestProgress } from './ingest/ingest';
import { syncAdd, syncUpdate, syncDelete, type SyncOptions } from './sync';
import { retrieve } from './retrieval/retrieve';
import { rerank } from './retrieval/rerank';
import { dedupRanked } from './retrieval/dedup';
import { verifySources, computeConfidence } from './answer/verify';
import { applyFieldCheck } from './answer/field-check';
import { decompose } from './answer/decompose';
import { synthesizeAnswer, buildAgentResponse } from './answer/answer';
import { toExploreEntries, spreadOf, orientationSummary } from './answer/explore';
import { recordQuery } from './feedback/history';
import { toSearchResults } from './answer/synthesize';
import { loadManifest, staleMap, staleCount, deleteManifest, manifestExists } from './index-store';

export interface Mind {
  index(req: IndexRequest, onProgress?: (event: IngestProgress) => void): Promise<IndexResponse>;
  search(req: SearchRequest): Promise<SearchResponse>;
  ask(req: QueryRequest): Promise<AgentResponse>;
  explore(req: ExploreRequest): Promise<ExploreResponse>;
  reindex(req: ReindexRequest): Promise<IndexResponse>;
  drop(req: DropRequest): Promise<DropResponse>;
  syncAdd(paths: string[], indexId?: string): Promise<SyncResponse>;
  syncUpdate(paths: string[], indexId?: string): Promise<SyncResponse>;
  syncDelete(paths: string[], indexId?: string): Promise<SyncResponse>;
  syncList(indexId?: string): Promise<SyncListResponse>;
  syncStatus(indexId?: string): Promise<SyncStatusResponse>;
  status(indexId?: string): Promise<StatusResponse>;
  health(): Promise<HealthResponse>;
}

export interface CreateMindOptions {
  /** Workspace root that source paths are resolved against (default: process.cwd()). */
  cwd?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable ISO timestamp source for manifest bookkeeping. */
  isoNow?: () => string;
}

export function createMind(
  services: MindServices,
  config: MindConfig,
  options: CreateMindOptions = {},
): Mind {
  const now = options.now ?? (() => Date.now());
  const isoNow = options.isoNow ?? (() => new Date(now()).toISOString());
  const cwd = options.cwd ?? process.cwd();

  function resolveIndexId(indexId?: string): string {
    return indexId && indexId.trim() !== '' ? indexId : config.defaultIndex;
  }

  function syncOpts(indexId: string): SyncOptions {
    const eff = effectiveIndexConfig(config, indexId);
    return {
      indexId,
      cwd,
      chunk: { maxTokens: eff.chunk.maxTokens, overlapTokens: eff.chunk.overlapTokens },
      ast: eff.chunk.ast,
      now: isoNow(),
    };
  }

  return {
    async index(req, onProgress): Promise<IndexResponse> {
      const indexId = resolveIndexId(req.indexId);
      const eff = effectiveIndexConfig(config, indexId);
      const start = now();
      const result = await ingest(
        {
          indexId,
          cwd,
          // CLI `--scope` overrides the include set (keeping configured excludes);
          // otherwise use the index's configured include/exclude scope.
          scope: req.scope ? { include: [req.scope], exclude: eff.scope.exclude } : eff.scope,
          full: req.full,
          chunk: { maxTokens: eff.chunk.maxTokens, overlapTokens: eff.chunk.overlapTokens },
          ast: eff.chunk.ast,
          now: isoNow(),
          onProgress,
        },
        services,
      );
      const durationMs = now() - start;
      services.logger?.info('mind: index', {
        indexId,
        filesIndexed: result.filesIndexed,
        chunks: result.chunks,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        unchanged: result.unchanged,
        durationMs,
      });
      return { indexId, filesIndexed: result.filesIndexed, chunks: result.chunks, durationMs };
    },

    async search(req): Promise<SearchResponse> {
      const indexId = resolveIndexId(req.indexId);
      const retrieval = effectiveIndexConfig(config, indexId).retrieval;
      const limit = req.limit ?? retrieval.limit;
      const snippet = req.snippet ?? 'line';
      const t0 = now();

      // Over-fetch, then refine: retrieve -> rerank -> dedup.
      const retrieved = await retrieve(
        { text: req.text, indexId, limit: limit * 3, intent: req.intent, rrfK: retrieval.rrfK, hyde: retrieval.hyde, expand: retrieval.expand },
        services,
      );
      let ranked = retrieval.rerank ? rerank(retrieved.ranked, req.text) : retrieved.ranked;
      if (retrieval.dedup) {
        ranked = dedupRanked(ranked);
      }
      ranked = ranked.slice(0, limit);

      // Per-result freshness for the returned files only (bounded cost).
      const manifest = await loadManifest(services.storage, indexId);
      const stales = await staleMap(manifest, ranked.map((r) => r.chunk.path), cwd);
      const results = toSearchResults(ranked, { snippet, staleByFile: stales });
      const staleCount = [...stales.values()].filter(Boolean).length;
      const timingMs = now() - t0;

      services.logger?.info('mind: search', {
        indexId,
        results: results.length,
        semanticWinRate: retrieved.semanticWinRate,
        staleCount,
        timingMs,
      });
      return {
        results,
        confidence: retrieved.confidence,
        indexId,
        meta: { requestId: `mind:${t0}`, timingMs, semanticWinRate: retrieved.semanticWinRate, staleCount },
      };
    },

    async ask(req): Promise<AgentResponse> {
      const indexId = resolveIndexId(req.indexId);
      const retrieval = effectiveIndexConfig(config, indexId).retrieval;
      const mode: AgentQueryMode = req.mode ?? 'auto';
      const budget = config.modes[mode];
      const t0 = now();

      // Feedback: record the query (best-effort).
      await recordQuery(services.cache, indexId, req.text, t0);

      // Decompose into sub-queries for richer modes; always retains the original.
      const queries = budget.useLLM
        ? await decompose(req.text, services.llm, budget.maxSubqueries)
        : [req.text];

      // Gather across sub-queries, merging by chunk id (keep best score).
      const merged = new Map<string, RankedChunk>();
      let retrievalConfidence = 0;
      for (const q of queries) {
        const r = await retrieve(
          { text: q, indexId, limit: budget.maxChunks, intent: undefined, rrfK: retrieval.rrfK, hyde: retrieval.hyde, expand: retrieval.expand },
          services,
        );
        retrievalConfidence = Math.max(retrievalConfidence, r.confidence);
        for (const rc of r.ranked) {
          const prev = merged.get(rc.chunk.id);
          if (!prev || rc.score > prev.score) {
            merged.set(rc.chunk.id, rc);
          }
        }
      }

      let ranked = retrieval.rerank
        ? rerank([...merged.values()], req.text)
        : [...merged.values()].sort((a, b) => b.score - a.score);
      if (retrieval.dedup) {
        ranked = dedupRanked(ranked);
      }
      ranked = ranked.slice(0, budget.maxChunks);

      const verification = await verifySources(ranked, services.storage);
      const base = computeConfidence(retrievalConfidence, verification.rate, config.confidence.floor);

      const answer = await synthesizeAnswer(req.text, ranked, services.llm, budget.useLLM);

      // Field-check (anti-hallucination): symbols the answer names must exist in
      // the retrieved sources. Ungrounded terms penalise confidence and warn.
      const { confidence, warnings } = budget.useLLM
        ? applyFieldCheck(answer, ranked, base.confidence, base.warnings, config.confidence.floor)
        : base;

      const manifest = await loadManifest(services.storage, indexId);
      const staleByFile = await staleMap(manifest, ranked.map((r) => r.chunk.path), cwd);

      const timingMs = now() - t0;
      services.logger?.info('mind: ask', {
        indexId,
        mode,
        subqueries: queries.length,
        chunks: ranked.length,
        confidence: Math.round(confidence * 1000) / 1000,
        timingMs,
      });
      return buildAgentResponse({
        answer,
        ranked,
        confidence,
        mode,
        requestId: `mind:${t0}`,
        timingMs,
        indexId,
        floor: config.confidence.floor,
        snippet: req.snippet ?? 'line',
        staleByFile,
        warnings,
      });
    },

    async explore(req): Promise<ExploreResponse> {
      const indexId = resolveIndexId(req.indexId);
      const retrieval = effectiveIndexConfig(config, indexId).retrieval;
      // A map is a wider view than a search; the model decides what to open.
      const budget = config.modes.auto;
      const limit = req.limit ?? retrieval.limit;
      const t0 = now();

      // Over-fetch with an architecture lens, then refine: retrieve -> rerank -> dedup.
      const retrieved = await retrieve(
        { text: req.task, indexId, limit: limit * 3, intent: 'architecture', rrfK: retrieval.rrfK, hyde: retrieval.hyde, expand: retrieval.expand },
        services,
      );
      let ranked = retrieval.rerank ? rerank(retrieved.ranked, req.task) : retrieved.ranked;
      if (retrieval.dedup) {
        ranked = dedupRanked(ranked);
      }
      ranked = ranked.slice(0, limit);

      const manifest = await loadManifest(services.storage, indexId);
      const stales = await staleMap(manifest, ranked.map((r) => r.chunk.path), cwd);
      const files = toExploreEntries(ranked, stales);
      const spread = spreadOf(files.map((f) => f.file));
      const summary = await orientationSummary(req.task, files, services.llm, budget.useLLM);
      const timingMs = now() - t0;

      services.logger?.info('mind: explore', {
        indexId,
        filesTouched: files.length,
        spread,
        timingMs,
      });
      return {
        task: req.task,
        indexId,
        confidence: retrieved.confidence,
        summary,
        files,
        meta: { requestId: `mind:${t0}`, timingMs, filesTouched: files.length, spread },
      };
    },

    async reindex(req): Promise<IndexResponse> {
      return this.index({ indexId: req.indexId, full: true });
    },

    async drop(req): Promise<DropResponse> {
      const indexId = resolveIndexId(req.indexId);
      if (!(await manifestExists(services.storage, indexId))) {
        throw new Error(`No such index "${indexId}" — nothing to drop (run \`kb mind status\` to list indexes).`);
      }
      const manifest = await loadManifest(services.storage, indexId);
      const ids = manifest.chunks.map((c) => c.id);
      const droppedFiles = Object.keys(manifest.files).length;
      // Remove vectors in batches (large indexes have tens of thousands of ids).
      const BATCH = 500;
      for (let i = 0; i < ids.length; i += BATCH) {
        await services.vectorStore.delete(ids.slice(i, i + BATCH), indexId);
      }
      await deleteManifest(services.storage, indexId);
      services.logger?.info('mind: drop', { indexId, droppedChunks: ids.length, droppedFiles });
      return { indexId, droppedChunks: ids.length, droppedFiles };
    },

    async syncAdd(paths, indexId): Promise<SyncResponse> {
      const id = resolveIndexId(indexId);
      const counts = await syncAdd(paths, services, syncOpts(id));
      return { indexId: id, ...counts };
    },

    async syncUpdate(paths, indexId): Promise<SyncResponse> {
      const id = resolveIndexId(indexId);
      const counts = await syncUpdate(paths, services, syncOpts(id));
      return { indexId: id, ...counts };
    },

    async syncDelete(paths, indexId): Promise<SyncResponse> {
      const id = resolveIndexId(indexId);
      const counts = await syncDelete(paths, services, syncOpts(id));
      return { indexId: id, ...counts };
    },

    async syncList(indexId): Promise<SyncListResponse> {
      const id = resolveIndexId(indexId);
      const manifest = await loadManifest(services.storage, id);
      return {
        indexId: id,
        documents: Object.entries(manifest.files).map(([path, info]) => ({
          path,
          chunks: info.chunks,
          indexedAt: info.indexedAt,
        })),
      };
    },

    async syncStatus(indexId): Promise<SyncStatusResponse> {
      const id = resolveIndexId(indexId);
      const manifest = await loadManifest(services.storage, id);
      return {
        indexId: id,
        documents: Object.keys(manifest.files).length,
        chunks: manifest.chunks.length,
        lastIndexedAt: manifest.updatedAt,
        stale: false,
      };
    },

    async status(indexId): Promise<StatusResponse> {
      // Show every CONFIGURED index (even if not yet built) plus any built ones,
      // so an agent can see which corpora/scopes the project offers.
      const ids = indexId
        ? [indexId]
        : [...new Set([...Object.keys(config.indexes), ...(await listIndexIds(services))])];
      const indexes: IndexSummary[] = [];
      for (const id of ids) {
        const manifest = await loadManifest(services.storage, id);
        const declared = config.indexes[id];
        const sc = resolveScope(declared?.scope);
        const coverage =
          sc.include.join(', ') + (sc.exclude.length ? ` · excl ${sc.exclude.join(', ')}` : '');
        indexes.push({
          indexId: id,
          label: declared?.label,
          coverage,
          documents: Object.keys(manifest.files).length,
          chunks: manifest.chunks.length,
          lastIndexedAt: manifest.updatedAt,
          staleCount: await staleCount(manifest, cwd),
        });
      }
      return { indexes, healthy: true };
    },

    async health(): Promise<HealthResponse> {
      return {
        ok: true,
        vectorStore: Boolean(services.vectorStore),
        embeddings: Boolean(services.embeddings),
        llm: Boolean(services.llm),
      };
    },
  };
}

/** Enumerate index ids by scanning persisted manifests under `mind/`. */
async function listIndexIds(services: MindServices): Promise<string[]> {
  const paths = await services.storage.list('mind/');
  const ids = new Set<string>();
  for (const p of paths) {
    const match = /^mind\/([^/]+)\/manifest\.json$/.exec(p);
    if (match) {
      ids.add(match[1]!);
    }
  }
  return [...ids];
}
