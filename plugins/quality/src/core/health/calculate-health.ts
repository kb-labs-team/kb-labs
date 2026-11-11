/**
 * Multidimensional health score calculation.
 *
 * Composite score = weighted average of 5 dimensions:
 *   architecture  30% — layering violations + avg instability
 *   typescript    25% — any count + ts-ignore count
 *   deadCode      20% — unused files + unused exports from knip
 *   depHygiene    15% — unused + unlisted dependencies from knip
 *   testCoverage  10% — avg test coverage % (optional, defaults to 100 if unavailable)
 */

import { DIMENSION_WEIGHTS, HEALTH_GRADES } from '../../contracts/index.js';
import type {
  HealthScore,
  DimensionScore,
  DimensionScores,
  LayeringReport,
  CouplingReport,
  KnipReport,
  TypeAnalysisResult,
  QualityThresholds,
} from '../../contracts/index.js';

function gradeFromScore(score: number): HealthScore['grade'] {
  for (const [g, { min }] of Object.entries(HEALTH_GRADES) as [HealthScore['grade'], { min: number }][]) {
    if (score >= min) {return g;}
  }
  return 'F';
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── Dimension scorers ─────────────────────────────────────────────────────────

function scoreArchitecture(
  layering: LayeringReport,
  coupling: CouplingReport,
  thresholds: QualityThresholds
): DimensionScore {
  const details: string[] = [];

  // Each violation costs 5 points, max -60
  const layeringPenalty = Math.min(layering.totalViolations * 5, 60);
  if (layering.totalViolations > 0) {
    details.push(`${layering.totalViolations} layering violation(s) in ${layering.affectedPackages.length} package(s)`);
  }

  // Packages above instability threshold cost 3 points each, max -30
  const highInstability = coupling.packages.filter(p => p.instability > thresholds.instability);
  const couplingPenalty = Math.min(highInstability.length * 3, 30);
  if (highInstability.length > 0) {
    details.push(`${highInstability.length} package(s) with instability > ${thresholds.instability}`);
  }

  const score = clamp(100 - layeringPenalty - couplingPenalty);
  return { score, grade: gradeFromScore(score), details };
}

function scoreTypeScript(types: TypeAnalysisResult): DimensionScore {
  const details: string[] = [];

  const totalAny = types.packages.reduce((s, p) => s + p.anyCount, 0);
  const anyPenalty = Math.min(totalAny * 0.5, 50);
  if (totalAny > 0) {details.push(`${totalAny} \`any\` usage(s)`);}

  const totalIgnore = types.packages.reduce((s, p) => s + p.tsIgnoreCount, 0);
  const ignorePenalty = Math.min(totalIgnore * 2, 30);
  if (totalIgnore > 0) {details.push(`${totalIgnore} @ts-ignore(s)`);}

  const errorPenalty = Math.min(types.totalErrors * 3, 20);
  if (types.totalErrors > 0) {details.push(`${types.totalErrors} type error(s)`);}

  const score = clamp(100 - anyPenalty - ignorePenalty - errorPenalty);
  return { score, grade: gradeFromScore(score), details };
}

function scoreDeadCode(knip: KnipReport): DimensionScore {
  const details: string[] = [];

  const filePenalty = Math.min(knip.unusedFiles.length * 2, 50);
  if (knip.unusedFiles.length > 0) {details.push(`${knip.unusedFiles.length} unused file(s)`);}

  const exportPenalty = Math.min(knip.unusedExports.length * 0.5, 30);
  if (knip.unusedExports.length > 0) {details.push(`${knip.unusedExports.length} unused export(s)`);}

  const score = clamp(100 - filePenalty - exportPenalty);
  return { score, grade: gradeFromScore(score), details };
}

function scoreDepHygiene(knip: KnipReport): DimensionScore {
  const details: string[] = [];

  const unusedPenalty = Math.min(knip.unusedDependencies.length * 5, 50);
  if (knip.unusedDependencies.length > 0) {details.push(`${knip.unusedDependencies.length} unused dep(s)`);}

  const unlistedPenalty = Math.min(knip.unlistedDependencies.length * 10, 40);
  if (knip.unlistedDependencies.length > 0) {details.push(`${knip.unlistedDependencies.length} unlisted dep(s)`);}

  const score = clamp(100 - unusedPenalty - unlistedPenalty);
  return { score, grade: gradeFromScore(score), details };
}

function scoreTestCoverage(avgCoverage: number | null): DimensionScore {
  if (avgCoverage === null) {
    return { score: 100, grade: 'A', details: ['no coverage data — skipped'] };
  }
  const score = clamp(avgCoverage);
  const details = avgCoverage < 80 ? [`avg coverage ${avgCoverage.toFixed(1)}%`] : [];
  return { score, grade: gradeFromScore(score), details };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface HealthInput {
  layering: LayeringReport;
  coupling: CouplingReport;
  types: TypeAnalysisResult;
  knip: KnipReport;
  totalPackages: number;
  /** Average test coverage in %, or null if not collected */
  avgTestCoverage: number | null;
  thresholds: QualityThresholds;
}

export function calculateHealth(input: HealthInput): HealthScore {
  const { layering, coupling, types, knip, avgTestCoverage, thresholds } = input;

  const dimensions: DimensionScores = {
    architecture: scoreArchitecture(layering, coupling, thresholds),
    typescript: scoreTypeScript(types),
    deadCode: scoreDeadCode(knip),
    depHygiene: scoreDepHygiene(knip),
    testCoverage: scoreTestCoverage(avgTestCoverage),
  };

  const score = clamp(
    Object.entries(DIMENSION_WEIGHTS).reduce(
      (sum, [key, weight]) => sum + dimensions[key as keyof DimensionScores].score * weight,
      0
    )
  );

  return { score, grade: gradeFromScore(score), dimensions };
}
