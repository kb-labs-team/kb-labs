import { describe, it, expect } from 'vitest';
import {
  createFactAddedEvent,
  createArchiveStoreEvent,
  createSummarizationResultEvent,
} from '../../src/tracing/trace-helpers';

describe('Memory trace event factories', () => {
  describe('createFactAddedEvent()', () => {
    it('should create event with correct type and all fields', () => {
      const event = createFactAddedEvent({
        iteration: 5,
        fact: {
          id: 'fact_1',
          category: 'finding',
          fact: 'Found 3 TODO items in src/index.ts',
          confidence: 0.8,
          source: 'grep_search',
          merged: false,
        },
        factSheetStats: {
          totalFacts: 10,
          estimatedTokens: 500,
          byCategory: { finding: 5, file_content: 3, tool_result: 2 },
        },
      });

      expect(event.type).toBe('memory:fact_added');
      expect(event.iteration).toBe(5);
      expect(event.fact.id).toBe('fact_1');
      expect(event.fact.category).toBe('finding');
      expect(event.fact.merged).toBe(false);
      expect(event.factSheetStats.totalFacts).toBe(10);
      expect(event.factSheetStats.estimatedTokens).toBe(500);
    });

    it('should include superseded field when provided', () => {
      const event = createFactAddedEvent({
        iteration: 3,
        fact: {
          id: 'fact_2',
          category: 'correction',
          fact: 'Updated understanding',
          confidence: 0.9,
          source: 'llm_extraction',
          merged: false,
          superseded: 'fact_1',
        },
        factSheetStats: { totalFacts: 5, estimatedTokens: 200, byCategory: {} },
      });

      expect(event.fact.superseded).toBe('fact_1');
    });
  });

  describe('createArchiveStoreEvent()', () => {
    it('should create event with correct type and all fields', () => {
      const event = createArchiveStoreEvent({
        iteration: 3,
        entry: {
          id: 'archive_1',
          toolName: 'fs_read',
          filePath: '/src/index.ts',
          outputLength: 5000,
          estimatedTokens: 1250,
          keyFactsExtracted: 1,
        },
        archiveStats: {
          totalEntries: 15,
          totalChars: 50000,
          uniqueFiles: 8,
          evicted: 0,
        },
      });

      expect(event.type).toBe('memory:archive_store');
      expect(event.iteration).toBe(3);
      expect(event.entry.toolName).toBe('fs_read');
      expect(event.entry.filePath).toBe('/src/index.ts');
      expect(event.archiveStats.totalEntries).toBe(15);
      expect(event.archiveStats.evicted).toBe(0);
    });
  });

  describe('createSummarizationResultEvent()', () => {
    it('should create event with full input/output/delta/efficiency', () => {
      const event = createSummarizationResultEvent({
        iteration: 10,
        input: {
          iterationRange: [5, 10],
          messagesCount: 12,
          inputChars: 3000,
          inputTokens: 750,
        },
        output: {
          factsExtracted: 6,
          factsByCategory: { finding: 3, file_content: 2, architecture: 1 },
          outputTokens: 200,
          llmDurationMs: 1500,
        },
        delta: {
          factSheetBefore: 15,
          factSheetAfter: 19,
          tokensBefore: 800,
          tokensAfter: 1100,
          newFacts: 4,
          mergedFacts: 2,
          evictedFacts: 0,
        },
        efficiency: {
          compressionRatio: 3.75,
          factDensity: 0.5,
          newFactRate: 0.67,
        },
      });

      expect(event.type).toBe('memory:summarization_result');
      expect(event.iteration).toBe(10);
      expect(event.input.iterationRange).toEqual([5, 10]);
      expect(event.output.factsExtracted).toBe(6);
      expect(event.delta.newFacts).toBe(4);
      expect(event.delta.factSheetAfter - event.delta.factSheetBefore).toBe(4);
      expect(event.efficiency.compressionRatio).toBe(3.75);
      expect(event.efficiency.newFactRate).toBe(0.67);
    });
  });
});
