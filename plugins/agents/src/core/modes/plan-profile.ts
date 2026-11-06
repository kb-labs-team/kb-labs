import type { IterationSnapshot } from '../../contracts/index.js';
import type {
  ArtifactWriter,
  OutputValidator,
  ResultMapper,
  RuntimeProfile,
  ResponseRequirementsSelector,
  PromptProjector,
  RunEvaluator,
} from '../../sdk/index.js';
import { PLAN_READ_ONLY_TOOL_NAMES } from '../../tools/index.js';
import type { SessionManager } from '../planning/session-manager.js';
import { PlanArtifactWriter } from './plan-artifact-writer.js';
import { PlanOutputValidator } from './plan-output-validator.js';
import type { TaskPlan } from '../../contracts/index.js';
import { createPlanResultMapper } from './plan-result-mapper.js';

const PLAN_SCOPED_TOOL_NAMES = [
  'fs_read',
  'fs_list',
  'glob_search',
  'grep_search',
  'find_definition',
  'code_stats',
  'memory_get',
  'memory_finding',
  'memory_blocker',
  'archive_recall',
  'ask_user',
  'report',
  'plan_validate',
] as const;

const PLAN_RESPONSE_REQUIREMENTS_SELECTOR: ResponseRequirementsSelector = {
  id: 'plan-profile-response-requirements',
  select(input) {
    return {
      requirements: {
        allowsMemoryOnlyRecall: false,
        needsDirectToolEvidence: true,
        needsFileBackedClaims: true,
        allowsInference: false,
        maxUnsupportedClaims: 0,
      },
      rationale: `Plan profile requires repository-backed evidence before proposing implementation steps for: ${input.task}`,
    };
  },
};

function createPlanRunEvaluator(enableDelegation: boolean): RunEvaluator {
  return {
    id: enableDelegation ? 'plan-profile-evaluator-broad' : 'plan-profile-evaluator-scoped',
    evaluate(input) {
      const snapshot = input.snapshot;
      if (shouldSynthesizePlan(snapshot, enableDelegation)) {
        return {
          evidenceGain: snapshot.evidenceDelta,
          readinessScore: 0.9,
          repeatedStrategy: snapshot.repeatsWithoutEvidence > 0,
          recommendation: 'synthesize',
          rationale: enableDelegation
            ? 'Planning profile has enough repository evidence or has stopped gaining new evidence; synthesize the plan now.'
            : 'Scoped planning profile has enough grounded evidence for the main path; stop exploring and draft the plan now.',
        };
      }

      if (snapshot.repeatsWithoutEvidence > 0) {
        return {
          evidenceGain: snapshot.evidenceDelta,
          readinessScore: enableDelegation ? 0.72 : 0.82,
          repeatedStrategy: true,
          recommendation: snapshot.evidenceCount >= (enableDelegation ? 2 : 1) ? 'synthesize' : 'narrow',
          rationale: snapshot.evidenceCount >= (enableDelegation ? 2 : 1)
            ? 'Planning profile already has enough grounded context; stop low-yield exploration and draft the plan.'
            : 'Planning profile detected low-yield exploration; narrow the scope before continuing.',
        };
      }

      return {
        evidenceGain: snapshot.evidenceDelta,
        readinessScore: Math.min(enableDelegation ? 0.8 : 0.88, 0.22 + (snapshot.evidenceCount * (enableDelegation ? 0.1 : 0.16))),
        repeatedStrategy: false,
        recommendation: 'continue',
        rationale: enableDelegation
          ? 'Planning profile is still gathering repository evidence.'
          : 'Scoped planning profile is still collecting the minimum repository evidence required for an executable plan.',
      };
    },
  };
}

export function createPlanRuntimeProfile(options?: {
  workingDir?: string;
  sessionManager?: SessionManager;
  task?: string;
  complexity?: 'simple' | 'medium' | 'complex';
  existingPlan?: TaskPlan | null;
}): RuntimeProfile {
  const resultMappers: ResultMapper[] = options?.task
    ? [createPlanResultMapper({
        task: options.task,
        complexity: options?.complexity ?? 'medium',
        existingPlan: options?.existingPlan ?? null,
      })]
    : [];
  const outputValidators: OutputValidator[] = options?.task
    ? [createPlanProfileOutputValidator(options.task)]
    : [];
  const artifactWriters: ArtifactWriter[] = options?.workingDir
    ? [createPlanProfileArtifactWriter(options.workingDir, options.sessionManager)]
    : [];
  const enableDelegation = shouldEnablePlanDelegation(options?.task, options?.complexity);

  return {
    id: 'plan-profile',
    mode: 'assistant',
    description: 'Planning-first profile with read-only tool access and stricter evidence requirements.',
    toolPolicy: {
      access: 'read-only',
      allowedToolNames: enableDelegation
        ? Array.from(PLAN_READ_ONLY_TOOL_NAMES)
        : Array.from(PLAN_SCOPED_TOOL_NAMES),
    },
    responseRequirementsSelectors: [PLAN_RESPONSE_REQUIREMENTS_SELECTOR],
    promptProjectors: [createPlanPromptProjector(options?.task, enableDelegation)],
    runEvaluators: [createPlanRunEvaluator(enableDelegation)],
    resultMappers,
    outputValidators,
    artifactWriters,
    completionPolicy: {
      requireReportTool: true,
      requireValidatorsToPass: true,
    },
  };
}

function shouldSynthesizePlan(snapshot: IterationSnapshot, enableDelegation: boolean): boolean {
  if (!enableDelegation && snapshot.iteration >= 3 && snapshot.evidenceCount >= 2) {
    return true;
  }
  if (snapshot.iteration >= 4 && snapshot.evidenceCount >= 3) {
    return true;
  }
  if (snapshot.iteration >= Math.max(3, Math.ceil(snapshot.maxIterations * 0.5)) && snapshot.evidenceCount >= 4) {
    return true;
  }
  if (!enableDelegation && snapshot.repeatNoEvidenceCount >= 1 && snapshot.evidenceCount >= 2) {
    return true;
  }
  if (snapshot.evidenceCount >= 6 && snapshot.evidenceDelta === 0) {
    return true;
  }
  if (snapshot.repeatNoEvidenceCount >= 2 && snapshot.evidenceCount >= 3) {
    return true;
  }
  return false;
}

function createPlanPromptProjector(task: string | undefined, enableDelegation: boolean): PromptProjector {
  const focusHints = derivePlanFocusHints(task);
  return {
    id: 'plan-profile-projector',
    project() {
      return [
        '# Active Profile',
        'Plan profile is active.',
        '- Treat this run as planning-first, not execution-first.',
        '- Prefer repository exploration and evidence-backed synthesis.',
        '- Produce actionable steps only after relevant files and commands are verified.',
        '- Once you have enough grounded evidence for the main implementation path, stop exploring and draft the plan.',
        ...(enableDelegation
          ? [
              '- This task is broad enough to justify selective async delegation when it clearly reduces wall-clock research time.',
            ]
          : [
              '- This task is scoped. Do not fan out into broad workspace exploration or async delegation unless the direct file path fails.',
              '- For scoped tasks, prefer 2-4 directly relevant files, then synthesize.',
            ]),
        ...(focusHints.length > 0
          ? [
              '# Scope Hints',
              '- Prioritize the task-specific scope hints below before searching unrelated repositories or packages.',
              ...focusHints.map((hint) => `- ${hint}`),
            ]
          : []),
      ].join('\n');
    },
  };
}

function shouldEnablePlanDelegation(
  task?: string,
  complexity: 'simple' | 'medium' | 'complex' = 'medium',
): boolean {
  if (complexity === 'complex') {
    return true;
  }
  if (!task) {
    return false;
  }
  return /\b(all repositories|all repos|all packages|entire workspace|whole workspace|across the repo|across repositories|monorepo-wide|workspace-wide)\b/i.test(task);
}

function derivePlanFocusHints(task?: string): string[] {
  if (!task) {
    return [];
  }
  const hints = new Set<string>();
  const repoMatches = task.match(/\bkb-labs-[a-z0-9-]+\b/gi) ?? [];
  for (const match of repoMatches) {
    hints.add(`Focus on repository or package references related to \`${match}\`.`);
  }
  const packageMatches = task.match(/\bagent-[a-z0-9-]+\b/gi) ?? [];
  for (const match of packageMatches) {
    hints.add(`Inspect package-level files related to \`${match}\` before broad workspace scans.`);
  }
  if (/runtime profile architecture/i.test(task)) {
    hints.add('Start with runtime/profile files in the active plugin before exploring generic platform runtime packages.');
  }
  return Array.from(hints).slice(0, 4);
}

function createPlanProfileOutputValidator(task: string): OutputValidator {
  const validator = new PlanOutputValidator();
  return {
    id: 'plan-profile-output-validator',
    validate(input) {
      const markdown = typeof input.metadata?.planMarkdown === 'string' && input.metadata.planMarkdown.trim().length > 0
        ? input.metadata.planMarkdown
        : input.answer;
      const result = validator.validate(markdown);
      return {
        verdict: result.passed ? 'allow' : 'block',
        rationale: result.summary || `Plan validation completed for task: ${task}`,
      };
    },
  };
}

function createPlanProfileArtifactWriter(
  workingDir: string,
  sessionManager?: SessionManager,
): ArtifactWriter {
  const writer = new PlanArtifactWriter(workingDir, sessionManager);
  return {
    id: 'plan-profile-artifact-writer',
    async write(input) {
      const plan = input.metadata?.plan;
      if (!plan || typeof plan !== 'object') {
        return;
      }
      await writer.write(input.sessionId, plan as never);
    },
  };
}
