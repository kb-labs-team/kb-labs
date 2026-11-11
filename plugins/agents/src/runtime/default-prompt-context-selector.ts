import type { KernelState, PromptContextSelection } from '../contracts/index.js';
import type { PromptContextSelector } from '../sdk/index.js';
import type { LLMMessage } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk/hooks';
import { createDefaultPromptContextSelection } from '../kernel/index.js';
import type { RuntimeResponseRequirements } from './response-requirements.js';

const DEFAULT_SELECTOR_SYSTEM_PROMPT = [
  'Select which structured memory sections should be shown to the model for the next answer.',
  'Prefer evidence and tool-usage sections for recall questions about files, commands, previous runs, or what was verified.',
  'Avoid including working summary when it may override direct evidence for the current question.',
  'Return strict JSON only.',
].join(' ');

export function createDefaultPromptContextSelector(): PromptContextSelector {
  return {
    id: 'default-prompt-context-selector',
    async select(input: {
      state: KernelState;
      messages: LLMMessage[];
      responseRequirements?: RuntimeResponseRequirements;
    }): Promise<PromptContextSelection> {
      const fallback = deterministicPromptContextSelection(input.state, input.messages, input.responseRequirements);
      const llm = useLLM({ tier: 'small' });
      if (!llm?.complete) {
        return fallback;
      }

      try {
        const response = await llm.complete(buildSelectionPrompt(input.state, input.messages, input.responseRequirements), {
          systemPrompt: DEFAULT_SELECTOR_SYSTEM_PROMPT,
          temperature: 0,
          maxTokens: 220,
        });
        return normalizeSelection(response.content, fallback);
      } catch {
        return fallback;
      }
    },
  };
}

function buildSelectionPrompt(
  state: KernelState,
  messages: LLMMessage[],
  responseRequirements?: RuntimeResponseRequirements,
): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  return JSON.stringify({
    currentUserMessage: typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '',
    objective: state.objective ?? state.currentTask,
    constraints: state.constraints,
    hasRollup: Boolean(state.rollup?.summary),
    latestSummary: truncateText(state.memory.latestSummary ?? '', 400),
    recentEvidence: state.memory.evidence.slice(-6).map((item) => ({
      toolName: item.toolName ?? item.source,
      toolInputSummary: item.toolInputSummary,
      summary: item.summary,
    })),
    pendingActions: state.memory.pendingActions.filter((item) => item.status !== 'done').slice(-5).map((item) => item.content),
    responseRequirements,
    schema: {
      includeObjective: 'boolean',
      includeSessionRollup: 'boolean',
      includeConstraints: 'boolean',
      includeRoutingHints: 'boolean',
      includeCorrections: 'boolean',
      includeDecisions: 'boolean',
      includeEvidence: 'boolean',
      includePreviousRunToolUsage: 'boolean',
      includePreviousRunHandoff: 'boolean',
      includeWorkingSummary: 'boolean',
      includePendingActions: 'boolean',
      correctionWindow: 'number',
      decisionWindow: 'number',
      evidenceWindow: 'number',
      toolUsageWindow: 'number',
      pendingActionWindow: 'number',
      rationale: 'string',
    },
  }, null, 2);
}

function normalizeSelection(content: string, fallback: PromptContextSelection): PromptContextSelection {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return fallback;
  }

  return {
    includeObjective: asBoolean(parsed.includeObjective, fallback.includeObjective),
    includeSessionRollup: asBoolean(parsed.includeSessionRollup, fallback.includeSessionRollup),
    includeConstraints: asBoolean(parsed.includeConstraints, fallback.includeConstraints),
    includeRoutingHints: asBoolean(parsed.includeRoutingHints, fallback.includeRoutingHints),
    includeCorrections: asBoolean(parsed.includeCorrections, fallback.includeCorrections),
    includeDecisions: asBoolean(parsed.includeDecisions, fallback.includeDecisions),
    includeEvidence: asBoolean(parsed.includeEvidence, fallback.includeEvidence),
    includePreviousRunToolUsage: asBoolean(parsed.includePreviousRunToolUsage, fallback.includePreviousRunToolUsage),
    includePreviousRunHandoff: asBoolean(parsed.includePreviousRunHandoff, fallback.includePreviousRunHandoff),
    includeWorkingSummary: asBoolean(parsed.includeWorkingSummary, fallback.includeWorkingSummary),
    includePendingActions: asBoolean(parsed.includePendingActions, fallback.includePendingActions),
    correctionWindow: asNumber(parsed.correctionWindow, fallback.correctionWindow),
    decisionWindow: asNumber(parsed.decisionWindow, fallback.decisionWindow),
    evidenceWindow: asNumber(parsed.evidenceWindow, fallback.evidenceWindow),
    toolUsageWindow: asNumber(parsed.toolUsageWindow, fallback.toolUsageWindow),
    pendingActionWindow: asNumber(parsed.pendingActionWindow, fallback.pendingActionWindow),
    rationale: typeof parsed.rationale === 'string' && parsed.rationale.trim() ? parsed.rationale.trim() : fallback.rationale,
  };
}

function deterministicPromptContextSelection(
  state: KernelState,
  messages: LLMMessage[],
  responseRequirements?: RuntimeResponseRequirements,
): PromptContextSelection {
  const selection = createDefaultPromptContextSelection(state);
  if (responseRequirements?.requirements.allowsMemoryOnlyRecall) {
    return {
      ...selection,
      includeSessionRollup: false,
      includeDecisions: false,
      includePreviousRunHandoff: false,
      includeWorkingSummary: false,
      includeEvidence: true,
      includePreviousRunToolUsage: true,
      evidenceWindow: Math.max(selection.evidenceWindow, 6),
      toolUsageWindow: Math.max(selection.toolUsageWindow, 5),
      rationale: responseRequirements.rationale,
    };
  }
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const text = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.toLowerCase() : '';
  const recallSignal = /(which files|what files|inspected|read so far|previous run|previous shell command|latest shell command|used so far|what did you read|какие файлы|что ты читал|какую команду)/i.test(text);
  if (!recallSignal) {
    return selection;
  }
  return {
    ...selection,
    includeSessionRollup: false,
    includeDecisions: false,
    includePreviousRunHandoff: false,
    includeWorkingSummary: false,
    includeEvidence: true,
    includePreviousRunToolUsage: true,
    evidenceWindow: Math.max(selection.evidenceWindow, 6),
    toolUsageWindow: Math.max(selection.toolUsageWindow, 5),
    rationale: 'Recall-oriented selection prefers direct evidence and tool usage over prose summaries.',
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

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}
