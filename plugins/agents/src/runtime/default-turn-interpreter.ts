import type { TurnInterpretation, AgentMode, KernelState, TurnKind } from '../contracts/index.js';
import type { TurnInterpreter } from '../sdk/index.js';
import { useLLM } from '@kb-labs/sdk/hooks';

type InterpreterInput = {
  sessionId?: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  message: string;
  kernel: KernelState | null;
};

const INTERPRET_TURN_TOOL = {
  name: 'interpret_turn',
  description: 'Classify the latest user turn relative to the current session and determine whether it should be persisted as session memory.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['new_task', 'follow_up', 'correction', 'constraint', 'mixed'],
        description: 'Kind of user turn relative to current session state.',
      },
      shouldPersist: {
        type: 'boolean',
        description: 'True when this turn adds a lasting correction or instruction that should be committed to session memory.',
      },
      persistenceKind: {
        type: 'string',
        enum: ['correction', 'constraint'],
        description: 'When shouldPersist is true, describe whether this is a correction or lasting constraint.',
      },
      persistStrategy: {
        type: 'string',
        enum: ['record_directly', 'explicit_commit'],
        description: 'Use record_directly for baseline task constraints that should enter kernel immediately. Use explicit_commit for follow-up corrections that must be committed via memory tools before report.',
      },
      content: {
        type: 'string',
        description: 'Compact normalized content to persist when shouldPersist is true.',
      },
      invalidates: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of prior assumptions or directions invalidated by this turn.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in the interpretation.',
      },
      suggestedMode: {
        type: 'string',
        enum: ['assistant', 'autonomous', 'spec', 'debug', 'execute', 'plan', 'edit'],
        description: 'Optional suggested mode for downstream routing.',
      },
      suggestedSkills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional suggested skill ids for prompt/routing layers.',
      },
      suggestedPromptProfile: {
        type: 'string',
        description: 'Optional prompt profile hint for later routing layers.',
      },
      suggestedToolCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tool capability hints for later routing layers.',
      },
      rationale: {
        type: 'string',
        description: 'Short explanation of why this interpretation was selected.',
      },
    },
    required: ['kind', 'shouldPersist', 'confidence'],
  },
};

export function createDefaultTurnInterpreter(): TurnInterpreter {
  return {
    id: 'default-turn-interpreter',
    supports(_mode: AgentMode | 'assistant' | 'autonomous'): boolean {
      return true;
    },
    async interpret(input: InterpreterInput): Promise<TurnInterpretation | null> {
      const normalized = input.message.trim();
      if (!normalized) {
        return null;
      }

      const llmInterpretation = await interpretWithLLM(input);
      if (llmInterpretation) {
        return llmInterpretation;
      }

      return interpretHeuristic(input);
    },
  };
}

async function interpretWithLLM(input: InterpreterInput): Promise<TurnInterpretation | null> {
  const llm = useLLM({ tier: 'small' });
  if (!llm?.chatWithTools) {
    return null;
  }

  try {
    const response = await llm.chatWithTools(
      [
        {
          role: 'system',
          content: [
            'Classify the latest user turn relative to the current session.',
            'Call interpret_turn exactly once.',
            'Persist only when the user changed direction, corrected prior understanding, or added a lasting instruction/constraint.',
            'Do not persist ordinary follow-up questions.',
            'Keep rationale short.',
          ].join(' '),
        },
        {
          role: 'user',
          content: buildInterpreterPrompt(input),
        },
      ],
      {
        tools: [INTERPRET_TURN_TOOL],
        toolChoice: { type: 'function', function: { name: 'interpret_turn' } },
        temperature: 0,
        maxTokens: 180,
      },
    );

    const call = response.toolCalls?.find((toolCall) => toolCall.name === 'interpret_turn');
    if (!call?.input || typeof call.input !== 'object') {
      return null;
    }

    return normalizeInterpretation(call.input as Record<string, unknown>);
  } catch {
    return null;
  }
}

function buildInterpreterPrompt(input: InterpreterInput): string {
  const sections = [
    `Mode: ${input.mode}`,
    `Current message:\n${input.message.trim()}`,
  ];

  if (input.kernel) {
    sections.push(`Current objective:\n${input.kernel.objective ?? input.kernel.currentTask}`);
    if (input.kernel.constraints.length > 0) {
      sections.push(`Active constraints:\n- ${input.kernel.constraints.join('\n- ')}`);
    }
    const recentCorrections = input.kernel.memory.corrections.slice(-3).map((item) => item.content);
    if (recentCorrections.length > 0) {
      sections.push(`Recent corrections:\n- ${recentCorrections.join('\n- ')}`);
    }
    const pendingActions = input.kernel.memory.pendingActions
      .filter((item) => item.status !== 'done')
      .slice(-3)
      .map((item) => item.content);
    if (pendingActions.length > 0) {
      sections.push(`Open pending actions:\n- ${pendingActions.join('\n- ')}`);
    }
  }

  return sections.join('\n\n');
}

function normalizeInterpretation(input: Record<string, unknown>): TurnInterpretation | null {
  const kind = normalizeTurnKind(input.kind);
  if (!kind) {
    return null;
  }

  const shouldPersist = Boolean(input.shouldPersist);
  const persistenceKind = normalizePersistenceKind(input.persistenceKind);
  const persistStrategy = normalizePersistStrategy(input.persistStrategy);
  const confidence = clampConfidence(input.confidence);

  return {
    kind,
    shouldPersist,
    persistenceKind: shouldPersist ? persistenceKind ?? defaultPersistenceKind(kind) : undefined,
    persistStrategy: shouldPersist ? persistStrategy : undefined,
    content: typeof input.content === 'string' && input.content.trim()
      ? input.content.trim()
      : undefined,
    invalidates: Array.isArray(input.invalidates)
      ? input.invalidates.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined,
    confidence,
    suggestedMode: typeof input.suggestedMode === 'string' ? input.suggestedMode as TurnInterpretation['suggestedMode'] : undefined,
    suggestedSkills: normalizeStringArray(input.suggestedSkills),
    suggestedPromptProfile: typeof input.suggestedPromptProfile === 'string' && input.suggestedPromptProfile.trim()
      ? input.suggestedPromptProfile.trim()
      : undefined,
    suggestedToolCapabilities: normalizeStringArray(input.suggestedToolCapabilities),
    rationale: typeof input.rationale === 'string' && input.rationale.trim()
      ? input.rationale.trim()
      : 'Structured default interpreter classification.',
  };
}

function interpretHeuristic(input: InterpreterInput): TurnInterpretation | null {
  const normalized = input.message.trim();
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  const correctionMarkers = [
    'correction:',
    'correct:',
    'from now on',
    'do not',
    'don’t',
    'dont',
    'only answer',
    'теперь',
    'только',
    'я имел в виду',
    'не это',
  ];
  const isCorrectionLike = correctionMarkers.some((marker) => lower.includes(marker));
  if (!isCorrectionLike) {
    return {
      kind: 'follow_up',
      shouldPersist: false,
      confidence: 0.2,
      rationale: 'Fallback heuristic interpreter found no lasting-instruction markers.',
    };
  }
  const isConstraint = lower.includes('from now on')
    || lower.includes('only answer')
    || lower.includes('do not')
    || lower.includes('только')
    || lower.includes('не ');
  return {
    kind: isConstraint ? 'constraint' : 'correction',
    shouldPersist: true,
    persistenceKind: isConstraint ? 'constraint' : 'correction',
    content: normalized,
    invalidates: [],
    confidence: 0.55,
    rationale: 'Fallback heuristic interpreter matched correction markers.',
  };
}

function normalizeTurnKind(value: unknown): TurnKind | null {
  return value === 'new_task'
    || value === 'follow_up'
    || value === 'correction'
    || value === 'constraint'
    || value === 'mixed'
    ? value
    : null;
}

function normalizePersistenceKind(value: unknown): 'correction' | 'constraint' | undefined {
  return value === 'correction' || value === 'constraint' ? value : undefined;
}

function normalizePersistStrategy(value: unknown): 'record_directly' | 'explicit_commit' | undefined {
  return value === 'record_directly' || value === 'explicit_commit' ? value : undefined;
}

function defaultPersistenceKind(kind: TurnKind): 'correction' | 'constraint' | undefined {
  if (kind === 'constraint') {
    return 'constraint';
  }
  if (kind === 'correction' || kind === 'mixed') {
    return 'correction';
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function clampConfidence(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, num));
}
