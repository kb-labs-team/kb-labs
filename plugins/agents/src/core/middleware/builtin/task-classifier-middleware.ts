/**
 * TaskClassifierMiddleware — intent inference and scope extraction.
 *
 * Feature-flagged: enabled when FeatureFlags.taskClassifier is true.
 * Runs first (order=5) — classification informs other middlewares.
 *
 * Classification strategy:
 * 1. LLM tool calling (preferred) — language-agnostic, semantic, uses classify_task tool
 * 2. Heuristic regex fallback — instant, no LLM cost, English/Russian keywords
 */

import type { FeatureFlags } from '../../../contracts/index.js';
import type { RunContext } from '../../../sdk/index.js';
import { useLLM, type LLMTool } from '@kb-labs/sdk';

export type TaskIntent = 'action' | 'discovery' | 'analysis';

export interface TaskClassification {
  intent: TaskIntent;
  scope?: string;
  confidence: number;
}

// ─── Tool definition for LLM-based classification ────────────────────────────

const CLASSIFY_TASK_TOOL: LLMTool = {
  name: 'classify_task',
  description: 'Classify the user task intent and extract scope.',
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['action', 'discovery', 'analysis'],
        description: '"action" = create/modify/fix something; "discovery" = find/explain/show something; "analysis" = evaluate/audit/compare something',
      },
      scope: {
        type: 'string',
        description: 'Optional: main subject/target of the task (e.g. "authentication system", "src/index.ts")',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in this classification 0.0-1.0',
      },
    },
    required: ['intent', 'confidence'],
  },
};

// ─── Regex fallback (English + Russian keywords) ──────────────────────────────

const ACTION_PATTERNS    = /\b(create|add|fix|update|delete|remove|implement|write|modify|change|refactor|rename|создай|добавь|исправь|удали|реализуй|измени|переименуй)\b/i;
const DISCOVERY_PATTERNS = /\b(find|search|locate|where|what|show|list|explain|describe|how does|найди|где|что|покажи|объясни|опиши|как работает)\b/i;
const ANALYSIS_PATTERNS  = /\b(analyze|review|audit|check|compare|evaluate|assess|benchmark|profile|проанализируй|проверь|сравни|оцени|изучи)\b/i;

function classifyHeuristic(task: string): TaskClassification {
  const hasAction    = ACTION_PATTERNS.test(task);
  const hasDiscovery = DISCOVERY_PATTERNS.test(task);
  const hasAnalysis  = ANALYSIS_PATTERNS.test(task);

  let intent: TaskIntent;
  let confidence: number;

  if (hasAction && !hasDiscovery && !hasAnalysis) {
    intent = 'action'; confidence = 0.8;
  } else if (hasAnalysis && !hasAction) {
    intent = 'analysis'; confidence = 0.8;
  } else if (hasDiscovery && !hasAction && !hasAnalysis) {
    intent = 'discovery'; confidence = 0.8;
  } else if (hasAction && (hasDiscovery || hasAnalysis)) {
    intent = 'action'; confidence = 0.5;
  } else {
    intent = 'action'; confidence = 0.3;
  }

  return { intent, confidence };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export interface TaskClassifierCallbacks {
  onClassified?: (classification: TaskClassification) => void;
}

export class TaskClassifierMiddleware {
  readonly name = 'task-classifier';
  readonly order = 5;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 5000 };

  private readonly callbacks: TaskClassifierCallbacks;
  private _classification: TaskClassification | null = null;
  private _featureFlags?: FeatureFlags;

  constructor(callbacks: TaskClassifierCallbacks = {}) {
    this.callbacks = callbacks;
  }

  enabled(): boolean {
    return this._featureFlags?.taskClassifier ?? false;
  }

  withFeatureFlags(flags: FeatureFlags): this {
    this._featureFlags = flags;
    return this;
  }

  get classification(): TaskClassification | null {
    return this._classification;
  }

  async onStart(ctx: RunContext): Promise<void> {
    const classification = await this.classify(ctx.task);
    this._classification = classification;
    ctx.meta.set('classifier', 'intent', classification.intent);
    ctx.meta.set('classifier', 'confidence', classification.confidence);
    if (classification.scope) {
      ctx.meta.set('classifier', 'scope', classification.scope);
    }
    this.callbacks.onClassified?.(classification);
  }

  private async classify(task: string): Promise<TaskClassification> {
    // Try LLM tool calling first — language-agnostic, semantic classification
    const llm = useLLM({ tier: 'small' });
    if (llm?.chatWithTools) {
      try {
        const response = await llm.chatWithTools(
          [
            {
              role: 'system',
              content: 'Classify the user task. Call classify_task with the intent, optional scope, and confidence.',
            },
            { role: 'user', content: task },
          ],
          {
            tools: [CLASSIFY_TASK_TOOL],
            toolChoice: { type: 'function', function: { name: 'classify_task' } },
            temperature: 0,
            maxTokens: 100,
          },
        );

        const call = response.toolCalls?.find(tc => tc.name === 'classify_task');
        if (call?.input) {
          const data = call.input as { intent?: string; scope?: string; confidence?: number };
          if (data.intent === 'action' || data.intent === 'discovery' || data.intent === 'analysis') {
            return {
              intent: data.intent,
              scope: data.scope,
              confidence: Math.min(1.0, Math.max(0.0, data.confidence ?? 0.7)),
            };
          }
        }
      } catch {
        // fall through to heuristic fallback
      }
    }

    // Fallback: fast heuristic regex (no LLM cost)
    return classifyHeuristic(task);
  }

  reset(): void {
    this._classification = null;
  }
}
