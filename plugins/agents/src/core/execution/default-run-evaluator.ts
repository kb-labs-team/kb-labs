import type { IterationSnapshot, RunEvaluation } from '../../contracts/index.js';
import type { RunEvaluator, RunContext } from '../../sdk/index.js';

const MIN_SYNTHESIS_READINESS = 0.62;
const LOW_GAIN_THRESHOLD = 0.2;

export function createDefaultRunEvaluator(): RunEvaluator {
  return {
    id: 'default-run-evaluator',
    evaluate(input: { run: RunContext; snapshot: IterationSnapshot }): RunEvaluation {
      const { run, snapshot } = input;

      const progressRatio = snapshot.maxIterations > 0
        ? snapshot.iteration / snapshot.maxIterations
        : 0;
      const evidenceGain = clamp01(
        (snapshot.evidenceDelta >= 2 ? 0.7 : snapshot.evidenceDelta > 0 ? 0.45 : 0)
        + (snapshot.filesReadCount > 0 ? 0.15 : 0)
        + (snapshot.filesModifiedCount > 0 || snapshot.filesCreatedCount > 0 ? 0.1 : 0),
      );
      const evidenceCoverage = clamp01(snapshot.evidenceCount / 6);
      const readinessScore = clamp01(
        (evidenceCoverage * 0.6)
        + (progressRatio * 0.2)
        + (snapshot.newEvidence ? 0.1 : 0)
        + (snapshot.repeatsWithoutEvidence > 0 ? 0.1 : 0),
      );
      const repeatedStrategy = snapshot.repeatsWithoutEvidence > 0;
      const previousRecommendation = run.meta.get<string>('evaluation', 'lastRecommendation');

      let recommendation: RunEvaluation['recommendation'] = 'continue';
      let rationale = 'Recent iterations are still adding useful evidence.';

      if (!snapshot.newEvidence && repeatedStrategy && readinessScore < MIN_SYNTHESIS_READINESS) {
        recommendation = 'narrow';
        rationale = 'Recent iterations are repeating without adding evidence; narrow the search to unresolved gaps.';
      }

      if (
        !snapshot.newEvidence
        && readinessScore >= MIN_SYNTHESIS_READINESS
        && (
          repeatedStrategy
          || evidenceGain <= LOW_GAIN_THRESHOLD
          || previousRecommendation === 'narrow'
        )
      ) {
        recommendation = 'synthesize';
        rationale = 'Evidence gain has flattened and the run has enough support to synthesize a bounded answer.';
      }

      return {
        evidenceGain,
        readinessScore,
        repeatedStrategy,
        recommendation,
        rationale,
      };
    },
  };
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Math.round(value * 100) / 100;
}
