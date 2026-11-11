/**
 * Types for quality:stats and quality:health commands
 */

import type { DimensionScores } from './snapshot.js';

export interface HealthScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: DimensionScores;
}

export interface PackageStats {
  name: string;
  path?: string;
  repository: string;
  files: number;
  lines: number;
  bytes: number;
}

export interface RepositoryStats {
  name: string;
  packages: number;
  files: number;
  lines: number;
  bytes: number;
}

export interface DependencyStats {
  total: number;
  workspace: number;
  external: number;
  duplicates: number;
  topUsed: Array<{ name: string; count: number }>;
}

export interface StatsResult {
  overview: {
    totalPackages: number;
    totalRepositories: number;
    totalFiles: number;
    totalLines: number;
    totalBytes: number;
  };
  byRepository: Record<string, RepositoryStats>;
  dependencies: DependencyStats;
  health: HealthScore;
  largestPackages: PackageStats[];
}
