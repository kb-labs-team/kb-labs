/**
 * ToolResultCache — caches tool results within a single agent execution
 * and detects iteration loops.
 *
 * Responsibilities:
 * - Prevent duplicate tool calls from re-executing (TTL-based cache)
 * - Detect when the agent is stuck repeating the same tool calls
 *
 * Intentionally has no dependencies on Agent or LLM — pure data structure.
 */

import type { ToolResult } from '../../contracts/index.js';

const TOOL_CACHE_TTL_MS = 60_000;
const LOOP_DETECTION_WINDOW_SIZE = 6;
const LOOP_DETECTION_MIN_REPEATS = 3;

export class ToolResultCache {
  private readonly cache = new Map<string, { result: ToolResult; timestamp: number }>();
  private readonly recentIterationSignatures: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════
  // Cache operations
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build a cache key from tool name and input args.
   * Keys are input-order-independent (sorted before hashing).
   */
  buildKey(toolName: string, input: Record<string, unknown>): string {
    const sortedInput = Object.keys(input)
      .sort()
      .reduce((acc, key) => {
        acc[key] = input[key];
        return acc;
      }, {} as Record<string, unknown>);

    return JSON.stringify({ name: toolName, input: sortedInput });
  }

  /**
   * Return cached result if still within TTL, otherwise null.
   */
  get(cacheKey: string): ToolResult | null {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return null;
    }

    const age = Date.now() - cached.timestamp;
    if (age > TOOL_CACHE_TTL_MS) {
      this.cache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  /**
   * Store a tool result in the cache.
   */
  set(cacheKey: string, result: ToolResult): void {
    this.cache.set(cacheKey, { result, timestamp: Date.now() });
  }

  /**
   * Estimate time saved by a cache hit (for logging).
   */
  estimateSavedTimeMs(toolName: string): number {
    const estimates: Record<string, number> = {
      fs_read: 50,
      grep_search: 200,
      glob_search: 150,
      shell_exec: 500,
    };
    return estimates[toolName] ?? 100;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Loop detection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Reset all state — call at the start of each new agent execution.
   */
  clear(): void {
    this.cache.clear();
    this.recentIterationSignatures.length = 0;
  }

  /**
   * Record an iteration's tool calls and detect if the agent is looping.
   * Returns true if the last N iterations have identical tool call signatures.
   */
  detectLoop(toolCalls: Array<{ name: string; arguments: string }>): boolean {
    const sig = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).sort().join('|');
    this.recentIterationSignatures.push(sig);

    if (this.recentIterationSignatures.length > LOOP_DETECTION_WINDOW_SIZE) {
      this.recentIterationSignatures.shift();
    }

    if (this.recentIterationSignatures.length >= LOOP_DETECTION_MIN_REPEATS) {
      const tail = this.recentIterationSignatures.slice(-LOOP_DETECTION_MIN_REPEATS);
      return tail.every(s => s === tail[0]);
    }

    return false;
  }
}
