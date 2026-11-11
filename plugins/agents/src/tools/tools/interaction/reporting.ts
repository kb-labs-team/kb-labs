/**
 * Reporting tools - for sub-agents to communicate with parent agent
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ClaimVerificationResult,
  EvidenceRequirements,
  EvidenceRecord,
  KernelState,
} from '../../../contracts/index.js';
import { useLLM } from '@kb-labs/sdk/hooks';
import type { Tool, ToolContext, ToolResponseRequirements } from '../../types.js';

async function hasPendingCorrectionCommit(context: ToolContext): Promise<boolean> {
  const kernel = await context.sessionMemory?.loadKernelState();
  if (!kernel) {
    return false;
  }
  return kernel.memory.pendingActions.some((action) =>
    action.status !== 'done'
    && action.content.startsWith('Persist user correction via memory_correction:')
  );
}

const VERIFY_REPORT_CLAIMS_PROMPT = [
  'Evaluate whether the proposed final agent answer is sufficiently supported by the provided session evidence.',
  'Prefer blocking only when the answer makes unsupported code, file, architecture, or behavioral claims.',
  'Allow simple session recall when kernel evidence is enough.',
  'If evidence is partial, prefer warn instead of block unless the answer states unsupported details as facts.',
  'Return strict JSON only.',
].join(' ');

async function verifyReportClaims(
  context: ToolContext,
  answer: string,
): Promise<ClaimVerificationResult> {
  const kernel = await context.sessionMemory?.loadKernelState();
  const requirements = await resolveResponseRequirements(context, answer, kernel);
  const evidence = kernel?.memory.evidence ?? [];
  const recallFastPath = verifyEvidenceBackedRecall(answer, kernel, requirements);
  if (recallFastPath) {
    return recallFastPath;
  }
  const fallback = deterministicVerification(answer, kernel, requirements);
  const llm = useLLM({ tier: 'small' });

  if (!llm?.complete) {
    return fallback;
  }

  try {
    const response = await llm.complete(buildClaimVerificationPrompt(answer, kernel, context), {
      systemPrompt: VERIFY_REPORT_CLAIMS_PROMPT,
      temperature: 0,
      maxTokens: 350,
    });
    return normalizeClaimVerification(response.content, fallback, evidence);
  } catch {
    return fallback;
  }
}

async function resolveResponseRequirements(
  context: ToolContext,
  answer: string,
  kernel: KernelState | null | undefined,
): Promise<ToolResponseRequirements | null> {
  if (!context.responseRequirementsResolver) {
    return null;
  }
  try {
    return await context.responseRequirementsResolver({
      task: context.currentTask,
      answer,
      kernel: kernel ?? null,
    });
  } catch {
    return null;
  }
}

function buildClaimVerificationPrompt(
  answer: string,
  kernel: KernelState | null | undefined,
  context: ToolContext,
): string {
  const recentEvidence = (kernel?.memory.evidence ?? [])
    .slice(-6)
    .map((item) => ({
      toolName: item.toolName ?? item.source,
      toolInputSummary: item.toolInputSummary,
      summary: item.summary,
    }));
  const archiveEvidence = (kernel?.memory.evidence ?? [])
    .slice(-4)
    .flatMap((item) => {
      if (!item.toolInputSummary || !context.archiveMemory?.hasFile(item.toolInputSummary)) {
        return [];
      }
      const archived = context.archiveMemory.recallByFilePath(item.toolInputSummary);
      if (!archived) {
        return [];
      }
      return [{
        filePath: item.toolInputSummary,
        toolName: archived.toolName,
        excerpt: truncateText(archived.fullOutput, 1200),
      }];
    });

  return JSON.stringify({
    answer,
    objective: kernel?.objective ?? kernel?.currentTask ?? '',
    constraints: kernel?.constraints ?? [],
    recentCorrections: kernel?.memory.corrections.slice(-3).map((item) => item.content) ?? [],
    recentEvidence,
    archiveEvidence,
    schema: {
      verdict: 'allow | warn | block',
      rationale: 'short explanation',
      requirements: {
        allowsMemoryOnlyRecall: 'boolean',
        needsDirectToolEvidence: 'boolean',
        needsFileBackedClaims: 'boolean',
        allowsInference: 'boolean',
        maxUnsupportedClaims: 'number',
      },
      supportedClaims: ['string'],
      unsupportedClaims: ['string'],
    },
  }, null, 2);
}

function normalizeClaimVerification(
  content: string,
  fallback: ClaimVerificationResult,
  evidence: EvidenceRecord[],
): ClaimVerificationResult {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return fallback;
  }

  const requirements = normalizeEvidenceRequirements(parsed.requirements, fallback.requirements);
  const verdict = parsed.verdict === 'allow' || parsed.verdict === 'warn' || parsed.verdict === 'block'
    ? parsed.verdict
    : fallback.verdict;
  const supportedClaims = normalizeStringArray(parsed.supportedClaims);
  const unsupportedClaims = normalizeStringArray(parsed.unsupportedClaims);
  const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim()
    ? parsed.rationale.trim()
    : fallback.rationale;

  if (verdict === 'block' && unsupportedClaims.length === 0 && evidence.length > 0) {
    return fallback;
  }

  return {
    verdict,
    rationale,
    requirements,
    supportedClaims,
    unsupportedClaims,
  };
}

function deterministicVerification(
  answer: string,
  kernel: KernelState | null | undefined,
  responseRequirements?: ToolResponseRequirements | null,
): ClaimVerificationResult {
  const evidence = kernel?.memory.evidence ?? [];
  const shellRecall = /shell command|previous shell command|used in this session|latest shell command/i.test(answer);
  const fileLikeClaims = /RuntimeEngine|projectKernelPrompt|compactKernelState|plugins\/|packages\/|\.ts\b|line \d+/i.test(answer);
  const hasFileEvidence = evidence.some((item) => item.toolName === 'fs_read');
  const hasShellEvidence = evidence.some((item) => item.toolName === 'shell_exec');
  const requirements = responseRequirements?.requirements;

  if (shellRecall && hasShellEvidence) {
    return {
      verdict: 'allow',
      rationale: 'Shell recall answer is grounded in stored shell_exec evidence.',
      requirements: {
        allowsMemoryOnlyRecall: true,
        needsDirectToolEvidence: false,
        needsFileBackedClaims: false,
        allowsInference: false,
        maxUnsupportedClaims: 0,
      },
      supportedClaims: ['Session shell recall supported by shell_exec evidence.'],
      unsupportedClaims: [],
    };
  }

  if (fileLikeClaims && !hasFileEvidence) {
    return {
      verdict: 'block',
      rationale: 'Code/file claims require fs_read-backed evidence before report is allowed.',
      requirements: {
        allowsMemoryOnlyRecall: false,
        needsDirectToolEvidence: true,
        needsFileBackedClaims: true,
        allowsInference: false,
        maxUnsupportedClaims: 0,
      },
      supportedClaims: [],
      unsupportedClaims: ['Answer makes file/code claims without fs_read evidence.'],
    };
  }

  return {
    verdict: 'allow',
    rationale: 'No unsupported claims were detected by deterministic fallback.',
    requirements: requirements ?? {
      allowsMemoryOnlyRecall: true,
      needsDirectToolEvidence: false,
      needsFileBackedClaims: false,
      allowsInference: true,
      maxUnsupportedClaims: 1,
    },
    supportedClaims: [],
    unsupportedClaims: [],
  };
}

function verifyEvidenceBackedRecall(
  answer: string,
  kernel: KernelState | null | undefined,
  responseRequirements: ToolResponseRequirements | null,
): ClaimVerificationResult | null {
  if (!responseRequirements?.requirements.allowsMemoryOnlyRecall) {
    return null;
  }

  const evidence = kernel?.memory.evidence ?? [];
  const fileEvidence = evidence
    .filter((item) => item.toolName === 'fs_read' && item.toolInputSummary)
    .map((item) => item.toolInputSummary as string);
  const mentionedFiles = extractMentionedFilePaths(answer);

  if (mentionedFiles.length > 0 && mentionedFiles.every((filePath) => fileEvidence.includes(filePath))) {
    return {
      verdict: 'allow',
      rationale: 'Answer is a direct recall of file evidence already recorded in the session.',
      requirements: responseRequirements.requirements,
      supportedClaims: mentionedFiles.map((filePath) => `Read evidence exists for ${filePath}.`),
      unsupportedClaims: [],
    };
  }

  return null;
}

function extractMentionedFilePaths(answer: string): string[] {
  const matches = answer.match(/plugins\/[^\s`*]+|packages\/[^\s`*]+/g) ?? [];
  return [...new Set(matches)];
}

function normalizeEvidenceRequirements(
  value: unknown,
  fallback: EvidenceRequirements,
): EvidenceRequirements {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  const input = value as Record<string, unknown>;
  return {
    allowsMemoryOnlyRecall: typeof input.allowsMemoryOnlyRecall === 'boolean'
      ? input.allowsMemoryOnlyRecall
      : fallback.allowsMemoryOnlyRecall,
    needsDirectToolEvidence: typeof input.needsDirectToolEvidence === 'boolean'
      ? input.needsDirectToolEvidence
      : fallback.needsDirectToolEvidence,
    needsFileBackedClaims: typeof input.needsFileBackedClaims === 'boolean'
      ? input.needsFileBackedClaims
      : fallback.needsFileBackedClaims,
    allowsInference: typeof input.allowsInference === 'boolean'
      ? input.allowsInference
      : fallback.allowsInference,
    maxUnsupportedClaims: typeof input.maxUnsupportedClaims === 'number'
      ? input.maxUnsupportedClaims
      : fallback.maxUnsupportedClaims,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Ask parent agent for help when stuck or uncertain.
 * Sub-agents use this to escalate to the main agent for guidance.
 */
export function createAskParentTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'ask_parent',
        description: `Ask the parent agent for help when stuck or need clarification.`,
        parameters: {
          type: 'object' as const,
          properties: {
            question: {
              type: 'string' as const,
              description: 'Your question for the parent agent. Be specific about what you need help with.',
            },
            reason: {
              type: 'string' as const,
              enum: ['stuck', 'uncertain', 'blocker', 'clarification'],
              description: 'Why are you asking? stuck=repeating tools, uncertain=unclear approach, blocker=cannot proceed, clarification=need more info',
            },
            context: {
              type: 'object' as const,
              description: 'Relevant context: tools tried, iteration number, what you attempted',
            },
          },
          required: ['question', 'reason'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const question = input.question as string;
      const reason = input.reason as string;
      const context = input.context as Record<string, unknown> | undefined;

      return {
        success: true,
        output: '', // Will be populated by parent agent
        metadata: {
          question,
          reason,
          context,
          needsParentHelp: true,
        },
      };
    },
  };
}

/**
 * Report findings and exit. Used by agents to provide synthesized answer
 * and signal early exit when task is complete.
 */
export function createReportTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'report',
        description: `Report your answer and exit. Include specific findings with file paths and code snippets as evidence.`,
        parameters: {
          type: 'object' as const,
          properties: {
            answer: {
              type: 'string' as const,
              description: 'Synthesized answer with specific details, file references, and code snippets. Be concise but complete.',
            },
            confidence: {
              type: 'number' as const,
              description: 'How confident you are in this answer (0.0-1.0). Use 0.8+ if you found concrete evidence, 0.5-0.7 if partial, <0.5 if uncertain.',
            },
          },
          required: ['answer', 'confidence'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const answer = input.answer as string;
      const confidence = input.confidence as number;

      // In plan mode (plan_validate is in the allowed tool set), prefer
      // plan_validate before report — but don't hard-block if budget is exhausted.
      // If the agent wrote a plan file via plan_write, allow report as fallback.
      const inPlanMode = context.allowedTools?.has('plan_validate') ?? false;
      if (inPlanMode && !context.planValidationPassed) {
        // Check if plan file exists on disk (written via plan_write)
        const planPath = context.sessionId
          ? path.join(context.workingDir, '.kb', 'agents', 'sessions', context.sessionId, 'plan.md')
          : null;
        const hasPlanFile = planPath && fs.existsSync(planPath);

        if (!hasPlanFile) {
          return {
            success: false,
            output: 'BLOCKED: You must either (1) call plan_validate first, or (2) save your plan via plan_write and then call report. Call plan_write with your plan content now.',
          };
        }
        // Plan file exists — allow report even without validation (budget fallback)
      }

      if (await hasPendingCorrectionCommit(context)) {
        return {
          success: false,
          output: 'BLOCKED: You must call memory_correction before report because this session has an unpersisted user correction or active instruction. Persist it first, then report.',
          metadata: {
            code: 'PENDING_MEMORY_COMMIT',
          },
        };
      }

      const verification = await verifyReportClaims(context, answer);
      if (verification.verdict === 'block') {
        return {
          success: false,
          output: `BLOCKED: Report claims are not sufficiently supported by session evidence. ${verification.rationale}`,
          metadata: {
            code: 'INSUFFICIENT_EVIDENCE',
            verification,
          },
        };
      }

      return {
        success: true,
        output: '', // Intentionally empty - agent should exit after calling this
        metadata: {
          answer,
          confidence,
          earlyExit: true,
          verification,
        },
      };
    },
  };
}

/**
 * Reflection tool - agent reflects on progress and decides whether to continue.
 * Auto-triggers report when confidence is high and shouldContinue is false.
 */
export function createReflectOnProgressTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'reflect_on_progress',
        description: `Reflect on progress and decide whether to continue or report. If confidence >= 0.7 and should_continue = false, auto-reports findings.`,
        parameters: {
          type: 'object' as const,
          properties: {
            findings_summary: {
              type: 'string' as const,
              description: 'Brief summary of what you accomplished so far (2-3 sentences)',
            },
            confidence: {
              type: 'number' as const,
              description: 'Confidence that task is complete (0.0-1.0). For implementation: 0.8+ only if artifacts created. For research: 0.8+ if answers found.',
              minimum: 0,
              maximum: 1,
            },
            questions_remaining: {
              type: 'array' as const,
              items: { type: 'string' as const },
              description: 'List of aspects still incomplete. Empty array if all done.',
            },
            should_continue: {
              type: 'boolean' as const,
              description: 'true = need more work, false = ready to report completion',
            },
            reason: {
              type: 'string' as const,
              description: 'Explanation for your continue/stop decision (1 sentence)',
            },
            evidence_of_completion: {
              type: 'string' as const,
              description: 'Concrete evidence of task completion (e.g., "Created 15 files", "Tests passing", "Found answer in 3 sources"). Required for high confidence.',
            },
          },
          required: ['findings_summary', 'confidence', 'questions_remaining', 'should_continue', 'reason', 'evidence_of_completion'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const reflection = {
        findingsSummary: input.findings_summary as string,
        confidence: input.confidence as number,
        questionsRemaining: input.questions_remaining as string[],
        shouldContinue: input.should_continue as boolean,
        reason: input.reason as string,
        evidenceOfCompletion: input.evidence_of_completion as string,
      };

      // Anti-hallucination check: If agent claims completion without evidence, reduce confidence
      const hasNoEvidence = !reflection.evidenceOfCompletion ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('need to') ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('will create') ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('plan to');

      let adjustedConfidence = reflection.confidence;
      let adjustedShouldContinue = reflection.shouldContinue;
      let warningMessage = '';

      if (reflection.confidence >= 0.7 && !reflection.shouldContinue && hasNoEvidence) {
        adjustedConfidence = 0.3;
        adjustedShouldContinue = true;
        warningMessage = ' [ADJUSTED: No concrete evidence of completion - lowered confidence to 0.30, continue required]';
      }

      return {
        success: true,
        output: `Reflection recorded: confidence=${adjustedConfidence.toFixed(2)}, should_continue=${adjustedShouldContinue}${warningMessage}`,
        metadata: {
          reflection: {
            ...reflection,
            confidence: adjustedConfidence,
            shouldContinue: adjustedShouldContinue,
          },
          shouldAutoReport: adjustedConfidence >= 0.7 && !adjustedShouldContinue,
          adjusted: adjustedConfidence !== reflection.confidence,
        },
      };
    },
  };
}
