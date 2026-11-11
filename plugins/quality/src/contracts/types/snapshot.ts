/**
 * Quality snapshot types — persistent history for trend tracking
 */

export interface DimensionScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  details: string[];
}

export interface DimensionScores {
  architecture: DimensionScore;
  typescript: DimensionScore;
  deadCode: DimensionScore;
  depHygiene: DimensionScore;
  testCoverage: DimensionScore;
}

export interface QualitySnapshot {
  id: string;
  timestamp: string;
  git: {
    commit: string;
    branch: string;
    message: string;
  };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: DimensionScores;
  /** Raw counters for delta computation */
  counters: {
    layeringViolations: number;
    avgInstability: number;
    anyCount: number;
    tsIgnoreCount: number;
    unusedFiles: number;
    unusedDeps: number;
  };
}

export interface SnapshotDelta {
  score: number;
  layeringViolations: number;
  anyCount: number;
  tsIgnoreCount: number;
  unusedFiles: number;
  unusedDeps: number;
  avgInstability: number;
}

export interface SnapshotHistory {
  snapshots: QualitySnapshot[];
  /** Delta vs previous snapshot, if history has >= 2 entries */
  delta: SnapshotDelta | null;
  latest: QualitySnapshot | null;
}
