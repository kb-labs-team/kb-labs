/**
 * Benchmark test case types
 */

import type { ConventionalType } from '@kb-labs/commit/contracts';
import type { PatternType } from '../../../src/core/generator/pattern-detector.js';

/**
 * Difficulty level for test cases
 */
export type DifficultyLevel = 'easy' | 'medium' | 'hard';

/**
 * Test case category (matches pattern types)
 */
export type TestCategory = PatternType | 'mixed-complex';

/**
 * Expected commit output for ground truth
 */
export interface ExpectedCommit {
  type: ConventionalType;
  scope?: string;
  message: string; // Key words to match, not exact string
  files: string[]; // File paths that should be in this commit
  releaseHint: 'none' | 'patch' | 'minor' | 'major';
  breaking?: boolean;
}

/**
 * Baseline result from previous run (for comparison)
 */
export interface BaselineResult {
  type: ConventionalType;
  correct: boolean;
  confidence: number;
  phase: 1 | 2; // Which LLM phase was used
}

/**
 * Single benchmark test case
 */
export interface BenchmarkTestCase {
  // Metadata
  id: string; // Unique identifier (e.g., "2025-12-15T22-05-15-767Z" or "new-package-001")
  description: string; // Human-readable summary
  category: TestCategory; // Pattern category
  difficulty: DifficultyLevel; // Complexity level

  // Input data (from git status)
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions: number;
    deletions: number;
    isNewFile: boolean; // Critical: true = new file, false = moved/renamed
    binary?: boolean;
  }>;

  // Expected output (ground truth - manually labeled)
  expected: {
    commits: ExpectedCommit[];
  };

  // Optional: Historical baseline (from before improvements)
  baseline?: BaselineResult;

  // Optional: Tags for filtering
  tags?: string[];
}

/**
 * Collection of test cases
 */
export interface BenchmarkSuite {
  version: string; // Suite version (e.g., "1.0.0")
  createdAt: string; // ISO timestamp
  description: string;
  cases: BenchmarkTestCase[];
}

/**
 * Result of running a single test case
 */
export interface TestCaseResult {
  testCaseId: string;
  passed: boolean;

  // Actual output from generator
  actual: {
    commits: Array<{
      type: ConventionalType;
      scope?: string;
      message: string;
      files: string[];
      releaseHint: 'none' | 'patch' | 'minor' | 'major';
      breaking: boolean;
      confidence?: number;
    }>;
    llmUsed: boolean;
    escalated: boolean; // Phase 2 used?
    tokensUsed?: number;
  };

  // Comparison with expected
  comparison: {
    typeMatch: boolean; // Commit type matches expected
    scopeMatch: boolean; // Scope matches (if specified)
    messageMatch: boolean; // Message contains key words
    filesMatch: boolean; // All expected files included
    releaseHintMatch: boolean;

    // Detailed mismatch info
    mismatches?: {
      expectedType?: ConventionalType;
      actualType?: ConventionalType;
      missingFiles?: string[];
      extraFiles?: string[];
    };
  };
}

/**
 * Aggregate benchmark results
 */
export interface BenchmarkResults {
  // Metadata
  runAt: string; // ISO timestamp
  version: string; // Code version (git commit hash)
  totalCases: number;
  passedCases: number;
  failedCases: number;

  // Overall metrics
  metrics: {
    accuracy: number; // 0.0 - 1.0 (passed / total)

    // Per-type metrics
    byType: Record<ConventionalType, {
      total: number;
      correct: number;
      precision: number; // TP / (TP + FP)
      recall: number; // TP / (TP + FN)
      f1Score: number; // 2 * (precision * recall) / (precision + recall)
    }>;

    // Per-category metrics
    byCategory: Record<TestCategory, {
      total: number;
      passed: number;
      accuracy: number;
    }>;

    // Per-difficulty metrics
    byDifficulty: Record<DifficultyLevel, {
      total: number;
      passed: number;
      accuracy: number;
    }>;
  };

  // Performance metrics
  performance: {
    avgTokensUsed: number;
    phase2EscalationRate: number; // % of cases that escalated
    avgDurationMs: number;
  };

  // Detailed results
  cases: TestCaseResult[];
}

/**
 * Comparison between two benchmark runs (baseline vs improved)
 */
export interface BenchmarkComparison {
  baseline: BenchmarkResults;
  improved: BenchmarkResults;

  delta: {
    accuracyChange: number; // Percentage point change
    phase2RateChange: number;
    tokenCostChange: number;

    // Per-type improvements
    typeImprovements: Record<ConventionalType, {
      accuracyDelta: number;
      f1ScoreDelta: number;
    }>;

    // Cases that improved/regressed
    improved: string[]; // Test case IDs
    regressed: string[]; // Test case IDs
  };
}
