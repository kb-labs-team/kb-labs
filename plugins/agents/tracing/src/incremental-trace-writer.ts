/**
 * Incremental Trace Writer - NDJSON append-only tracer with crash safety
 *
 * Design principle: reliability > speed.
 * Every event is written synchronously to disk immediately.
 * Even if the agent crashes mid-execution, all events up to the crash are on disk.
 *
 * Features:
 * - NDJSON format (newline-delimited JSON) for append-only writes
 * - Synchronous writes — zero event loss, even on crash
 * - Privacy redaction on trace() call
 * - Auto-cleanup (keep last 30 traces)
 * - Index generation for fast CLI queries
 */

import { promises as fs, mkdirSync, statSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';
import type { Tracer, TraceEntry } from '@kb-labs/agent-contracts';
import type { DetailedTraceEntry } from '@kb-labs/agent-contracts';
import { redactTraceEvent } from './privacy-redactor.js';
import { resolveTraceDir } from './trace-loader.js';

/**
 * Trace configuration interface
 */
export interface TraceConfig {
  version: string;
  enabled: boolean;
  level: 'minimal' | 'standard' | 'detailed' | 'debug';

  incremental: {
    enabled: boolean;
    flushIntervalMs: number; // Default: 100ms
    maxBufferSize: number; // Default: 10 events
    format: 'ndjson';
  };

  capture: {
    prompts: boolean;
    toolOutputs: boolean;
    memorySnapshots: boolean;
    decisions: boolean;
  };

  retention: {
    maxTraces: number; // Default: 30
    maxDays: number; // Default: 30
    cleanupOnFinalize: boolean; // Default: true
    archiveOlderThan: number; // Days, default: 7
    compressArchived: boolean; // Default: true
  };

  privacy: {
    redactSecrets: boolean; // Default: true
    redactPaths: boolean; // Default: true
    secretPatterns: string[]; // Regex patterns
    pathReplacements: Record<string, string>;
  };
}

/**
 * Trace index for fast CLI queries
 */
export interface TraceIndex {
  version: string;
  taskId: string;
  createdAt: string;
  finalizedAt: string;

  summary: {
    totalEvents: number;
    iterations: number;
    status: 'success' | 'failed' | 'incomplete';
    eventCounts: Record<string, number>;
  };

  timing: {
    startedAt: string;
    completedAt: string;
    totalDurationMs: number;
  };

  cost: {
    totalCost: number;
    currency: 'USD';
  };

  errors: number;

  /** Two-tier memory statistics (aggregated from memory:* events) */
  memory?: {
    totalFactsAdded: number;
    totalArchiveStores: number;
    summarizationRuns: number;
    avgCompressionRatio: number;
    avgNewFactRate: number;
    finalFactSheetSize: number;
    finalFactSheetTokens: number;
    finalArchiveEntries: number;
    finalArchiveUniqueFiles: number;
  };

  iterations: Array<{
    iteration: number;
    eventCount: number;
    llmCalls: number;
    toolCalls: number;
  }>;
}

/**
 * Default trace configuration
 */
export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  version: '1.0.0',
  enabled: true,
  level: 'detailed',

  incremental: {
    enabled: true,
    flushIntervalMs: 100,
    maxBufferSize: 10,
    format: 'ndjson',
  },

  capture: {
    prompts: true,
    toolOutputs: true,
    memorySnapshots: true,
    decisions: true,
  },

  retention: {
    maxTraces: 30,
    maxDays: 30,
    cleanupOnFinalize: true,
    archiveOlderThan: 7,
    compressArchived: true,
  },

  privacy: {
    redactSecrets: true,
    redactPaths: true,
    secretPatterns: [
      'sk-[a-zA-Z0-9]{20,}', // OpenAI API keys
      'Bearer\\s+[a-zA-Z0-9_-]+', // Bearer tokens
      'password[\'"]?\\s*[:=]\\s*[\'"][^\'"]+([\'"]})', // Passwords
      'api[_-]?key[\'"]?\\s*[:=]\\s*[\'"][^\'"]+[\'"]', // Generic API keys
    ],
    pathReplacements: {
      '/Users/': '~/',
      '/home/': '~/',
      '\\Users\\': '~\\',
    },
  },
};

/**
 * Incremental Trace Writer - crash-safe NDJSON tracer
 */
export class IncrementalTraceWriter implements Tracer {
  private seq: number = 0;
  private filepath: string;
  private indexPath: string;
  private config: TraceConfig;
  private taskId: string;
  private startTime: string;

  constructor(
    taskId: string,
    config: Partial<TraceConfig> = {},
    outputDir?: string
  ) {
    this.taskId = taskId;
    this.config = { ...DEFAULT_TRACE_CONFIG, ...config };
    this.startTime = new Date().toISOString();

    const dir = outputDir || resolveTraceDir(process.cwd());
    this.filepath = path.join(dir, `${taskId}.ndjson`);
    this.indexPath = path.join(dir, `${taskId}-index.json`);

    // Create output directory if not exists
    this.ensureDirectoryExists(dir);
  }

  /**
   * Record a trace entry — writes synchronously to disk.
   *
   * Every call = one appendFileSync. No buffering, no async, no lost events.
   * If the agent crashes on iteration 5, you have all events from iterations 1-5.
   */
  trace(entry: DetailedTraceEntry): void {
    try {
      const seq = ++this.seq;
      const timestamp = entry.timestamp || new Date().toISOString();

      const fullEntry: DetailedTraceEntry = {
        ...entry,
        seq,
        timestamp,
      };

      const redacted = this.redact(fullEntry);

      // Sync write — event is on disk before trace() returns
      appendFileSync(this.filepath, JSON.stringify(redacted) + '\n', 'utf-8');
    } catch (error) {
      console.error('[IncrementalTraceWriter] trace() error:', error);
      // Don't crash agent - tracing failure should not stop execution
    }
  }

  /**
   * Get all trace entries (reads from NDJSON file to avoid memory leak)
   * Returns TraceEntry[] for backward compatibility, but actual format is DetailedTraceEntry[]
   */
  getEntries(): TraceEntry[] {
    try {
      const content = readFileSync(this.filepath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      return lines.map((line: string) => JSON.parse(line) as TraceEntry);
    } catch {
      // File doesn't exist yet or is empty
      return [];
    }
  }

  /**
   * Save trace to file (backward compat — no-op, already written synchronously)
   */
  async save(_filePath: string): Promise<void> {
    // No-op — all events are already on disk
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.seq = 0;
  }

  /**
   * Finalize trace (generate index, cleanup old traces)
   */
  async finalize(): Promise<void> {
    try {
      // Generate index
      await this.createIndex();

      // Cleanup old traces
      if (this.config.retention.cleanupOnFinalize) {
        await this.cleanupOldTraces();
      }
    } catch (error) {
      console.error('[IncrementalTraceWriter] finalize() error:', error);
    }
  }

  /**
   * Create index file for fast CLI queries
   */
  async createIndex(): Promise<void> {
    try {
      const entries = this.getEntries();

      if (entries.length === 0) {
        console.warn('[IncrementalTraceWriter] No entries to index');
        return;
      }

      // Calculate summary statistics
      const stats = this.calculateIndexStatistics(entries as unknown as Record<string, unknown>[]);

      // Build index
      const index: TraceIndex = {
        version: '1.0.0',
        taskId: this.taskId,
        createdAt: this.startTime,
        finalizedAt: new Date().toISOString(),

        summary: {
          totalEvents: entries.length,
          iterations: stats.iterations.size,
          status: stats.errors > 0 ? 'failed' : 'success',
          eventCounts: stats.eventCounts,
        },

        timing: {
          startedAt: this.startTime,
          completedAt: new Date().toISOString(),
          totalDurationMs: Date.now() - new Date(this.startTime).getTime(),
        },

        cost: {
          totalCost: stats.totalCost,
          currency: 'USD',
        },

        errors: stats.errors,

        memory: stats.memory,

        iterations: Array.from(stats.iterations.entries())
          .map(([iteration, iterStats]) => ({ iteration, ...iterStats }))
          .sort((a, b) => a.iteration - b.iteration),
      };

      // Ensure index directory exists
      const indexDir = path.dirname(this.indexPath);
      this.ensureDirectoryExists(indexDir);

      // Write index file
      await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    } catch (error) {
      console.error('[IncrementalTraceWriter] createIndex() error:', error);
      // Continue - CLI commands will work but slower (read full NDJSON)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cleanup old traces (keep last N traces)
   */
  private async cleanupOldTraces(): Promise<void> {
    try {
      const dir = path.dirname(this.filepath);
      const files = await fs.readdir(dir);

      // Filter .ndjson files
      const traceFiles = files.filter((f) => f.endsWith('.ndjson'));

      // If <= maxTraces, nothing to clean
      if (traceFiles.length <= this.config.retention.maxTraces) {
        return;
      }

      // Get file stats and sort by mtime (newest first)
      const filesWithStats = await Promise.all(
        traceFiles.map(async (file) => {
          const filepath = path.join(dir, file);
          const stats = await fs.stat(filepath);
          return { file, mtime: stats.mtime.getTime(), filepath };
        })
      );

      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // Delete oldest traces
      const toDelete = filesWithStats.slice(this.config.retention.maxTraces);

      // Delete files in parallel for better performance
      await Promise.allSettled(
        toDelete.map(async ({ file, filepath }) => {
          try {
            // Delete NDJSON file
            await fs.unlink(filepath);

            // Delete index file
            const indexFile = filepath.replace('.ndjson', '-index.json');
            try {
              await fs.unlink(indexFile);
            } catch {
              // Index might not exist, ignore
            }
          } catch (error) {
            console.error(`[IncrementalTraceWriter] Failed to delete ${file}:`, error);
          }
        })
      );

      if (toDelete.length > 0) {
        console.log(
          `[IncrementalTraceWriter] Cleaned up ${toDelete.length} old traces (kept last ${this.config.retention.maxTraces})`
        );
      }
    } catch (error) {
      console.error('[IncrementalTraceWriter] cleanupOldTraces() error:', error);
      // Continue - disk space grows but agent works
    }
  }

  /**
   * Redact sensitive data from entry using optimized privacy-redactor
   *
   * Uses shallow clone optimization - only clones objects that need redaction,
   * not the entire trace event tree. Returns original if no secrets found.
   */
  private redact(entry: DetailedTraceEntry): DetailedTraceEntry {
    if (!this.config.privacy.redactSecrets && !this.config.privacy.redactPaths) {
      return entry;
    }

    try {
      return redactTraceEvent(entry, this.config.privacy);
    } catch (error) {
      console.warn('[IncrementalTraceWriter] redact() error:', error);
      return entry; // Return un-redacted (privacy risk, but better than crash)
    }
  }

  /**
   * Calculate index statistics from trace entries
   */
  private calculateIndexStatistics(entries: Record<string, unknown>[]): {
    eventCounts: Record<string, number>;
    iterations: Map<number, { eventCount: number; llmCalls: number; toolCalls: number }>;
    totalCost: number;
    errors: number;
    memory?: {
      totalFactsAdded: number;
      totalArchiveStores: number;
      summarizationRuns: number;
      avgCompressionRatio: number;
      avgNewFactRate: number;
      finalFactSheetSize: number;
      finalFactSheetTokens: number;
      finalArchiveEntries: number;
      finalArchiveUniqueFiles: number;
    };
  } {
    const eventCounts: Record<string, number> = {};
    const iterations = new Map<number, { eventCount: number; llmCalls: number; toolCalls: number }>();
    let totalCost = 0;
    let errors = 0;

    // Memory stats accumulators
    let totalFactsAdded = 0;
    let totalArchiveStores = 0;
    let summarizationRuns = 0;
    let compressionRatioSum = 0;
    let newFactRateSum = 0;
    let lastFactSheetSize = 0;
    let lastFactSheetTokens = 0;
    let lastArchiveEntries = 0;
    let lastArchiveUniqueFiles = 0;

    for (const entry of entries) {
      // Count by type
      const entryType = typeof entry['type'] === 'string' ? entry['type'] : undefined;
      if (entryType !== undefined) {
        eventCounts[entryType] = (eventCounts[entryType] || 0) + 1;
      }

      // Count by iteration
      const entryIteration = typeof entry['iteration'] === 'number' ? entry['iteration'] : undefined;
      if (entryIteration !== undefined) {
        if (!iterations.has(entryIteration)) {
          iterations.set(entryIteration, { eventCount: 0, llmCalls: 0, toolCalls: 0 });
        }
        const iter = iterations.get(entryIteration)!;
        iter.eventCount++;

        if (entryType === 'llm:end') {
          iter.llmCalls++;
          const cost = entry['cost'];
          if (cost !== null && typeof cost === 'object') {
            totalCost += Number((cost as Record<string, unknown>)['totalCost']) || 0;
          }
        }

        if (entryType === 'tool:end') {
          iter.toolCalls++;
        }
      }

      // Count errors
      if (entryType === 'error:captured') {
        errors++;
      }

      // Aggregate memory events
      if (entryType === 'memory:fact_added') {
        totalFactsAdded++;
        const factSheetStats = entry['factSheetStats'];
        if (factSheetStats !== null && typeof factSheetStats === 'object') {
          const stats = factSheetStats as Record<string, unknown>;
          lastFactSheetSize = Number(stats['totalFacts']) || 0;
          lastFactSheetTokens = Number(stats['estimatedTokens']) || 0;
        }
      }

      if (entryType === 'memory:archive_store') {
        totalArchiveStores++;
        const archiveStats = entry['archiveStats'];
        if (archiveStats !== null && typeof archiveStats === 'object') {
          const stats = archiveStats as Record<string, unknown>;
          lastArchiveEntries = Number(stats['totalEntries']) || 0;
          lastArchiveUniqueFiles = Number(stats['uniqueFiles']) || 0;
        }
      }

      if (entryType === 'memory:summarization_result') {
        summarizationRuns++;
        const efficiency = entry['efficiency'];
        if (efficiency !== null && typeof efficiency === 'object') {
          const eff = efficiency as Record<string, unknown>;
          compressionRatioSum += Number(eff['compressionRatio']) || 0;
          newFactRateSum += Number(eff['newFactRate']) || 0;
        }
      }
    }

    const hasMemoryEvents = totalFactsAdded > 0 || totalArchiveStores > 0 || summarizationRuns > 0;

    return {
      eventCounts,
      iterations,
      totalCost,
      errors,
      memory: hasMemoryEvents
        ? {
            totalFactsAdded,
            totalArchiveStores,
            summarizationRuns,
            avgCompressionRatio: summarizationRuns > 0 ? compressionRatioSum / summarizationRuns : 0,
            avgNewFactRate: summarizationRuns > 0 ? newFactRateSum / summarizationRuns : 0,
            finalFactSheetSize: lastFactSheetSize,
            finalFactSheetTokens: lastFactSheetTokens,
            finalArchiveEntries: lastArchiveEntries,
            finalArchiveUniqueFiles: lastArchiveUniqueFiles,
          }
        : undefined,
    };
  }

  /**
   * Ensure directory exists
   */
  private ensureDirectoryExists(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      // Check if directory already exists
      try {
        const stats = statSync(dir);
        if (!stats.isDirectory()) {
          throw new Error(`Path exists but is not a directory: ${dir}`);
        }
        // Directory exists - all good
      } catch {
        // Directory doesn't exist and couldn't be created
        throw new Error(`Failed to create trace directory: ${dir}. Error: ${error}`);
      }
    }
  }
}
