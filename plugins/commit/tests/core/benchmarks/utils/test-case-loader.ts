/**
 * Load benchmark test cases from JSON files
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkSuite, BenchmarkTestCase } from '../types';

/**
 * Load all test cases from a suite file
 */
export function loadTestSuite(filepath: string): BenchmarkSuite {
  const content = readFileSync(filepath, 'utf-8');
  return JSON.parse(content) as BenchmarkSuite;
}

/**
 * Load all test suites from test-cases directory
 */
export function loadAllTestSuites(testCasesDir: string): BenchmarkTestCase[] {
  const suiteFiles = [
    'pattern-new-package.json',
    'pattern-refactor-modify.json',
    'pattern-deletions.json',
    'pattern-bulk-move.json',
  ];

  const allCases: BenchmarkTestCase[] = [];

  for (const file of suiteFiles) {
    try {
      const filepath = join(testCasesDir, file);
      const suite = loadTestSuite(filepath);
      allCases.push(...suite.cases);
    } catch (error) {
      console.warn(`Failed to load test suite ${file}:`, error);
    }
  }

  return allCases;
}

/**
 * Filter test cases by category
 */
export function filterByCategory(
  cases: BenchmarkTestCase[],
  category: string
): BenchmarkTestCase[] {
  return cases.filter((c) => c.category === category);
}

/**
 * Filter test cases by difficulty
 */
export function filterByDifficulty(
  cases: BenchmarkTestCase[],
  difficulty: string
): BenchmarkTestCase[] {
  return cases.filter((c) => c.difficulty === difficulty);
}

/**
 * Filter test cases by tags
 */
export function filterByTags(
  cases: BenchmarkTestCase[],
  tags: string[]
): BenchmarkTestCase[] {
  return cases.filter((c) => {
    if (!c.tags) {return false;}
    return tags.some((tag) => c.tags!.includes(tag));
  });
}
