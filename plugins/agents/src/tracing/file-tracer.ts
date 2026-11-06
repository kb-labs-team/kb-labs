/**
 * File-based tracer that saves execution traces to JSON files
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tracer, TraceEntry, DetailedTraceEntry } from '../contracts/index.js';
type AnyEntry = Omit<DetailedTraceEntry, 'seq' | 'timestamp'>;

/**
 * File tracer implementation
 */
export class FileTracer implements Tracer {
  private entries: AnyEntry[] = [];
  private taskId: string;
  private sessionId?: string;

  constructor(taskId: string, sessionId?: string) {
    this.taskId = taskId;
    this.sessionId = sessionId;
  }

  /**
   * Record a trace entry
   */
  trace(entry: AnyEntry): void {
    this.entries.push(entry);
  }

  /**
   * Get all trace entries
   */
  getEntries(): TraceEntry[] {
    return this.entries as unknown as TraceEntry[];
  }

  /**
   * Save trace to file
   */
  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    const traceData = {
      taskId: this.taskId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      totalEntries: this.entries.length,
      entries: this.entries,
    };

    await fs.writeFile(filePath, JSON.stringify(traceData, null, 2), 'utf-8');
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get trace summary statistics
   */
  getSummary(): {
    totalEntries: number;
    llmCalls: number;
    toolCalls: number;
    totalDuration: number;
    avgLLMDuration: number;
    avgToolDuration: number;
  } {
    const llmCalls = this.entries.filter(e => e.type === 'llm:call');
    const toolCalls = this.entries.filter(e => e.type === 'tool:execution');

    const getDuration = (e: AnyEntry): number => {
      if (e.type === 'llm:call' || e.type === 'tool:execution') {
        return (e as { timing?: { durationMs?: number } }).timing?.durationMs ?? 0;
      }
      return 0;
    };

    const totalDuration = this.entries.reduce((sum, e) => sum + getDuration(e), 0);
    const llmDuration = llmCalls.reduce((sum, e) => sum + getDuration(e), 0);
    const toolDuration = toolCalls.reduce((sum, e) => sum + getDuration(e), 0);

    return {
      totalEntries: this.entries.length,
      llmCalls: llmCalls.length,
      toolCalls: toolCalls.length,
      totalDuration,
      avgLLMDuration: llmCalls.length > 0 ? llmDuration / llmCalls.length : 0,
      avgToolDuration: toolCalls.length > 0 ? toolDuration / toolCalls.length : 0,
    };
  }
}
