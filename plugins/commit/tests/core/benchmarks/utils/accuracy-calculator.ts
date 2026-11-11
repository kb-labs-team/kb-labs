/**
 * Calculate accuracy metrics for benchmark results
 */

import type { ConventionalType } from '@kb-labs/commit/contracts';
import type { BenchmarkResults, TestCaseResult, DifficultyLevel } from '../types';
import type { TestCategory } from '../types';

/**
 * Calculate precision, recall, F1-score for a commit type
 */
export function calculateTypeMetrics(
  results: TestCaseResult[],
  targetType: ConventionalType
): {
  total: number;
  correct: number;
  precision: number;
  recall: number;
  f1Score: number;
} {
  // True Positives: Predicted type AND expected type both match targetType
  const truePositives = results.filter((r) => {
    const actualType = r.actual.commits[0]?.type;
    return actualType === targetType && r.comparison.typeMatch;
  }).length;

  // False Positives: Predicted type is targetType but expected type is different
  const falsePositives = results.filter((r) => {
    const actualType = r.actual.commits[0]?.type;
    return actualType === targetType && !r.comparison.typeMatch;
  }).length;

  // False Negatives: Expected type is targetType but predicted type is different
  const falseNegatives = results.filter((r) => {
    const _expectedType = r.comparison.mismatches?.expectedType;
    return _expectedType === targetType && !r.comparison.typeMatch;
  }).length;

  const total = truePositives + falseNegatives;
  const correct = truePositives;

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;

  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;

  const f1Score = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  return {
    total,
    correct,
    precision,
    recall,
    f1Score,
  };
}

/**
 * Calculate overall accuracy
 */
export function calculateOverallAccuracy(results: TestCaseResult[]): number {
  const passed = results.filter((r) => r.passed).length;
  return results.length > 0 ? passed / results.length : 0;
}

/**
 * Calculate metrics by category
 */
export function calculateCategoryMetrics(
  results: TestCaseResult[],
  testCases: Array<{ id: string; category: TestCategory }>
): Record<TestCategory, { total: number; passed: number; accuracy: number }> {
  const categories = new Set(testCases.map((c) => c.category));
  const metrics: Record<string, { total: number; passed: number; accuracy: number }> = {};

  for (const category of categories) {
    const categoryResults = results.filter((r) => {
      const testCase = testCases.find((c) => c.id === r.testCaseId);
      return testCase?.category === category;
    });

    const passed = categoryResults.filter((r) => r.passed).length;
    const total = categoryResults.length;

    metrics[category] = {
      total,
      passed,
      accuracy: total > 0 ? passed / total : 0,
    };
  }

  return metrics as Record<TestCategory, { total: number; passed: number; accuracy: number }>;
}

/**
 * Calculate metrics by difficulty
 */
export function calculateDifficultyMetrics(
  results: TestCaseResult[],
  testCases: Array<{ id: string; difficulty: DifficultyLevel }>
): Record<DifficultyLevel, { total: number; passed: number; accuracy: number }> {
  const difficulties = new Set(testCases.map((c) => c.difficulty));
  const metrics: Record<string, { total: number; passed: number; accuracy: number }> = {};

  for (const difficulty of difficulties) {
    const difficultyResults = results.filter((r) => {
      const testCase = testCases.find((c) => c.id === r.testCaseId);
      return testCase?.difficulty === difficulty;
    });

    const passed = difficultyResults.filter((r) => r.passed).length;
    const total = difficultyResults.length;

    metrics[difficulty] = {
      total,
      passed,
      accuracy: total > 0 ? passed / total : 0,
    };
  }

  return metrics as Record<DifficultyLevel, { total: number; passed: number; accuracy: number }>;
}

/**
 * Calculate performance metrics
 */
export function calculatePerformanceMetrics(results: TestCaseResult[]): {
  avgTokensUsed: number;
  phase2EscalationRate: number;
  avgDurationMs: number;
} {
  const totalTokens = results.reduce((sum, r) => sum + (r.actual.tokensUsed ?? 0), 0);
  const escalated = results.filter((r) => r.actual.escalated).length;

  return {
    avgTokensUsed: results.length > 0 ? totalTokens / results.length : 0,
    phase2EscalationRate: results.length > 0 ? escalated / results.length : 0,
    avgDurationMs: 0, // TODO: Add timing to test runner
  };
}

/**
 * Build complete benchmark results
 */
export function buildBenchmarkResults(
  testCaseResults: TestCaseResult[],
  testCases: Array<{ id: string; category: TestCategory; difficulty: DifficultyLevel }>,
  version: string
): BenchmarkResults {
  const commitTypes: ConventionalType[] = [
    'feat',
    'fix',
    'refactor',
    'chore',
    'docs',
    'test',
    'build',
    'ci',
    'perf',
  ];

  const byType: Record<string, any> = {};
  for (const type of commitTypes) {
    byType[type] = calculateTypeMetrics(testCaseResults, type);
  }

  return {
    runAt: new Date().toISOString(),
    version,
    totalCases: testCaseResults.length,
    passedCases: testCaseResults.filter((r) => r.passed).length,
    failedCases: testCaseResults.filter((r) => !r.passed).length,
    metrics: {
      accuracy: calculateOverallAccuracy(testCaseResults),
      byType,
      byCategory: calculateCategoryMetrics(testCaseResults, testCases),
      byDifficulty: calculateDifficultyMetrics(testCaseResults, testCases),
    },
    performance: calculatePerformanceMetrics(testCaseResults),
    cases: testCaseResults,
  };
}
