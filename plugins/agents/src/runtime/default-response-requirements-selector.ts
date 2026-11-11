import type { EvidenceRequirements, KernelState } from '../contracts/index.js';
import type { ResponseRequirementsSelector } from '../sdk/index.js';
import type { LLMMessage } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk/hooks';
import type { RuntimeResponseRequirements } from './response-requirements.js';

const DEFAULT_REQUIREMENTS: EvidenceRequirements = {
  allowsMemoryOnlyRecall: true,
  needsDirectToolEvidence: false,
  needsFileBackedClaims: false,
  allowsInference: true,
  maxUnsupportedClaims: 1,
};

export function createDefaultResponseRequirementsSelector(): ResponseRequirementsSelector {
  return {
    id: 'default-response-requirements-selector',
    async select(input: {
      state: KernelState | null;
      messages: LLMMessage[];
      task: string;
    }): Promise<RuntimeResponseRequirements> {
      const fallback = deterministicRequirements(input.task);
      const llm = useLLM({ tier: 'small' });
      if (!llm?.complete) {
        return fallback;
      }

      try {
        const response = await llm.complete(buildRequirementsPrompt(input), {
          systemPrompt: [
            'Determine how strictly the next answer must be grounded in evidence.',
            'Allow evidence-only recall when the user asks about files, commands, or actions already observed in the session.',
            'Require file-backed claims for architecture or code explanations.',
            'Return strict JSON only.',
          ].join(' '),
          temperature: 0,
          maxTokens: 180,
        });
        return normalizeRequirements(response.content, fallback);
      } catch {
        return fallback;
      }
    },
  };
}

function buildRequirementsPrompt(input: {
  state: KernelState | null;
  messages: LLMMessage[];
  task: string;
}): string {
  return JSON.stringify({
    task: input.task,
    objective: input.state?.objective ?? input.state?.currentTask ?? '',
    constraints: input.state?.constraints ?? [],
    recentEvidence: input.state?.memory.evidence.slice(-6).map((item) => ({
      toolName: item.toolName ?? item.source,
      toolInputSummary: item.toolInputSummary,
      summary: item.summary,
    })) ?? [],
    schema: {
      requirements: {
        allowsMemoryOnlyRecall: 'boolean',
        needsDirectToolEvidence: 'boolean',
        needsFileBackedClaims: 'boolean',
        allowsInference: 'boolean',
        maxUnsupportedClaims: 'number',
      },
      rationale: 'string',
    },
  }, null, 2);
}

function normalizeRequirements(content: string, fallback: RuntimeResponseRequirements): RuntimeResponseRequirements {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return fallback;
  }
  const requirements = normalizeEvidenceRequirements(parsed.requirements, fallback.requirements);
  const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim()
    ? parsed.rationale.trim()
    : fallback.rationale;
  return { requirements, rationale };
}

function deterministicRequirements(task: string): RuntimeResponseRequirements {
  const text = task.trim().toLowerCase();
  const recallSignal = /(which files|what files|which commands|what commands|did you inspect|did you read|used so far|previous run|previous shell command|latest shell command|какие файлы|что ты читал|какую команду)/i.test(text);
  if (recallSignal) {
    return {
      requirements: {
        allowsMemoryOnlyRecall: true,
        needsDirectToolEvidence: true,
        needsFileBackedClaims: false,
        allowsInference: false,
        maxUnsupportedClaims: 0,
      },
      rationale: 'Task looks like session recall and can be answered from recorded evidence.',
    };
  }

  const codeExplanationSignal = /(how .*work|explain|architecture|responsibilit|continuity|rollup|claim verification|risk|summary of .*src\/|inspect .*src\/)/i.test(text);
  if (codeExplanationSignal) {
    return {
      requirements: {
        allowsMemoryOnlyRecall: false,
        needsDirectToolEvidence: true,
        needsFileBackedClaims: true,
        allowsInference: false,
        maxUnsupportedClaims: 0,
      },
      rationale: 'Task looks like code or architecture explanation and requires file-backed evidence.',
    };
  }

  return {
    requirements: DEFAULT_REQUIREMENTS,
    rationale: 'Default requirements allow bounded inference unless the task is clearly evidence-heavy.',
  };
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
