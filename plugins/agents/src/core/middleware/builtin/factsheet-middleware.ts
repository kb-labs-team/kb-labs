/**
 * FactSheetMiddleware — structured working memory via SDK middleware hooks.
 *
 * Replaces 15 integration points in legacy Agent with 4 clean hooks:
 *
 *   afterToolExec   → heuristic fact extraction (instant, no LLM)
 *   afterIteration  → trigger LLM summarization every N iterations
 *   beforeLLMCall   → inject FactSheet into system message
 *   onStop          → persist to disk (non-critical)
 *
 * order = 20 (after Budget=10, ContextFilter=15; before Progress=50)
 *
 * Heuristic extraction runs after every tool call — zero latency, zero cost.
 * LLM extraction runs every N iterations — uses a separate small-tier LLM call
 * to extract structured facts from recent agent reasoning and tool results.
 */

import { useLLM, type ILLM, type LLMMessage, type LLMTool } from '@kb-labs/sdk';
import type {
  AgentMiddleware,
  RunContext,
  LLMCtx,
  LLMCallPatch,
  ToolExecCtx,
  ToolOutput,
} from '../../../sdk/index.js';
import type { FactCategory } from '../../../contracts/index.js';
import { FactSheet, type FactSheetConfig } from '../../memory/fact-sheet.js';

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FactSheetMiddlewareConfig {
  /** FactSheet config (maxTokens, maxEntries, minConfidence) */
  factSheet?: FactSheetConfig;
  /** LLM summarization every N iterations. 0 = disabled. Default: 5 */
  summarizationInterval?: number;
  /** Max tokens for LLM summary response. Default: 800 */
  maxSummaryTokens?: number;
  /** Directory for cross-session persistence. undefined = no persistence */
  persistDir?: string;
}

const DEFAULT_INTERVAL = 5;
const DEFAULT_MAX_SUMMARY_TOKENS = 800;

// ─── Extracted fact type ─────────────────────────────────────────────────────

interface ExtractedFact {
  category: FactCategory;
  fact: string;
  confidence: number;
  source: string;
}

// ─── FactSheetMiddleware ─────────────────────────────────────────────────────

export class FactSheetMiddleware implements AgentMiddleware {
  readonly name = 'factsheet';
  readonly order = 20;
  readonly config = { failPolicy: 'fail-open' as const };

  private sheet: FactSheet;
  private readonly factSheetConfig: FactSheetConfig;
  private readonly interval: number;
  private readonly maxSummaryTokens: number;
  private readonly persistDir?: string;
  private llm: ILLM | null = null;
  private pendingSummarization: Promise<void> | null = null;

  constructor(cfg: FactSheetMiddlewareConfig = {}) {
    this.factSheetConfig = cfg.factSheet ?? {};
    this.sheet = new FactSheet(this.factSheetConfig);
    this.interval = cfg.summarizationInterval ?? DEFAULT_INTERVAL;
    this.maxSummaryTokens = cfg.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
    this.persistDir = cfg.persistDir;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onStart(ctx: RunContext): Promise<void> {
    // Load persisted facts from prior session
    if (this.persistDir) {
      this.sheet = await this.loadFromDisk(this.persistDir);
    }

    // Acquire small-tier LLM for summarization
    if (this.interval > 0) {
      this.llm = useLLM({ tier: 'small' }) ?? null;
    }

    // Expose sheet stats via meta for other middlewares / tracing
    ctx.meta.set('factsheet', 'enabled', true);
  }

  async onStop(ctx: RunContext, _reason: string): Promise<void> {
    // Wait for any in-flight summarization
    if (this.pendingSummarization) {
      try { await this.pendingSummarization; } catch { /* non-critical */ }
    }

    // Persist facts to disk
    if (this.persistDir) {
      await this.saveToDisk(this.persistDir);
    }

    // Final stats for tracing
    ctx.meta.set('factsheet', 'finalStats', this.sheet.getStats());
  }

  // ── beforeLLMCall: inject FactSheet into context ───────────────────────────

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    const rendered = this.sheet.render();
    const runMemoryBlock = buildRunMemoryBlock(ctx.run);
    if (!rendered && !runMemoryBlock) {return undefined;}

    // Find system message and append FactSheet
    const messages = [...ctx.messages];
    const sysIdx = messages.findIndex(m => m.role === 'system');
    const sections: string[] = [];
    if (rendered) {
      sections.push(`# Working Memory (${this.sheet.size} facts)\n${rendered}`);
    }
    if (runMemoryBlock) {
      sections.push(runMemoryBlock);
    }
    const addition = sections.join('\n\n');

    if (sysIdx >= 0) {
      const sys = messages[sysIdx]!;
      messages[sysIdx] = {
        ...sys,
        content: sys.content + `\n\n${addition}`,
      };
    } else {
      // No system message — prepend one
      messages.unshift({
        role: 'system',
        content: addition,
      });
    }

    return { messages };
  }

  // ── afterToolExec: heuristic fact extraction ───────────────────────────────

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    if (!result.success) {return;}

    // Extract todo summary from todo tool metadata for Status Block
    const structured = result.metadata?.structured as Record<string, unknown> | undefined;
    if ((ctx.toolName === 'todo_create' || ctx.toolName === 'todo_update' || ctx.toolName === 'todo_get')
      && structured?.todoList) {
      const todoList = structured.todoList as { items?: Array<{ status: string }> };
      if (Array.isArray(todoList.items)) {
        const items = todoList.items;
        ctx.run.meta.set('todo', 'summary', {
          completed: items.filter(i => i.status === 'completed').length,
          inProgress: items.filter(i => i.status === 'in-progress').length,
          pending: items.filter(i => i.status === 'pending').length,
          blocked: items.filter(i => i.status === 'blocked').length,
          total: items.length,
        });
      }
    }

    const facts = extractHeuristicFacts(ctx.toolName, ctx.input, result.output);
    for (const f of facts) {
      this.sheet.add({
        ...f,
        iteration: ctx.iteration,
      });
    }
  }

  // ── afterIteration: trigger LLM summarization ─────────────────────────────

  async afterIteration(ctx: RunContext): Promise<void> {
    if (this.interval <= 0 || !this.llm) {return;}
    if (ctx.iteration % this.interval !== 0) {return;}

    // Non-blocking: fire and track
    this.pendingSummarization = this.runSummarization(ctx).catch(() => { /* fail-open */ });
  }

  // ── LLM Summarization ─────────────────────────────────────────────────────

  private async runSummarization(ctx: RunContext): Promise<void> {
    if (!this.llm) {return;}

    // Build compressed context from recent messages
    const recentMessages = ctx.messages.slice(-this.interval * 4); // ~4 messages per iteration
    const compressed = compressMessages(recentMessages as LLMMessage[]);
    if (!compressed) {return;}

    const systemPrompt = buildExtractionSystemPrompt(ctx.iteration - this.interval, ctx.iteration);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: compressed },
    ];

    let facts: ExtractedFact[] = [];

    // Prefer tool calling for structured output — more reliable than text JSON parsing
    if (this.llm.chatWithTools) {
      try {
        const response = await this.llm.chatWithTools(messages, {
          tools: [EXTRACT_FACTS_TOOL],
          toolChoice: { type: 'function', function: { name: 'extract_facts' } },
          temperature: 0.1,
          maxTokens: this.maxSummaryTokens,
        });
        const call = response.toolCalls?.find(tc => tc.name === 'extract_facts');
        if (call?.input) {
          facts = parseExtractedFactsFromToolInput(call.input);
        }
      } catch {
        // fall through to text completion fallback
      }
    }

    // Fallback: text completion with JSON parsing (when chatWithTools unavailable or failed)
    if (facts.length === 0 && this.llm.complete) {
      const prompt = buildExtractionPromptFallback(compressed, ctx.iteration - this.interval, ctx.iteration);
      const response = await this.llm.complete(prompt, {
        temperature: 0.1,
        maxTokens: this.maxSummaryTokens,
      });
      facts = parseExtractedFactsFromText((response.content || '').trim());
    }

    for (const f of facts) {
      this.sheet.add({
        ...f,
        iteration: ctx.iteration,
      });
    }

    ctx.meta.set('factsheet', 'lastSummarization', {
      iteration: ctx.iteration,
      factsExtracted: facts.length,
      stats: this.sheet.getStats(),
    });

    if (facts.length > 0) {
      ctx.eventBus.emit('middleware:event', {
        name: 'factsheet',
        event: 'summarized',
        data: { factsAdded: facts.length, totalFacts: this.sheet.size, iteration: ctx.iteration },
      });
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async loadFromDisk(dir: string): Promise<FactSheet> {
    const filePath = path.join(dir, 'fact-sheet.json');
    try {
      if (!fs.existsSync(filePath)) {return this.sheet;}
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return FactSheet.fromJSON(data, this.factSheetConfig);
    } catch {
      return this.sheet;
    }
  }

  private async saveToDisk(dir: string): Promise<void> {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'fact-sheet.json'),
        JSON.stringify(this.sheet.toJSON()),
        'utf-8',
      );
    } catch { /* non-critical */ }
  }
}

function buildRunMemoryBlock(run: RunContext): string | null {
  const lastSummary = run.meta.get<string>('loop', 'lastIterationSummary');
  const repeatsWithoutEvidence = run.meta.get<number>('loop', 'repeatsWithoutEvidence') ?? 0;
  const repeatNoEvidenceCount = run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0;
  const lastEvidenceCount = run.meta.get<number>('loop', 'lastEvidenceCount') ?? 0;
  const lastRecommendation = run.meta.get<string>('evaluation', 'lastRecommendation');
  const lastReadinessScore = run.meta.get<number>('evaluation', 'lastReadinessScore');
  const lastEvidenceGain = run.meta.get<number>('evaluation', 'lastEvidenceGain');

  // Always emit status block after iteration 1 (even if no evidence yet)
  if (run.iteration <= 1 && !lastSummary && repeatNoEvidenceCount === 0 && lastEvidenceCount === 0) {
    return null;
  }

  const task = (run as unknown as { task?: string }).task ?? '';

  // ── Iteration progress ────────────────────────────────────────────
  const iterPct = Math.round((run.iteration / run.maxIterations) * 100);

  // ── Budget ────────────────────────────────────────────────────────
  const tokensUsed = run.meta.get<number>('budget', 'tokensUsed') ?? 0;
  const maxTokens = run.meta.get<number>('budget', 'maxTokens') ?? 0;
  let budgetLine = '';
  if (maxTokens > 0) {
    const budgetPct = Math.round((tokensUsed / maxTokens) * 100);
    const indicator = budgetPct >= 90 ? '[CRITICAL]'
      : budgetPct >= 70 ? '[WARNING]'
      : budgetPct >= 50 ? '[CAUTION]'
      : '[OK]';
    budgetLine = `Budget: ${tokensUsed.toLocaleString()}/${maxTokens.toLocaleString()} tokens (${budgetPct}%) ${indicator}`;
  }

  // ── Progress status ───────────────────────────────────────────────
  const isStuck = run.meta.get<boolean>('progress', 'isStuck') ?? false;
  const itersSinceProgress = run.meta.get<number>('progress', 'iterationsSinceProgress') ?? 0;
  const progressStatus = isStuck
    ? `STUCK (${itersSinceProgress} iterations without progress)`
    : itersSinceProgress > 0
      ? `active (${itersSinceProgress} iterations since last progress)`
      : 'active';

  // ── Files ─────────────────────────────────────────────────────────
  const filesRead = run.meta.get<string[]>('files', 'read') ?? [];
  const filesModified = run.meta.get<string[]>('files', 'modified') ?? [];
  const filesCreated = run.meta.get<string[]>('files', 'created') ?? [];

  // ── Todos ──────────────────────────────────────────────────────────
  const todoSummary = run.meta.get<{ completed: number; inProgress: number; pending: number; blocked: number; total: number }>('todo', 'summary');

  // ── Build status block ────────────────────────────────────────────
  const lines: string[] = [
    '# Status Block',
    `Task: ${task || '(not set)'}`,
    `Iteration: ${run.iteration}/${run.maxIterations} (${iterPct}%)`,
  ];
  if (budgetLine) {
    lines.push(budgetLine);
  }
  lines.push(`Progress: ${progressStatus}`);
  lines.push(`Files: read=${filesRead.length}, modified=${filesModified.length}, created=${filesCreated.length}`);
  if (todoSummary) {
    const parts = [`${todoSummary.completed}/${todoSummary.total} completed`];
    if (todoSummary.inProgress > 0) {parts.push(`${todoSummary.inProgress} in-progress`);}
    if (todoSummary.blocked > 0) {parts.push(`${todoSummary.blocked} blocked`);}
    lines.push(`Todos: ${parts.join(', ')}`);
  }
  lines.push(`Evidence: ${lastEvidenceCount} facts collected`);
  if (lastSummary) {
    lines.push(`Last: ${lastSummary}`);
  }
  if (repeatsWithoutEvidence > 0) {
    lines.push(`Repeated intent streak: ${repeatsWithoutEvidence}`);
  }
  if (repeatNoEvidenceCount > 0) {
    lines.push(`Total repeat-without-evidence events: ${repeatNoEvidenceCount}`);
  }
  if (lastRecommendation) {
    const readiness = typeof lastReadinessScore === 'number' ? `, readiness=${lastReadinessScore}` : '';
    const gain = typeof lastEvidenceGain === 'number' ? `, gain=${lastEvidenceGain}` : '';
    lines.push(`Convergence: ${lastRecommendation}${readiness}${gain}`);
  }
  lines.push('Rule: if no new evidence appears for repeated actions, change strategy or report partial result.');

  return lines.join('\n');
}

// ─── Heuristic fact extraction (no LLM) ──────────────────────────────────────

function extractHeuristicFacts(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  switch (toolName) {
    case 'fs_read': {
      const filePath = input.path as string;
      const lines = (output.match(/\n/g) || []).length + 1;
      const firstLine = output.split('\n').find(l => l.trim().length > 0) || '';
      facts.push({
        category: 'file_content',
        fact: `Read ${filePath} (${lines} lines). Starts with: ${firstLine.slice(0, 80)}`,
        confidence: 0.9,
        source: toolName,
      });
      break;
    }

    case 'grep_search': {
      const pattern = input.pattern as string;
      const matchCount = (output.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `grep '${pattern}' found ~${matchCount} matches`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }

    case 'glob_search': {
      const globPattern = input.pattern as string;
      const fileCount = (output.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `glob '${globPattern}' found ~${fileCount} files`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }

    case 'find_definition': {
      const name = input.name as string;
      const preview = output.slice(0, 120).replace(/\n/g, ' ');
      facts.push({
        category: 'finding',
        fact: `Definition of '${name}': ${preview}`,
        confidence: 0.85,
        source: toolName,
      });
      break;
    }

    case 'shell_exec': {
      const cmd = (input.command as string || '').slice(0, 60);
      const preview = output.slice(0, 100).replace(/\n/g, ' ');
      facts.push({
        category: 'tool_result',
        fact: `shell '${cmd}': succeeded. Output: ${preview}`,
        confidence: 0.7,
        source: toolName,
      });
      break;
    }
  }

  return facts;
}

// ─── LLM summarization helpers ───────────────────────────────────────────────

function compressMessages(messages: LLMMessage[]): string | null {
  const lines = messages
    .map(msg => {
      if (msg.role === 'tool') {
        const content = msg.content || '';
        const preview = content.slice(0, 2000);
        return `Tool result: ${preview}${content.length > 2000 ? '...' : ''}`;
      }
      if (msg.role === 'assistant') {
        const parts: string[] = [];
        if (msg.content?.trim()) {
          parts.push(`Agent: ${msg.content.slice(0, 600)}${(msg.content.length > 600) ? '...' : ''}`);
        }
        if (msg.toolCalls?.length) {
          parts.push(`Calls: ${msg.toolCalls.map(tc => tc.name ?? (tc as { function?: { name?: string } }).function?.name).join(', ')}`);
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
      return null;
    })
    .filter((l): l is string => l !== null);

  return lines.length > 0 ? lines.join('\n\n') : null;
}

// ─── Tool definition for structured fact extraction ───────────────────────────

const EXTRACT_FACTS_TOOL: LLMTool = {
  name: 'extract_facts',
  description: 'Extract concrete, specific facts discovered during agent work iterations.',
  inputSchema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        description: 'List of concrete facts extracted from the agent context',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['file_content', 'architecture', 'finding', 'decision', 'blocker', 'correction', 'tool_result', 'environment'],
              description: 'Semantic category of the fact',
            },
            fact: {
              type: 'string',
              description: 'Concrete, specific fact. Good: "src/index.ts exports Agent class". Bad: "Agent searched for files"',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Confidence score 0.0-1.0',
            },
            source: {
              type: 'string',
              description: 'Source of this fact: "agent_reasoning" or tool name (e.g. "fs_read")',
            },
          },
          required: ['category', 'fact', 'confidence', 'source'],
        },
      },
    },
    required: ['facts'],
  },
};

function buildExtractionSystemPrompt(fromIter: number, toIter: number): string {
  return `You extract concrete FACTS from agent work during iterations ${fromIter} to ${toIter}.

Call extract_facts with facts discovered. Only include specific, verifiable facts:
GOOD: "src/index.ts exports Agent, FileMemory, FactSheet" [file_content]
GOOD: "Agent uses StateMachine for lifecycle" [architecture]
BAD: "Agent searched for files", "Tool was called"`;
}

// Fallback prompt for when chatWithTools is unavailable
function buildExtractionPromptFallback(context: string, fromIter: number, toIter: number): string {
  return `Extract concrete FACTS from agent work during iterations ${fromIter} to ${toIter}.

${context}

Output a JSON array of facts. Each fact:
- category: "file_content" | "architecture" | "finding" | "decision" | "blocker" | "correction" | "tool_result" | "environment"
- fact: concrete, specific fact (not vague descriptions)
- confidence: 0.0-1.0
- source: "agent_reasoning" or tool name

GOOD: "src/index.ts exports Agent, FileMemory, FactSheet" [file_content]
GOOD: "Agent uses StateMachine for lifecycle" [architecture]
BAD: "Agent searched for files", "Tool was called"

Output ONLY the JSON array:`;
}

// Parse facts from tool call input (structured, no regex needed)
function parseExtractedFactsFromToolInput(input: unknown): ExtractedFact[] {
  try {
    const data = input as { facts?: Array<{ category?: string; fact?: string; confidence?: number; source?: string }> };
    if (!Array.isArray(data?.facts)) {return [];}
    return data.facts
      .filter(f => f.category && f.fact)
      .map(f => ({
        category: (f.category as FactCategory) || 'finding',
        fact: f.fact!,
        confidence: Math.min(1.0, Math.max(0.0, f.confidence ?? 0.5)),
        source: f.source || 'llm_extraction',
      }));
  } catch {
    return [];
  }
}

// Fallback: parse facts from raw LLM text response (last JSON array wins)
function parseExtractedFactsFromText(raw: string): ExtractedFact[] {
  try {
    // Find the last '[' that starts a valid JSON array — LLM often prefixes with explanation
    let startIdx = raw.lastIndexOf('[');
    while (startIdx >= 0) {
      const slice = raw.slice(startIdx);
      let depth = 0;
      let endIdx = -1;
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === '[') {depth++;}
        else if (slice[i] === ']') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx >= 0) {
        try {
          const parsed = JSON.parse(slice.slice(0, endIdx + 1)) as Array<{
            category?: string; fact?: string; confidence?: number; source?: string;
          }>;
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed
              .filter(f => f.category && f.fact)
              .map(f => ({
                category: (f.category as FactCategory) || 'finding',
                fact: f.fact!,
                confidence: Math.min(1.0, Math.max(0.0, f.confidence ?? 0.5)),
                source: f.source || 'llm_extraction',
              }));
          }
        } catch { /* try earlier '[' */ }
      }
      startIdx = raw.lastIndexOf('[', startIdx - 1);
    }
    return [];
  } catch {
    return [];
  }
}
