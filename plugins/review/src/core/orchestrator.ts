/**
 * @module @kb-labs/review/core/orchestrator
 * Main orchestrator for code review operations.
 *
 * Coordinates heuristic engines, LLM analysis, caching, and deduplication.
 */

import type {
  ReviewRequest,
  ReviewResult,
  ReviewFinding,
  PresetDefinition,
  IncrementalMetadata,
} from '../contracts/index.js';
import { LinterRunner, deduplicateFindings } from '../heuristic/index.js';
import { runLLMLiteAnalysis, type LLMLiteResult } from '../llm/index.js';
import { useLLM, useAnalytics, useLogger } from '@kb-labs/sdk';
import { loadPreset } from './presets/index.js';
import { createDiffProvider } from './diff-provider.js';
import {
  createFindingsCache,
  type CacheLookupResult,
  type IncrementalResult,
} from './findings-cache.js';

/**
 * Internal context for tracking review state within a single review() call.
 *
 * ## Thread-Safety Design
 *
 * This context is passed through function parameters instead of being stored
 * as instance variables on ReviewOrchestrator. This ensures thread-safety:
 *
 * - Each `review()` call creates its own ReviewRunContext
 * - Multiple concurrent `review()` calls don't share state
 * - No race conditions between parallel reviews
 *
 * This pattern allows a single ReviewOrchestrator instance to safely handle
 * multiple concurrent review requests (e.g., in a server environment).
 *
 * @internal
 */
interface ReviewRunContext {
  /** LLM-Lite result (if run) */
  llmLiteResult?: LLMLiteResult;
  /** Incremental analysis result */
  incrementalResult?: IncrementalResult;
  /** Cache lookup result */
  cacheLookup?: CacheLookupResult;
}

/**
 * Review orchestrator.
 *
 * Main entry point for running code reviews.
 * Thread-safe: all state is passed through parameters, not instance variables.
 */
export class ReviewOrchestrator {
  /**
   * Run code review.
   *
   * @param request - Review request
   * @returns Review result with findings
   */
  async review(request: ReviewRequest): Promise<ReviewResult> {
    const startTime = Date.now();

    // Load preset
    const preset = await loadPreset(request.presetId);

    // Track analytics
    const analytics = useAnalytics();
    analytics?.track('review:started', {
      mode: request.mode,
      repoScope: request.repoScope,
      presetId: request.presetId,
    });

    // Create run context (thread-safe: local to this call)
    const runCtx: ReviewRunContext = {};

    try {
      // Run analysis based on mode
      const findings = await this.runAnalysis(request, preset, runCtx);

      // Build result
      const analyzedFiles = await this.countFiles(request, preset);

      // Base metadata
      const metadata: ReviewResult['metadata'] = {
        preset: request.presetId,
        mode: request.mode,
        filesReviewed: analyzedFiles,
        analyzedFiles: analyzedFiles,
        heuristicFindings: findings.filter((f) => f.source === 'heuristic').length,
        llmFindings: findings.filter((f) => f.source !== 'heuristic').length,
        totalFindings: findings.length,
        durationMs: Date.now() - startTime,
        engines: this.getEnginesUsed(findings),
      };

      // Add LLM-Lite specific metadata if available
      if (runCtx.llmLiteResult) {
        const llmMeta = runCtx.llmLiteResult.metadata;
        Object.assign(metadata, {
          llmLite: {
            llmCalls: llmMeta.llmCalls,
            toolCalls: llmMeta.toolCalls,
            tokens: llmMeta.tokens,
            estimatedCost: llmMeta.estimatedCost,
            verification: llmMeta.verification,
            timing: llmMeta.timing,
          },
        });
      }

      // Add incremental review metadata if available
      if (runCtx.incrementalResult || runCtx.cacheLookup) {
        const incr = runCtx.incrementalResult;
        const cache = runCtx.cacheLookup;

        const incrementalMeta: IncrementalMetadata = {
          cachedFiles: cache?.stats.cachedFiles ?? 0,
          analyzedFiles: cache?.stats.uncachedFiles ?? analyzedFiles,
          newFindings: incr?.stats.new ?? findings.length,
          knownFindings: incr?.stats.known ?? 0,
          cachedFindings: incr?.stats.cached ?? 0,
        };

        Object.assign(metadata, { incremental: incrementalMeta });
      }

      const result: ReviewResult = {
        findings,
        summary: {
          total: findings.length,
          bySeverity: {
            error: findings.filter((f) => f.severity === 'blocker' || f.severity === 'high').length,
            warning: findings.filter((f) => f.severity === 'medium').length,
            info: findings.filter((f) => f.severity === 'low' || f.severity === 'info').length,
          },
          byType: this.groupByType(findings),
        },
        metadata,
      };

      // Track success
      analytics?.track('review:completed', {
        mode: request.mode,
        findingsCount: findings.length,
        duration: result.metadata.durationMs,
      });

      return result;
    } catch (error) {
      // Track error
      analytics?.track('review:failed', {
        mode: request.mode,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Run analysis based on review mode.
   */
  private async runAnalysis(
    request: ReviewRequest,
    preset: PresetDefinition,
    runCtx: ReviewRunContext
  ): Promise<ReviewFinding[]> {
    const mode = request.mode ?? 'heuristic';

    switch (mode) {
      case 'heuristic':
        return this.runHeuristicAnalysis(request, preset);

      case 'full':
        return this.runFullAnalysis(request, preset, runCtx);

      case 'llm':
        return this.runLLMAnalysis(request, preset, runCtx);

      default:
        throw new Error(`Unknown review mode: ${mode}`);
    }
  }

  /**
   * Run heuristic-only analysis (CI mode).
   *
   * Fast, deterministic analysis using linters via CLI.
   * No LLM calls.
   */
  private async runHeuristicAnalysis(
    request: ReviewRequest,
    _preset: PresetDefinition
  ): Promise<ReviewFinding[]> {
    // Get file paths
    const files = request.files?.map(f => f.path) ?? [];
    if (files.length === 0) {
      return [];
    }

    // Run all applicable linters via CLI
    const runner = new LinterRunner();
    const results = await runner.runAll(files);

    // Log any errors
    const logger = useLogger();
    for (const result of results) {
      if (result.error) {
        logger?.warn(`[${result.engineId}] ${result.error}`);
      }
    }

    // Collect and deduplicate findings
    const findings = LinterRunner.collectFindings(results);
    return deduplicateFindings(findings);
  }

  /**
   * Run full analysis (heuristic + LLM-Lite).
   *
   * Runs heuristic analysis (ESLint, etc.) and LLM-Lite in parallel.
   * Combines deterministic linting with intelligent code review.
   * Both use caching for incremental analysis.
   */
  private async runFullAnalysis(
    request: ReviewRequest,
    preset: PresetDefinition,
    runCtx: ReviewRunContext
  ): Promise<ReviewFinding[]> {
    // Run heuristic and LLM-Lite in parallel for speed
    const llm = useLLM({ tier: 'medium' });

    const [heuristicFindings, llmFindings] = await Promise.all([
      // Heuristic analysis (ESLint, etc.)
      this.runHeuristicAnalysis(request, preset),
      // LLM-Lite analysis with caching (if LLM available and files provided)
      llm && request.files?.length
        ? this.runLLMAnalysis(request, preset, runCtx)
        : Promise.resolve([]),
    ]);

    // Combine and deduplicate (ESLint and LLM may find same issues)
    return deduplicateFindings([...heuristicFindings, ...llmFindings]);
  }

  /**
   * Run LLM-Lite analysis (v2) with incremental caching.
   *
   * Uses batch tools, diff-based context, and anti-hallucination verification.
   * Caches findings by file content hash to skip unchanged files.
   */
  private async runLLMAnalysis(
    request: ReviewRequest,
    _preset: PresetDefinition,
    runCtx: ReviewRunContext
  ): Promise<ReviewFinding[]> {
    if (!request.files || request.files.length === 0) {
      return [];
    }

    const cwd = request.cwd ?? process.cwd();

    // Initialize findings cache
    const findingsCache = createFindingsCache(cwd);
    await findingsCache.load();

    // Check cache - skip unchanged files
    const cacheLookup = findingsCache.lookup(request.files);
    runCtx.cacheLookup = cacheLookup;

    // Collect cached findings
    const cachedFindings: ReviewFinding[] = [];
    for (const cached of cacheLookup.cached) {
      cachedFindings.push(...cached.findings);
    }

    // If all files are cached, return early
    if (cacheLookup.uncached.length === 0) {
      // All files unchanged - use cache
      runCtx.incrementalResult = {
        newFindings: [],
        knownFindings: [],
        cachedFindings,
        stats: {
          new: 0,
          known: 0,
          cached: cachedFindings.length,
          total: cachedFindings.length,
        },
      };
      return cachedFindings;
    }

    // Create DiffProvider for this analysis
    const diffProvider = createDiffProvider(cwd);

    // Run LLM-Lite analysis only on uncached (changed) files
    const result: LLMLiteResult = await runLLMLiteAnalysis({
      cwd,
      files: cacheLookup.uncached,
      taskContext: request.taskContext,
      repoScope: request.repoScope,
      diffProvider,
    });

    // Store LLM-Lite metadata for later (will be merged into result)
    runCtx.llmLiteResult = result;

    // Compare with known issues (incremental)
    const incrementalResult = findingsCache.compareIncremental(
      result.findings,
      cachedFindings
    );
    runCtx.incrementalResult = incrementalResult;

    // Update cache with new findings
    findingsCache.update(cacheLookup.uncached, result.findings);
    await findingsCache.save();

    // Return all findings (new + known + cached)
    const allFindings = [
      ...incrementalResult.newFindings,
      ...incrementalResult.knownFindings,
      ...incrementalResult.cachedFindings,
    ];

    return deduplicateFindings(allFindings);
  }

  /**
   * Resolve file patterns to absolute paths.
   *
   * Note: Files must be provided in request.files.
   * Pattern resolution should happen at CLI layer using ctx.runtime.fs.glob()
   */
  private async resolvePatterns(request: ReviewRequest, _preset: PresetDefinition): Promise<string[]> {
    // Files must be provided by caller (CLI layer handles glob resolution)
    if (!request.files || request.files.length === 0) {
      throw new Error('No files provided for review. Use ctx.runtime.fs.glob() at CLI layer to resolve patterns.');
    }

    return request.files.map((f) => f.path);
  }

  /**
   * Count files to be analyzed.
   */
  private async countFiles(request: ReviewRequest, preset: PresetDefinition): Promise<number> {
    const files = await this.resolvePatterns(request, preset);
    return files.length;
  }

  /**
   * Get list of engines that produced findings.
   */
  private getEnginesUsed(findings: ReviewFinding[]): string[] {
    const engines = new Set(findings.map((f) => f.engine));
    return [...engines];
  }

  /**
   * Group findings by type.
   */
  private groupByType(findings: ReviewFinding[]): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const finding of findings) {
      const type = finding.type;
      groups[type] = (groups[type] ?? 0) + 1;
    }
    return groups;
  }

  /**
   * Generate cache key for heuristic analysis.
   */
  private generateCacheKey(engine: string, request: ReviewRequest): string {
    // TODO: Include file content hashes for more precise caching
    const filePaths = request.files ? request.files.map((f) => f.path).sort().join(',') : 'default';

    // Normalize repoScope (may come as string from CLI in some edge cases)
    const repoScopeKey = request.repoScope
      ? (Array.isArray(request.repoScope) ? request.repoScope.join(',') : String(request.repoScope))
      : 'default';

    const parts = [
      'review',
      engine,
      repoScopeKey,
      request.presetId ?? 'default',
      filePaths,
    ];

    return parts.join(':');
  }

}

/**
 * Quick helper to run code review.
 */
export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
  const orchestrator = new ReviewOrchestrator();
  return orchestrator.review(request);
}
