/**
 * Spec Output Validator — deterministic rubric-based quality gate for generated specs.
 *
 * Checks coverage (plan steps covered), precision (before/after diffs present),
 * and file validity without LLM calls.
 * Returns a composite score (0–1) and pass/fail verdict.
 */

import type { TaskPlan, TaskSpec } from '../../contracts/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecSeverity = 'error' | 'warning' | 'info';

export interface SpecValidatorIssue {
  dimension: 'coverage' | 'precision' | 'files';
  severity: SpecSeverity;
  message: string;
}

export interface SpecRubricScore {
  raw: number;       // 0.0–1.0 before weighting
  weighted: number;  // raw * weight
  details: string;
}

export interface SpecValidationResult {
  passed: boolean;
  score: number;
  metrics: {
    planStepCount: number;
    coveredStepRefs: number;
    uncoveredStepCount: number;
    phaseCoverage: number;
    stepCoverage: number;
    diffPairs: number;
  };
  rubric: {
    coverage: SpecRubricScore;
    precision: SpecRubricScore;
    files: SpecRubricScore;
  };
  issues: SpecValidatorIssue[];
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const W_COVERAGE  = 0.40;
const W_PRECISION = 0.35;
const W_FILES     = 0.25;

const PASS_THRESHOLD = 0.60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect file-path-like tokens. */
const FILE_PATH_RE = /[\w@.-]+\/[\w@.-]+\.[\w]{1,5}/;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export class SpecValidator {
  /**
   * Validate a spec against its source plan and return rubric-based scoring.
   */
  validate(spec: TaskSpec, plan: TaskPlan): SpecValidationResult {
    const issues: SpecValidatorIssue[] = [];

    const coverage = this.scoreCoverage(spec, plan, issues);
    const precision = this.scorePrecision(spec, issues);
    const files = this.scoreFiles(spec, issues);

    const score = clamp01(
      coverage.weighted +
      precision.weighted +
      files.weighted
    );
    const planStepCount = plan.phases.reduce((sum, phase) => sum + phase.steps.length, 0);
    const totalChanges = spec.sections.reduce((sum, section) => sum + section.changes.length, 0);
    const coveredStepRefs = Math.min(planStepCount, totalChanges);
    const coveredPhases = new Set(spec.sections.map((section) => section.planPhaseId)).size;
    const phaseCoverage = plan.phases.length > 0 ? clamp01(coveredPhases / plan.phases.length) : 0;
    const stepCoverage = planStepCount > 0 ? clamp01(coveredStepRefs / planStepCount) : 0;

    const hasErrors = issues.some((i) => i.severity === 'error');
    const passed = score >= PASS_THRESHOLD && !hasErrors;

    return {
      passed,
      score,
      metrics: {
        planStepCount,
        coveredStepRefs,
        uncoveredStepCount: Math.max(0, planStepCount - coveredStepRefs),
        phaseCoverage,
        stepCoverage,
        diffPairs: coveredStepRefs,
      },
      rubric: { coverage, precision, files },
      issues,
    };
  }

  /**
   * Validate from raw markdown (when structured spec is not yet parsed).
   */
  validateMarkdown(markdown: string, plan: TaskPlan): SpecValidationResult {
    const issues: SpecValidatorIssue[] = [];
    const text = (markdown || '').trim();

    if (!text) {
      issues.push({ dimension: 'coverage', severity: 'error', message: 'Spec is empty.' });
      const zero: SpecRubricScore = { raw: 0, weighted: 0, details: 'empty' };
      return {
        passed: false,
        score: 0,
        metrics: {
          planStepCount: plan.phases.reduce((sum, p) => sum + p.steps.length, 0),
          coveredStepRefs: 0,
          uncoveredStepCount: plan.phases.reduce((sum, p) => sum + p.steps.length, 0),
          phaseCoverage: 0,
          stepCoverage: 0,
          diffPairs: 0,
        },
        rubric: { coverage: zero, precision: zero, files: zero },
        issues,
      };
    }

    // Count before/after blocks
    const beforeBlocks = (text.match(/\*\*Before[^*]*\*\*:?/gi) || []).length;
    const afterBlocks = (text.match(/\*\*After[^*]*\*\*:?/gi) || []).length;
    const diffPairs = Math.min(beforeBlocks, afterBlocks);

    // Count plan steps
    const planStepCount = plan.phases.reduce((sum, p) => sum + p.steps.length, 0);

    const phaseRefs = new Set<string>();
    const stepRefs = new Set<string>();
    const headerRe = /^###\s+\[([^\]]+)\]/gm;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(text)) !== null) {
      const ref = (match[1] || '').trim();
      if (!ref) {continue;}
      if (ref.includes(':')) {
        const [phaseId, stepId] = ref.split(':');
        if (phaseId) {phaseRefs.add(phaseId.trim());}
        if (stepId) {stepRefs.add(`${phaseId?.trim()}:${stepId.trim()}`);}
      } else {
        phaseRefs.add(ref);
      }
    }

    const phaseCoverage = plan.phases.length > 0 ? clamp01(phaseRefs.size / plan.phases.length) : 0;
    const stepRefCoverage = planStepCount > 0 ? clamp01(stepRefs.size / planStepCount) : 0;
    const diffCoverage = planStepCount > 0 ? clamp01(diffPairs / planStepCount) : 0;
    // Balanced coverage: explicit step references + actual diff pairs + phase spread.
    const covRatio = clamp01((diffCoverage * 0.5) + (stepRefCoverage * 0.35) + (phaseCoverage * 0.15));
    const coverage: SpecRubricScore = {
      raw: covRatio,
      weighted: covRatio * W_COVERAGE,
      details: `${diffPairs} diff pairs, step refs ${stepRefs.size}/${planStepCount}, phases ${phaseRefs.size}/${plan.phases.length}`,
    };

    if (diffPairs === 0) {
      issues.push({ dimension: 'coverage', severity: 'error', message: 'Spec has no before/after diff blocks.' });
    } else if (stepRefCoverage < 0.5) {
      issues.push({
        dimension: 'coverage',
        severity: 'error',
        message: `Insufficient step coverage: only ${stepRefs.size}/${planStepCount} plan steps referenced.`,
      });
    } else if (covRatio < 0.7) {
      issues.push({
        dimension: 'coverage',
        severity: 'warning',
        message: `Coverage is partial: ${stepRefs.size}/${planStepCount} steps, ${diffPairs}/${planStepCount} diff pairs.`,
      });
    }

    // Precision: check that before/after blocks have content (not empty)
    const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
    const nonEmptyCodeBlocks = codeBlocks.filter((b) => b.replace(/```\w*\n?/g, '').trim().length > 0);
    const precRatio = codeBlocks.length > 0 ? clamp01(nonEmptyCodeBlocks.length / codeBlocks.length) : 0;
    const precision: SpecRubricScore = {
      raw: precRatio,
      weighted: precRatio * W_PRECISION,
      details: `${nonEmptyCodeBlocks.length}/${codeBlocks.length} non-empty code blocks`,
    };

    if (codeBlocks.length === 0) {
      issues.push({ dimension: 'precision', severity: 'error', message: 'Spec has no code blocks.' });
    }

    // Files: check file paths are present
    const fileMatches = text.match(/\*\*File:\*\*\s*`[^`]+`/g) || [];
    const validFiles = fileMatches.filter((m) => {
      const path = m.replace(/\*\*File:\*\*\s*`/, '').replace(/`$/, '');
      return FILE_PATH_RE.test(path);
    });
    const fileRatio = fileMatches.length > 0 ? clamp01(validFiles.length / fileMatches.length) : 0;
    const filesScore: SpecRubricScore = {
      raw: fileRatio,
      weighted: fileRatio * W_FILES,
      details: `${validFiles.length}/${fileMatches.length} valid file references`,
    };

    if (fileMatches.length === 0) {
      issues.push({ dimension: 'files', severity: 'error', message: 'Spec references no files.' });
    }

    const score = clamp01(coverage.weighted + precision.weighted + filesScore.weighted);
    const hasErrors = issues.some((i) => i.severity === 'error');

    const coveredStepRefs = Math.min(planStepCount, Math.max(stepRefs.size, diffPairs));
    return {
      passed: score >= PASS_THRESHOLD && !hasErrors,
      score,
      metrics: {
        planStepCount,
        coveredStepRefs,
        uncoveredStepCount: Math.max(0, planStepCount - coveredStepRefs),
        phaseCoverage,
        stepCoverage: stepRefCoverage,
        diffPairs,
      },
      rubric: { coverage, precision, files: filesScore },
      issues,
    };
  }

  // -----------------------------------------------------------------------
  // Coverage — all plan steps have corresponding spec sections
  // -----------------------------------------------------------------------

  private scoreCoverage(spec: TaskSpec, plan: TaskPlan, issues: SpecValidatorIssue[]): SpecRubricScore {
    const planStepCount = plan.phases.reduce((sum, p) => sum + p.steps.length, 0);
    const specSectionCount = spec.sections.length;
    const totalChanges = spec.sections.reduce((sum, s) => sum + s.changes.length, 0);

    if (planStepCount === 0) {
      return { raw: 1, weighted: W_COVERAGE, details: 'Plan has no steps' };
    }

    // Check which plan phases are covered
    const coveredPhases = new Set(spec.sections.map((s) => s.planPhaseId));
    const totalPhases = plan.phases.length;
    const phaseCoverage = coveredPhases.size / totalPhases;

    const stepCoverage = clamp01(totalChanges / planStepCount);
    const raw = clamp01((phaseCoverage * 0.5) + (stepCoverage * 0.5));

    if (specSectionCount === 0) {
      issues.push({ dimension: 'coverage', severity: 'error', message: 'Spec has no sections.' });
    } else if (stepCoverage < 0.5) {
      issues.push({
        dimension: 'coverage',
        severity: 'error',
        message: `Insufficient step coverage: only ${totalChanges}/${planStepCount} changes generated.`,
      });
    } else if (phaseCoverage < 0.5) {
      issues.push({
        dimension: 'coverage',
        severity: 'warning',
        message: `Only ${coveredPhases.size}/${totalPhases} plan phases covered in spec.`,
      });
    }

    return {
      raw,
      weighted: raw * W_COVERAGE,
      details: `${coveredPhases.size}/${totalPhases} phases, ${totalChanges}/${planStepCount} step-level changes`,
    };
  }

  // -----------------------------------------------------------------------
  // Precision — before/after diffs are non-empty
  // -----------------------------------------------------------------------

  private scorePrecision(spec: TaskSpec, issues: SpecValidatorIssue[]): SpecRubricScore {
    const allChanges = spec.sections.flatMap((s) => s.changes);
    if (allChanges.length === 0) {
      issues.push({ dimension: 'precision', severity: 'error', message: 'Spec has no code changes.' });
      return { raw: 0, weighted: 0, details: '0 changes' };
    }

    let withBothDiffs = 0;
    for (const change of allChanges) {
      if (change.before.trim().length > 0 && change.after.trim().length > 0) {
        withBothDiffs++;
      }
    }

    const raw = clamp01(withBothDiffs / allChanges.length);

    if (withBothDiffs === 0) {
      issues.push({ dimension: 'precision', severity: 'error', message: 'No changes have both before and after code.' });
    } else if (raw < 0.5) {
      issues.push({
        dimension: 'precision',
        severity: 'warning',
        message: `Only ${withBothDiffs}/${allChanges.length} changes have complete before/after diffs.`,
      });
    }

    return {
      raw,
      weighted: raw * W_PRECISION,
      details: `${withBothDiffs}/${allChanges.length} complete diffs`,
    };
  }

  // -----------------------------------------------------------------------
  // Files — valid file paths in changes
  // -----------------------------------------------------------------------

  private scoreFiles(spec: TaskSpec, issues: SpecValidatorIssue[]): SpecRubricScore {
    const allChanges = spec.sections.flatMap((s) => s.changes);
    if (allChanges.length === 0) {
      return { raw: 0, weighted: 0, details: '0 changes' };
    }

    let validPaths = 0;
    for (const change of allChanges) {
      if (FILE_PATH_RE.test(change.file)) {
        validPaths++;
      }
    }

    const raw = clamp01(validPaths / allChanges.length);

    if (validPaths === 0) {
      issues.push({ dimension: 'files', severity: 'error', message: 'No changes reference valid file paths.' });
    }

    return {
      raw,
      weighted: raw * W_FILES,
      details: `${validPaths}/${allChanges.length} valid file paths`,
    };
  }
}
