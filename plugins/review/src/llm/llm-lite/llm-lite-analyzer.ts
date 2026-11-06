/**
 * @module @kb-labs/review/llm/llm-lite/llm-lite-analyzer
 * LLM-Lite analyzer for efficient code review.
 *
 * Uses batch tools, diff-based context, and anti-hallucination verification.
 */

import type { ReviewFinding, InputFile, IDiffProvider, ReviewConfig } from '../../contracts/index.js';
import { useLLM, useAnalytics, useConfig } from '@kb-labs/sdk';
import {
  createToolExecutor,
  buildToolDefinitions,
  type RawFinding,
  type ToolCall,
} from './tool-executor.js';
import { createVerificationEngine, type VerificationResult } from './verification.js';
import { getCategoryValidator } from './category-validator.js';
import { loadPrompts, type LoadedPrompts } from './prompt-loader.js';

/**
 * Review LLM config from kb.config.json
 */
type ReviewLLMConfig = NonNullable<ReviewConfig['llm']>;

/**
 * LLM-Lite review request
 */
export interface LLMLiteRequest {
  /** Working directory */
  cwd: string;
  /** Changed files with content */
  files: InputFile[];
  /** Task context (what the changes are trying to achieve) */
  taskContext?: string;
  /** Repository scope */
  repoScope?: string[];
  /** Diff provider (injected from review-core to avoid circular dependency) */
  diffProvider: IDiffProvider;
}

/**
 * LLM-Lite review result
 */
export interface LLMLiteResult {
  /** Verified findings */
  findings: ReviewFinding[];
  /** Metadata */
  metadata: {
    /** LLM calls made */
    llmCalls: number;
    /** Tool calls made */
    toolCalls: {
      get_diffs: number;
      get_file_chunks: number;
      report_findings: number;
    };
    /** Token usage */
    tokens: {
      input: number;
      output: number;
      total: number;
    };
    /** Estimated cost in USD */
    estimatedCost: number;
    /** Verification stats */
    verification: {
      rawFindings: number;
      verified: number;
      downgraded: number;
      discarded: number;
      hallucinationRate: number;
    };
    /** Timing */
    timing: {
      totalMs: number;
      llmMs: number;
      verifyMs: number;
    };
  };
}

/**
 * File summary for initial prompt
 */
interface FileSummary {
  path: string;
  additions: number;
  deletions: number;
  isNewFile: boolean;
}

/**
 * Default turn limits (can be overridden via kb.config.json)
 */
const DEFAULT_MIN_TURNS = 3;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_FILES_PER_TURN = 10;
const DEFAULT_LINES_PER_TURN = 500;

/**
 * Calculate adaptive turn limit based on workload
 *
 * Formula:
 * - Base: minTurns (get_diffs + analyze + report)
 * - +1 turn per filesPerTurn files (more files = more get_diffs calls needed)
 * - +1 turn per linesPerTurn lines changed (more changes = more context needed)
 * - Capped at maxTurns (cost control)
 *
 * All parameters configurable via kb.config.json review.llm section
 */
function calculateMaxTurns(
  fileCount: number,
  totalChangedLines: number,
  config?: ReviewLLMConfig
): number {
  const minTurns = config?.minTurns ?? DEFAULT_MIN_TURNS;
  const maxTurns = config?.maxTurns ?? DEFAULT_MAX_TURNS;
  const filesPerTurn = config?.filesPerTurn ?? DEFAULT_FILES_PER_TURN;
  const linesPerTurn = config?.linesPerTurn ?? DEFAULT_LINES_PER_TURN;

  const baseTurns = minTurns;
  const turnsForFiles = Math.ceil(fileCount / filesPerTurn);
  const turnsForLines = Math.ceil(totalChangedLines / linesPerTurn);
  return Math.min(maxTurns, baseTurns + turnsForFiles + turnsForLines);
}

/**
 * Token costs (GPT-4 pricing approximation)
 */
const TOKEN_COSTS = {
  input: 0.00003, // $0.03 per 1K input tokens
  output: 0.00006, // $0.06 per 1K output tokens
};

/**
 * LLM-Lite Analyzer
 *
 * Efficient code review using:
 * - Batch tools (get_diffs, get_file_chunks, report_findings)
 * - Diff-based context (not full files)
 * - Anti-hallucination verification
 * - Dynamic categories from rules directory
 */
export class LLMLiteAnalyzer {
  private cwd: string;
  private files: InputFile[];
  private taskContext?: string;
  private repoScope?: string[];
  private diffProvider: IDiffProvider;

  constructor(request: LLMLiteRequest) {
    this.cwd = request.cwd;
    this.files = request.files;
    this.taskContext = request.taskContext;
    this.repoScope = request.repoScope;
    this.diffProvider = request.diffProvider;
  }

  /**
   * Run LLM-Lite analysis
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Complex multi-phase LLM analysis workflow with prompt loading, validation, and result processing
  async analyze(): Promise<LLMLiteResult> {
    const startTime = Date.now();
    const analytics = useAnalytics();

    // Track start
    analytics?.track('review:llm-lite:started', {
      fileCount: this.files.length,
      hasTaskContext: !!this.taskContext,
    });

    // Initialize
    const llm = useLLM({ tier: 'medium' });
    if (!llm) {
      throw new Error('LLM not available for llm-lite mode');
    }

    // Get review config from kb.config.json
    const reviewConfig = await useConfig<ReviewConfig>('review');
    const llmConfig = reviewConfig?.llm;

    // Load prompts and rules from .kb/review/
    const prompts = await loadPrompts(this.cwd);

    // Get category validator
    const categoryValidator = await getCategoryValidator(this.cwd);
    const validCategories = categoryValidator.getValidCategories();
    const categoryAliases = categoryValidator.getCategoryAliases();

    // Build file summaries for initial prompt
    const fileSummaries = this.buildFileSummaries();

    // Calculate adaptive turn limit based on workload and config
    const totalChangedLines = fileSummaries.reduce(
      (sum, f) => sum + f.additions + f.deletions,
      0
    );
    const maxTurns = calculateMaxTurns(this.files.length, totalChangedLines, llmConfig);

    // Create tool executor
    const changedFiles = this.files.map(f => f.path);
    const toolExecutor = createToolExecutor(this.cwd, changedFiles, this.diffProvider);

    // Build tools with dynamic categories and rule IDs
    const validRuleIds = Array.from(prompts.ruleIds);
    const tools = buildToolDefinitions(validCategories, validRuleIds);

    // Build prompts with loaded rules
    const systemPrompt = this.buildSystemPrompt(validCategories, prompts);
    const initialPrompt = this.buildInitialPrompt(fileSummaries, prompts);

    // Conversation loop
    // Messages array uses 'user' for initial prompt and tool results, 'assistant' for LLM responses.
    // Tool results are sent as 'user' messages to avoid Anthropic tool_use/tool_result format issues.
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: initialPrompt },
    ];

    let llmCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmTimeMs = 0;
    let rawFindings: RawFinding[] = [];

    const toolCallCounts = {
      get_diffs: 0,
      get_file_chunks: 0,
      report_findings: 0,
    };

    // Tool calling loop (adaptive based on workload)
    for (let turn = 0; turn < maxTurns; turn++) {
      const llmStart = Date.now();
      const isLastTurn = turn === maxTurns - 1;

      // On last turn, only offer report_findings to force conclusion
      const availableTools = isLastTurn
        ? tools.filter(t => t.name === 'report_findings')
        : tools;

      // Call LLM with tools
      // eslint-disable-next-line no-await-in-loop -- Conversation loop requires sequential turns
      const response = await llm.chatWithTools!(
        [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        {
          tools: availableTools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        }
      );

      llmCalls++;
      llmTimeMs += Date.now() - llmStart;

      // Track token usage (if available)
      // Note: Some adapters may not provide usage data, cost estimation will be incomplete
      if (response.usage) {
        totalInputTokens += response.usage.promptTokens ?? 0;
        totalOutputTokens += response.usage.completionTokens ?? 0;
      }

      // Check for tool calls
      const toolCalls = response.toolCalls ?? [];

      if (toolCalls.length === 0) {
        // No more tool calls - done
        break;
      }

      // Add assistant message only if there's actual content
      // Skip empty content even with tool calls - VibeProxy requires non-empty content
      const assistantContent = response.content ?? '';
      if (assistantContent.trim()) {
        messages.push({
          role: 'assistant',
          content: assistantContent,
        });
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        const parsed: ToolCall = {
          name: toolCall.name,
          arguments: toolCall.input as Record<string, unknown>,
        };

        // Track tool call count
        if (parsed.name in toolCallCounts) {
          toolCallCounts[parsed.name as keyof typeof toolCallCounts]++;
        }

        // Execute
        // eslint-disable-next-line no-await-in-loop -- Sequential tool execution for conversation flow
        const result = await toolExecutor.execute(parsed);

        // Add tool result to messages
        // Using 'user' role with formatted text to avoid Anthropic tool_use/tool_result format issues
        // This is the same approach used by agent-executor
        messages.push({
          role: 'user',
          content: `Tool result (${parsed.name}):\n${JSON.stringify(result.result, null, 2)}`,
        });

        // Check for report_findings (end condition)
        if (parsed.name === 'report_findings' && result.result) {
          const reportResult = result.result as { findings?: RawFinding[] };
          if (reportResult.findings) {
            rawFindings = reportResult.findings;
          }
        }
      }

      // If report_findings was called, we're done (regardless of findings count)
      if (toolCallCounts.report_findings > 0) {
        break;
      }
    }

    // Verification phase
    const verifyStart = Date.now();

    const verificationEngine = createVerificationEngine(
      this.cwd,
      changedFiles,
      toolExecutor.getFetchedDiffs(),
      validCategories,
      categoryAliases,
      prompts.ruleIds
    );

    const verificationResult = await verificationEngine.verify(rawFindings);
    const verifyTimeMs = Date.now() - verifyStart;

    // Convert to ReviewFinding format
    const findings = this.convertToReviewFindings(verificationResult);

    // Calculate cost
    const estimatedCost =
      (totalInputTokens * TOKEN_COSTS.input) +
      (totalOutputTokens * TOKEN_COSTS.output);

    // Track completion
    analytics?.track('review:llm-lite:completed', {
      fileCount: this.files.length,
      findingsCount: findings.length,
      llmCalls,
      hallucinationRate: verificationResult.stats.hallucinationRate,
      estimatedCost,
    });

    return {
      findings,
      metadata: {
        llmCalls,
        toolCalls: toolCallCounts,
        tokens: {
          input: totalInputTokens,
          output: totalOutputTokens,
          total: totalInputTokens + totalOutputTokens,
        },
        estimatedCost,
        verification: {
          rawFindings: verificationResult.stats.total,
          verified: verificationResult.verified.length,
          downgraded: verificationResult.stats.downgraded,
          discarded: verificationResult.stats.discarded,
          hallucinationRate: verificationResult.stats.hallucinationRate,
        },
        timing: {
          totalMs: Date.now() - startTime,
          llmMs: llmTimeMs,
          verifyMs: verifyTimeMs,
        },
      },
    };
  }

  /**
   * Build file summaries for initial prompt
   */
  private buildFileSummaries(): FileSummary[] {
    return this.files.map(f => {
      const lines = f.content.split('\n');
      return {
        path: f.path,
        additions: lines.length,
        deletions: 0,
        isNewFile: f.isNewFile ?? false,
      };
    });
  }

  /**
   * Build system prompt from loaded prompts and rules
   */
  private buildSystemPrompt(validCategories: string[], prompts: LoadedPrompts): string {
    const categoryList = validCategories.length > 0
      ? `\n\n## Valid Categories\n\nYou MUST use only these categories:\n${validCategories.map(c => `- ${c}`).join('\n')}`
      : '';

    // Combine: system prompt + rules context + categories
    let fullPrompt = prompts.system;

    // Add project-specific rules if any
    if (prompts.rulesContext) {
      fullPrompt += `\n\n${prompts.rulesContext}`;
    }

    // Add valid categories
    fullPrompt += categoryList;

    return fullPrompt;
  }

  /**
   * Build initial prompt with file list and task context
   */
  private buildInitialPrompt(files: FileSummary[], prompts: LoadedPrompts): string {
    const fileList = files.map(f => {
      const stats = `+${f.additions}/-${f.deletions}`;
      const status = f.isNewFile ? 'new file' : 'modified';
      return `- ${f.path} (${stats}, ${status})`;
    }).join('\n');

    let prompt = `## Files Changed (${files.length} files)

${fileList}`;

    if (this.taskContext) {
      prompt += `\n\n## Task Context\n${this.taskContext}`;
    }

    if (this.repoScope?.length) {
      prompt += `\n\n## Repository Scope\n${this.repoScope.join(', ')}`;
    }

    // Add task prompt from loaded prompts
    prompt += `\n\n${prompts.task}`;

    return prompt;
  }

  /**
   * Convert verified findings to ReviewFinding format
   */
  private convertToReviewFindings(result: VerificationResult): ReviewFinding[] {
    return result.verified.map(v => {
      // Map verification action to confidence level
      const confidence = v.action === 'keep' ? 'certain' as const
        : v.action === 'downgrade' ? 'likely' as const
        : 'heuristic' as const;

      // Determine ruleId: use LLM-provided ruleId if valid, otherwise generate from category
      // ruleId from LLM means it matched a project rule (e.g., "security/no-eval")
      // null/undefined means ad-hoc finding (LLM found it without matching a rule)
      let projectRuleId = v.finding.ruleId;

      // LLM sometimes includes "rule:" prefix - strip it if present
      if (projectRuleId?.startsWith('rule:')) {
        projectRuleId = projectRuleId.slice(5);
      }

      const ruleId = projectRuleId
        ? `rule:${projectRuleId}`  // Matched project rule
        : `llm-lite:${v.finding.category}`;  // Ad-hoc LLM finding

      // Source indicates whether finding came from a project rule or LLM's own analysis
      const source = projectRuleId ? 'rule' : 'llm';

      return {
        id: `llm-lite-${v.finding.file}-${v.finding.line}`,
        ruleId,
        file: v.finding.file,
        line: v.finding.line,
        endLine: v.finding.endLine,
        column: 1,
        message: v.finding.message,
        severity: v.finding.severity as 'blocker' | 'high' | 'medium' | 'low' | 'info',
        confidence,
        type: v.finding.category,
        engine: 'llm-lite',
        source,
        suggestion: v.finding.suggestion,
        snippet: v.finding.codeSnippet,
      };
    });
  }
}

/**
 * Run LLM-Lite analysis
 */
export async function runLLMLiteAnalysis(request: LLMLiteRequest): Promise<LLMLiteResult> {
  const analyzer = new LLMLiteAnalyzer(request);
  return analyzer.analyze();
}
