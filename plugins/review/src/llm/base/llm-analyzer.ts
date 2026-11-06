/**
 * @module @kb-labs/review/llm/base/llm-analyzer
 * Base class for LLM analyzers
 */

import type { LLMAnalyzer, ReviewFinding, ParsedFile, ReviewContext } from '../../contracts/index.js';

/**
 * Base LLM analyzer
 * Provides common functionality for all LLM-based analyzers
 */
export abstract class BaseLLMAnalyzer implements LLMAnalyzer {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]>;

  /**
   * Generate cache key for file + preset combination
   */
  protected generateCacheKey(file: ParsedFile, preset: string): string {
    return `review:${this.id}:${file.contentHash}:${preset}`;
  }

  /**
   * Build finding ID
   */
  protected buildFindingId(file: ParsedFile, line: number, type: string): string {
    return `${this.id}-${file.path}-${line}-${type}`;
  }
}
