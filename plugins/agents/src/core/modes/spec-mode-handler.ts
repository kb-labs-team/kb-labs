/**
 * Spec mode handler — generates a detailed specification from an approved plan.
 *
 * Not a separate AgentMode. Called from REST/CLI after plan approval.
 * Creates a child agent with read-only tools + plan markdown in the system prompt.
 * The agent reads actual source files, verifies code at specified line numbers,
 * and produces exact before/after diffs for each plan step.
 *
 * Output: TaskSpec (structured) + spec.md (human-readable markdown).
 */

import type {
  AgentConfig,
  AgentEvent,
  TaskPlan,
  TaskSpec,
  SpecSection,
  SpecChange,
  TaskResult,
  ToolDefinition,
} from '../../contracts/index.js';
import { DEFAULT_AGENT_TOKEN_BUDGET_CONFIG } from '../../contracts/index.js';
import { ToolRegistry } from '../../tools/index.js';
import { AgentSDK, type IAgentRunner } from '../../sdk/index.js';
import { createCoreToolPack } from '../tools/index.js';
import { SessionManager } from '../planning/session-manager';
import { SpecValidator } from '../planning/spec-validator';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Read-only tool set (same as plan mode, but spec needs deeper file reads)
// ---------------------------------------------------------------------------

const SPEC_READ_ONLY_TOOLS = new Set<string>([
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
  'todo_create',
  'todo_update',
  'todo_get',
  'ask_user',
  'report',
]);

interface DelegatedResearchPack {
  title: string;
  prompt: string;
}

class SharedTokenBudget {
  private consumed = 0;

  constructor(private readonly total: number) {}

  get remaining(): number {
    return Math.max(0, this.total - this.consumed);
  }

  get used(): number {
    return Math.max(0, this.consumed);
  }

  allocate(requested: number, minimum = 4000): number {
    const requestedSafe = Number.isFinite(requested) ? Math.max(minimum, Math.floor(requested)) : minimum;
    if (this.remaining <= 0) {return 0;}
    return Math.min(this.remaining, requestedSafe);
  }

  consume(tokensUsed: number): void {
    if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) {return;}
    this.consumed += Math.floor(tokensUsed);
  }
}

/**
 * A ToolRegistry restricted to an allowed set of tool names.
 * Extends ToolRegistry so it can be passed wherever ToolRegistry is expected
 * without unsafe casts — override the read/execute methods to filter by allowedNames.
 */
class ReadOnlySpecToolRegistry extends ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly allowedNames: Set<string>,
  ) {
    super(base.getContext());
  }

  override get(name: string) {
    if (!this.allowedNames.has(name)) {return undefined;}
    return this.base.get(name);
  }

  override getDefinitions(): ToolDefinition[] {
    return this.base
      .getDefinitions()
      .filter((def) => this.allowedNames.has(def.function.name));
  }

  override async execute(name: string, input: Record<string, unknown>) {
    if (!this.allowedNames.has(name)) {
      throw new Error(`Tool "${name}" is disabled in spec mode (read-only).`);
    }
    return this.base.execute(name, input);
  }

  override getToolNames(): string[] {
    return this.base
      .getToolNames()
      .filter((tool) => this.allowedNames.has(tool));
  }

  override getContext() {
    return this.base.getContext();
  }
}

// ---------------------------------------------------------------------------
// SpecModeHandler
// ---------------------------------------------------------------------------

export class SpecModeHandler {
  /**
   * Generate a detailed specification from an approved plan.
   *
   * @param plan - Approved TaskPlan (must have status 'approved')
   * @param config - Agent config (workingDir, onEvent, etc.)
   * @param toolRegistry - Full tool registry (will be wrapped read-only)
   * @returns TaskResult with .spec populated
   */
  async execute(
    plan: TaskPlan,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const sessionId = plan.sessionId;
    const sessionManager = new SessionManager(config.workingDir);

    const specBudget = this.resolveSpecBudgetPolicy(config, plan);
    const sharedBudget = new SharedTokenBudget(specBudget.maxTokens);
    const budgetSnapshot = () => this.buildBudgetSnapshot(sharedBudget, specBudget.maxTokens);
    const effectiveMaxIterations = this.resolveSpecIterations(plan, specBudget.maxTokens);
    const synthesisReserveIterations = Math.max(
      2,
      Math.floor(effectiveMaxIterations * specBudget.synthesisReserveRatio),
    );
    const researchBudget = Math.max(4, effectiveMaxIterations - synthesisReserveIterations);

    this.emit(config, {
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        status: 'planning',
        message: 'Spec mode: generating detailed specification from approved plan',
        ...budgetSnapshot(),
      },
    });
    this.emit(config, {
      type: 'progress:update',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        phase: 'spec',
        progress: 5,
        message: `Generating spec for ${plan.phases.length} phases (budget: ${effectiveMaxIterations} iterations, ~${specBudget.maxTokens} tokens)`,
        ...budgetSnapshot(),
      },
    });

    try {
      const readOnlyRegistry = new ReadOnlySpecToolRegistry(toolRegistry, SPEC_READ_ONLY_TOOLS);
      const delegatedResearch = await this.runDelegatedResearchPacks(
        plan,
        config,
        readOnlyRegistry,
        sharedBudget,
        specBudget.maxTokens,
      );
      const specPrompt = this.buildSpecPrompt(
        plan,
        effectiveMaxIterations,
        researchBudget,
        synthesisReserveIterations,
        specBudget.maxTokens,
        sharedBudget.remaining,
        delegatedResearch,
      );

      let reportedSpecText = '';
      let lastLongThinking = '';
      const childOnEvent: AgentConfig['onEvent'] = (event) => {
        // Capture report tool output — the spec markdown
        if (event.type === 'tool:end' && event.data?.toolName === 'report') {
          const metadataAnswer = (event.data?.metadata as { answer?: unknown } | undefined)?.answer;
          const output = typeof event.data?.output === 'string' ? event.data.output : '';
          const answer = typeof metadataAnswer === 'string' ? metadataAnswer : '';
          const captured = answer.trim() || output.trim();
          if (captured) {
            reportedSpecText = captured;
          }
        }
        // Capture direct LLM output that looks like a spec
        if (event.type === 'llm:end') {
          const content = typeof event.data?.content === 'string' ? event.data.content.trim() : '';
          if (content && /\*\*File:\*\*/m.test(content)) {
            reportedSpecText = content;
          }
          // Keep the longest thinking output as fallback — agent may write
          // the spec in the final Thought when report tool fails
          if (content && content.length > lastLongThinking.length && /```[\w]*\n/.test(content)) {
            lastLongThinking = content;
          }
        }
        config.onEvent?.(event);
      };

      const specRunner = this.createSubRunner(
        {
          ...config,
          sessionId,
          mode: undefined,
          maxIterations: effectiveMaxIterations,
          tokenBudget: {
            ...config.tokenBudget,
            enabled: true,
            maxTokens: sharedBudget.allocate(sharedBudget.remaining, 12_000),
            softLimitRatio: config.tokenBudget?.softLimitRatio ?? 0.75,
            hardLimitRatio: config.tokenBudget?.hardLimitRatio ?? 0.95,
            hardStop: config.tokenBudget?.hardStop ?? true,
            forceSynthesisOnHardLimit: config.tokenBudget?.forceSynthesisOnHardLimit ?? true,
            restrictBroadExplorationAtSoftLimit:
              config.tokenBudget?.restrictBroadExplorationAtSoftLimit ?? true,
            allowIterationBudgetExtension:
              config.tokenBudget?.allowIterationBudgetExtension ?? false,
          },
          onEvent: childOnEvent,
        },
        readOnlyRegistry,
      );

      const specResult = await specRunner.execute(specPrompt);
      sharedBudget.consume(specResult.tokensUsed);
      // Priority: report tool output > LLM direct output > last long thinking > summary
      const rawSummary = specResult.summary;
      const isSummaryUseless = !rawSummary || rawSummary === 'No answer provided' || rawSummary.length < 50;
      let specMarkdown = reportedSpecText
        || (isSummaryUseless ? '' : rawSummary)
        || lastLongThinking
        || rawSummary;
      if (!specMarkdown.trim() || specMarkdown.trim() === 'Unable to synthesize findings') {
        specMarkdown = this.buildFallbackPartialSpec(plan, specResult.filesRead, specBudget.maxTokens);
      }

      // Parse and validate
      const validator = new SpecValidator();
      let validation = validator.validateMarkdown(specMarkdown, plan);
      if (!validation.passed && validation.metrics.uncoveredStepCount > 0) {
        const repaired = await this.tryRepairSpecWithCoverageGaps({
          plan,
          currentSpecMarkdown: specMarkdown,
          uncoveredSteps: this.collectUncoveredPlanSteps(plan, specMarkdown),
          baseConfig: config,
          toolRegistry: readOnlyRegistry,
          tokenBudget: sharedBudget.remaining,
          sharedBudget,
        });
        if (repaired) {
          const repairedValidation = validator.validateMarkdown(repaired, plan);
          if (repairedValidation.score > validation.score) {
            specMarkdown = repaired;
            validation = repairedValidation;
          }
        }
      }

      // Build structured spec
      const now = new Date().toISOString();
      const specId = `spec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const sections = this.parseSpecSections(specMarkdown, plan);
      const hasMaterial =
        sections.length > 0
        || /\*\*File:\*\*\s*`/.test(specMarkdown)
        || specMarkdown.trim().length > 300;
      let specStatus: TaskSpec['status'] = validation.passed ? 'draft' : 'failed';
      if (!validation.passed && specBudget.partialOnFailure && hasMaterial) {
        specStatus = 'partial';
      }

      const spec: TaskSpec = {
        id: specId,
        planId: plan.id,
        sessionId,
        task: plan.task,
        sections,
        status: specStatus,
        markdown: specMarkdown,
        createdAt: now,
        updatedAt: now,
      };

      // Also validate structured spec if sections were parsed
      if (sections.length > 0) {
        const structuredValidation = validator.validate(spec, plan);
        if (!structuredValidation.passed && !(specBudget.partialOnFailure && hasMaterial)) {
          spec.status = 'failed';
        }
      }

      // Persist spec.json + spec.md
      const specPath = sessionManager.getSessionSpecPath(sessionId);
      const specMdPath = sessionManager.getSessionSpecMdPath(sessionId);
      await fs.mkdir(path.dirname(specPath), { recursive: true });
      await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf-8');
      await fs.writeFile(specMdPath, specMarkdown, 'utf-8');

      // Update plan status to spec_ready if spec is usable
      if (spec.status === 'draft' || spec.status === 'partial') {
        const planPath = sessionManager.getSessionPlanPath(sessionId);
        try {
          const planData = JSON.parse(await fs.readFile(planPath, 'utf-8')) as TaskPlan;
          planData.status = 'spec_ready';
          planData.updatedAt = now;
          await fs.writeFile(planPath, JSON.stringify(planData, null, 2), 'utf-8');
        } catch {
          // Plan file may not exist in some flows — non-critical
        }
      }

      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'spec',
          progress: 100,
          message: spec.status === 'failed'
            ? `Spec quality insufficient (score: ${validation.score.toFixed(2)})`
            : `Spec ready (${sections.length} sections, status: ${spec.status}, score: ${validation.score.toFixed(2)})`,
          ...budgetSnapshot(),
        },
      });

      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: spec.status === 'failed' ? 'error' : 'waiting',
          message: spec.status === 'failed'
            ? `Spec generation failed (score: ${validation.score.toFixed(2)})`
            : spec.status === 'partial'
              ? 'Partial spec ready. Review gaps before execution.'
              : 'Spec ready. Review before execution.',
          ...budgetSnapshot(),
        },
      });

      const totalChanges = sections.reduce((sum, s) => sum + s.changes.length, 0);
      const specFailed = spec.status === 'failed';

      return {
        success: !specFailed,
        summary: specFailed
          ? `Spec generation incomplete — quality score ${validation.score.toFixed(2)}`
          : spec.status === 'partial'
            ? `Partial spec ready (${sections.length} sections, ${totalChanges} changes, score: ${validation.score.toFixed(2)})`
            : `Spec ready (${sections.length} sections, ${totalChanges} changes, score: ${validation.score.toFixed(2)})`,
        filesCreated: [specPath, specMdPath],
        filesModified: [],
        filesRead: specResult.filesRead,
        iterations: specResult.iterations,
        tokensUsed: specResult.tokensUsed,
        sessionId,
        spec,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: 'error',
          message,
        },
      });
      this.emit(config, {
        type: 'agent:end',
        timestamp: new Date().toISOString(),
        sessionId,
        startedAt,
        data: {
          success: false,
          summary: 'Spec mode failed',
          iterations: 1,
          tokensUsed: 0,
          durationMs: Date.now() - startMs,
          filesCreated: [],
          filesModified: [],
          stopReason: 'error',
        },
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Spec prompt
  // -------------------------------------------------------------------------

  private buildSpecPrompt(
    plan: TaskPlan,
    maxIterations: number,
    researchBudget: number,
    synthesisReserveIterations: number,
    tokenBudget: number,
    remainingTokens: number,
    delegatedResearch?: string,
  ): string {
    const planMarkdown = plan.markdown || this.planToMarkdownFallback(plan);
    const delegatedResearchSection = delegatedResearch
      ? `\nDELEGATED RESEARCH SNAPSHOT:\n${delegatedResearch}\n`
      : '';

    return `SPEC MODE ACTIVE — Generating detailed specification from approved plan.

APPROVED PLAN:
${planMarkdown}
${delegatedResearchSection}

YOUR TASK:
For EACH step in the plan above, produce an exact before/after code diff.

PROCESS:
1. Read the file mentioned in the plan step using fs_read
2. Find the exact lines described in the step
3. Verify the current code matches what the plan describes
4. Write the before/after diff showing the minimal change needed
5. Repeat for every step

BUDGET: ${maxIterations} iterations total (~${tokenBudget} tokens).
CURRENT TOKEN BUDGET: ${remainingTokens}/${tokenBudget} tokens remaining. Work carefully and avoid low-value exploration.
- Research/read budget: up to ${researchBudget} iterations
- Reserved for synthesis/verification: ${synthesisReserveIterations} iterations
- Prefer spending budget on concrete section output over extra exploration near the end.

OUTPUT FORMAT — for each change, use exactly this structure:

### [phase-id:step-id] Short title

**File:** \`path/to/file.ts\`
**Lines:** start-end

**Before (current):**
\`\`\`ts
<EXACT copy of current code — verified by reading the file>
\`\`\`

**After:**
\`\`\`ts
<new code — minimal diff, change only what's needed>
\`\`\`

**Why:** Brief explanation of what the change achieves.

RULES:
- NEVER guess code. ALWAYS use fs_read first. If line numbers in the plan are slightly off, find the correct ones.
- The "Before" block MUST be an EXACT copy-paste of the current file content. Do not paraphrase.
- The "After" block must show the minimal change — do not refactor surrounding code.
- If a plan step is vague, make a concrete implementation decision and explain why.
- If a file doesn't exist yet (new file), use "Before: (new file)" and show full content in After.
- If you run out of budget, output whatever spec sections you've completed so far.

LANGUAGE: Match the plan's language for explanations. Code stays in its original language.

When finished, call the report tool with the complete spec markdown.`;
  }

  private async runDelegatedResearchPacks(
    plan: TaskPlan,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    sharedBudget: SharedTokenBudget,
    totalBudget: number,
  ): Promise<string> {
    const packs = this.buildResearchPacks(plan);
    if (packs.length === 0) {
      return '';
    }

    const outputs: string[] = [];
    for (let i = 0; i < packs.length; i++) {
      const pack = packs[i]!;
      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId: plan.sessionId,
        data: {
          phase: 'spec',
          progress: Math.min(45, 12 + (i * 8)),
          message: `Delegated research ${i + 1}/${packs.length}: ${pack.title}`,
          ...this.buildBudgetSnapshot(sharedBudget, totalBudget),
        },
      });
      let reported = '';
      const subRunner = this.createSubRunner(
        {
          ...config,
          mode: undefined,
          maxIterations: 6,
          tokenBudget: {
            ...config.tokenBudget,
            enabled: true,
            maxTokens: sharedBudget.allocate(Math.floor(sharedBudget.remaining * 0.2), 5000),
            softLimitRatio: config.tokenBudget?.softLimitRatio ?? 0.75,
            hardLimitRatio: config.tokenBudget?.hardLimitRatio ?? 0.95,
            hardStop: config.tokenBudget?.hardStop ?? true,
            forceSynthesisOnHardLimit: config.tokenBudget?.forceSynthesisOnHardLimit ?? true,
            restrictBroadExplorationAtSoftLimit:
              config.tokenBudget?.restrictBroadExplorationAtSoftLimit ?? true,
            allowIterationBudgetExtension: false,
          },
          onEvent: (event: AgentEvent) => {
            if (event.type === 'tool:end' && event.data?.toolName === 'report') {
              const metadataAnswer = (event.data?.metadata as { answer?: unknown } | undefined)?.answer;
              const output = typeof event.data?.output === 'string' ? event.data.output : '';
              const answer = typeof metadataAnswer === 'string' ? metadataAnswer : '';
              const captured = answer.trim() || output.trim();
              if (captured) {
                reported = captured;
              }
            }
            config.onEvent?.(event);
          },
        },
        toolRegistry,
      );

      const budgetAwarePrompt = `${pack.prompt}\n\nCURRENT TOKEN BUDGET: ${sharedBudget.remaining}/${totalBudget} tokens remaining. Prioritize concrete file evidence.`;
      const result = await subRunner.execute(budgetAwarePrompt);
      sharedBudget.consume(result.tokensUsed);
      const text = (reported || result.summary || '').trim();
      if (text) {
        outputs.push(`### ${pack.title}\n${text.slice(0, 2500)}`);
      }
    }

    return outputs.join('\n\n');
  }

  private buildResearchPacks(plan: TaskPlan): DelegatedResearchPack[] {
    const packs: DelegatedResearchPack[] = [];
    const phaseChunks = this.chunkArray(plan.phases, Math.max(1, Math.ceil(plan.phases.length / 3)));
    for (let i = 0; i < phaseChunks.length && packs.length < 3; i++) {
      const chunk = phaseChunks[i]!;
      const stepHints = chunk
        .flatMap((phase) => phase.steps.slice(0, 4).map((step) => `- ${step.action}`))
        .slice(0, 12)
        .join('\n');
      packs.push({
        title: `Research Pack ${i + 1}`,
        prompt: [
          'Research only. Do not propose final spec.',
          'Analyze these plan steps and gather concrete implementation evidence:',
          stepHints || '- (no explicit step hints)',
          '',
          'Deliverables:',
          '- file paths and relevant line ranges',
          '- constraints/dependencies found in code',
          '- concrete implementation decisions and risks',
          '',
          'Return concise markdown bullets and call report tool.',
        ].join('\n'),
      });
    }
    return packs;
  }

  private chunkArray<T>(items: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {return [items];}
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks.length > 0 ? chunks : [items];
  }

  private collectUncoveredPlanSteps(plan: TaskPlan, markdown: string): string[] {
    const covered = new Set<string>();
    const refRegex = /^###\s+\[([^\]]+)\]/gm;
    let match: RegExpExecArray | null;
    while ((match = refRegex.exec(markdown)) !== null) {
      const ref = match[1] || '';
      if (ref.includes(':')) {covered.add(ref.trim());}
    }

    const missing: string[] = [];
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const ref = `${phase.id}:${step.id}`;
        if (!covered.has(ref)) {
          missing.push(`${ref} — ${step.action}`);
        }
      }
    }
    return missing;
  }

  private async tryRepairSpecWithCoverageGaps(input: {
    plan: TaskPlan;
    currentSpecMarkdown: string;
    uncoveredSteps: string[];
    baseConfig: AgentConfig;
    toolRegistry: ToolRegistry;
    tokenBudget: number;
    sharedBudget: SharedTokenBudget;
  }): Promise<string | null> {
    if (input.uncoveredSteps.length === 0) {
      return null;
    }

    let reported = '';
    const repairPrompt = [
      'SPEC REPAIR MODE.',
      'The current spec is incomplete. Fill ONLY missing steps.',
      '',
      'Current spec draft:',
      input.currentSpecMarkdown,
      '',
      'Missing plan steps to cover:',
      ...input.uncoveredSteps.slice(0, 25).map((step) => `- ${step}`),
      '',
      'Rules:',
      '- Read files before writing each missing step.',
      '- Output only additional sections in the same format.',
      '- Keep changes minimal and concrete.',
      `- Current token budget remaining: ${input.sharedBudget.remaining} tokens. Be concise.`,
      '- Use report tool with the repaired full spec markdown (updated entire document).',
    ].join('\n');

    const repairRunner = this.createSubRunner(
      {
        ...input.baseConfig,
        mode: undefined,
        maxIterations: 6,
        tokenBudget: {
          ...input.baseConfig.tokenBudget,
          enabled: true,
          maxTokens: input.sharedBudget.allocate(Math.max(8_000, Math.floor(input.tokenBudget * 0.9)), 5000),
          hardStop: true,
          forceSynthesisOnHardLimit: true,
          allowIterationBudgetExtension: false,
        },
        onEvent: (event: AgentEvent) => {
          if (event.type === 'tool:end' && event.data?.toolName === 'report') {
            const metadataAnswer = (event.data?.metadata as { answer?: unknown } | undefined)?.answer;
            const output = typeof event.data?.output === 'string' ? event.data.output : '';
            const answer = typeof metadataAnswer === 'string' ? metadataAnswer : '';
            const captured = answer.trim() || output.trim();
            if (captured) {
              reported = captured;
            }
          }
          input.baseConfig.onEvent?.(event);
        },
      },
      input.toolRegistry,
    );

    const result = await repairRunner.execute(repairPrompt);
    input.sharedBudget.consume(result.tokensUsed);
    const merged = (reported || result.summary || '').trim();
    return merged.length > 0 ? merged : null;
  }

  private resolveSpecBudgetPolicy(planConfig: AgentConfig, plan: TaskPlan): {
    maxTokens: number;
    synthesisReserveRatio: number;
    partialOnFailure: boolean;
  } {
    const defaults = DEFAULT_AGENT_TOKEN_BUDGET_CONFIG.spec ?? {};
    const defaultMultiplier = defaults.multiplier ?? 4.0;
    const defaultFloorTokens = defaults.floorTokens ?? 100_000;
    const defaultCeilingTokens = defaults.ceilingTokens ?? 250_000;
    const defaultSynthesisReserveRatio = defaults.synthesisReserveRatio ?? 0.2;
    const defaultPartialOnFailure = defaults.partialOnFailure ?? true;
    const defaultEnabled = defaults.enabled ?? true;
    const policy = planConfig.tokenBudget?.spec;
    const enabled = policy?.enabled ?? defaultEnabled;
    const estimatedPlanTokens = this.estimatePlanTokens(plan);

    if (!enabled) {
      return {
        maxTokens: Math.max(20_000, estimatedPlanTokens * 2),
        synthesisReserveRatio: defaultSynthesisReserveRatio,
        partialOnFailure: defaultPartialOnFailure,
      };
    }

    const multiplier = this.clampNumber(policy?.multiplier, defaultMultiplier, 1.5, 8);
    const floorTokens = this.clampInt(policy?.floorTokens, defaultFloorTokens, 20_000, 1_000_000);
    const ceilingTokens = this.clampInt(policy?.ceilingTokens, defaultCeilingTokens, floorTokens, 2_000_000);
    const synthesisReserveRatio = this.clampNumber(
      policy?.synthesisReserveRatio,
      defaultSynthesisReserveRatio,
      0.1,
      0.5,
    );
    const computedBudget = Math.round(estimatedPlanTokens * multiplier);
    const maxTokens = Math.max(floorTokens, Math.min(ceilingTokens, computedBudget));

    return {
      maxTokens,
      synthesisReserveRatio,
      partialOnFailure: policy?.partialOnFailure ?? defaultPartialOnFailure,
    };
  }

  private resolveSpecIterations(plan: TaskPlan, maxTokens: number): number {
    const phaseDriven = Math.max(20, plan.phases.length * 10);
    const tokenDriven = Math.ceil(maxTokens / 3000);
    return Math.max(20, Math.min(180, Math.max(phaseDriven, tokenDriven)));
  }

  private estimatePlanTokens(plan: TaskPlan): number {
    const markdown = (plan.markdown || '').trim();
    if (markdown.length > 0) {
      return Math.max(1_000, Math.ceil(markdown.length / 4));
    }

    const stepCount = plan.phases.reduce((sum, phase) => sum + phase.steps.length, 0);
    const roughChars = (plan.task.length * 8) + (plan.phases.length * 1200) + (stepCount * 900);
    return Math.max(1_000, Math.ceil(roughChars / 4));
  }

  private clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, value));
  }

  private clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    const next = this.clampNumber(value, fallback, min, max);
    return Math.floor(next);
  }

  private buildFallbackPartialSpec(plan: TaskPlan, filesRead: string[], tokenBudget: number): string {
    const uniqueFiles = Array.from(new Set(filesRead.filter(Boolean))).slice(0, 40);
    const fileLines = uniqueFiles.length > 0
      ? uniqueFiles.map((file) => `- \`${file}\``).join('\n')
      : '- (no explicit file reads captured)';
    const phaseLines = plan.phases.map((phase, idx) => `- ${idx + 1}. ${phase.name} (\`${phase.id}\`)`).join('\n');

    return [
      `# Spec (Partial): ${plan.task}`,
      '',
      '## Table of Contents',
      '- [Task](#task)',
      '- [Coverage](#coverage)',
      '- [Observed Files](#observed-files)',
      '- [Next Pass](#next-pass)',
      '',
      '## Task',
      `Plan ID: \`${plan.id}\``,
      `Budget exhausted before complete synthesis (~${tokenBudget} tokens target).`,
      '',
      '## Coverage',
      'Phases from plan:',
      phaseLines,
      '',
      'Current status: partial draft. Continue spec generation to fill exact before/after blocks per phase.',
      '',
      '## Observed Files',
      fileLines,
      '',
      '## Next Pass',
      '- Resume from first uncovered phase and produce concrete before/after code blocks.',
      '- Prioritize high-impact phases first.',
      '- Keep changes minimal and file-scoped.',
    ].join('\n');
  }

  private planToMarkdownFallback(plan: TaskPlan): string {
    const lines: string[] = [`# ${plan.task}`, ''];
    for (const phase of plan.phases) {
      lines.push(`## ${phase.name}`);
      lines.push(phase.description);
      for (const step of phase.steps) {
        lines.push(`- ${step.action}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Parse spec markdown into SpecSection[]
  // -------------------------------------------------------------------------

  parseSpecSections(markdown: string, plan: TaskPlan): SpecSection[] {
    const text = (markdown || '').trim();
    if (!text) {return [];}

    const sections: SpecSection[] = [];
    // Match ### [phase-id:step-id] or ### [phase-id] headers
    const headerRe = /^###\s+\[([^\]]+)\]\s*(.*)/gm;
    const matches: Array<{ index: number; phaseId: string; stepId?: string; title: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(text)) !== null) {
      const ref = match[1] ?? '';
      const title = match[2]?.trim() || '';
      const parts = ref.split(':');
      matches.push({
        index: match.index,
        phaseId: parts[0] ?? ref,
        stepId: parts[1],
        title,
      });
    }

    if (matches.length === 0) {return [];}

    // Group changes by planPhaseId
    const phaseMap = new Map<string, SpecSection>();

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const nextIdx = matches[i + 1]?.index ?? text.length;
      const block = text.slice(m.index, nextIdx);

      const change = this.parseChangeBlock(block);
      if (!change) {continue;}

      let section = phaseMap.get(m.phaseId);
      if (!section) {
        const planPhase = plan.phases.find((p) => p.id === m.phaseId);
        section = {
          planPhaseId: m.phaseId,
          title: planPhase?.name || m.title || m.phaseId,
          description: planPhase?.description || '',
          changes: [],
        };
        phaseMap.set(m.phaseId, section);
      }

      section.changes.push(change);
    }

    sections.push(...phaseMap.values());
    return sections;
  }

  private parseChangeBlock(block: string): SpecChange | null {
    // Extract file path
    const fileMatch = /\*\*File:\*\*\s*`([^`]+)`/.exec(block);
    if (!fileMatch?.[1]) {return null;}
    const file = fileMatch[1];

    // Extract line range
    const lineMatch = /\*\*Lines?:\*\*\s*(\d[\d\s,\-–]+)/.exec(block);
    const lineRange = lineMatch?.[1]?.trim() || '';

    // Extract before/after code blocks
    const codeBlocks = [...block.matchAll(/```[\w]*\n([\s\S]*?)```/g)];
    const beforeContent = codeBlocks[0]?.[1]?.trimEnd() || '';
    const afterContent = codeBlocks[1]?.[1]?.trimEnd() || '';

    // Extract explanation
    const whyMatch = /\*\*Why:\*\*\s*(.+)/i.exec(block);
    const explanation = whyMatch?.[1]?.trim() || '';

    return {
      file,
      lineRange,
      before: beforeContent,
      after: afterContent,
      explanation,
    };
  }

  // -------------------------------------------------------------------------
  // SDK runner factory
  // -------------------------------------------------------------------------

  private createSubRunner(config: AgentConfig, toolRegistry: ToolRegistry): IAgentRunner {
    return new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
  }

  // -------------------------------------------------------------------------
  // Event emitter helper
  // -------------------------------------------------------------------------

  private emit(config: AgentConfig, event: AgentEvent): void {
    if (!config.onEvent) {return;}
    config.onEvent({
      ...event,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
    });
  }

  private buildBudgetSnapshot(sharedBudget: SharedTokenBudget, totalBudget: number): {
    budgetUsedTokens: number;
    budgetRemainingTokens: number;
    budgetTotalTokens: number;
  } {
    return {
      budgetUsedTokens: sharedBudget.used,
      budgetRemainingTokens: sharedBudget.remaining,
      budgetTotalTokens: totalBudget,
    };
  }
}
