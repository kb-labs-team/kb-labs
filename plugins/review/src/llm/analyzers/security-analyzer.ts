/**
 * @module @kb-labs/review/llm/analyzers/security-analyzer
 * Security vulnerability analyzer using LLM with tool calling
 */

import type { ReviewFinding, ParsedFile, ReviewContext } from '../../contracts/index.js';
import { BaseLLMAnalyzer } from '../../contracts/index.js';
import { useLLM, useCache, useAnalytics, useLogger } from '@kb-labs/sdk';
import * as securityPrompts from '../prompts/security.prompts.js';

/**
 * Tool schema for security findings (structured output)
 */
const SECURITY_FINDING_TOOL = {
  name: 'report_security_finding',
  description: 'Report a security vulnerability or weakness',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['blocker', 'high', 'medium', 'low'],
        description: 'Severity level (blocker=exploitable, high=serious weakness)',
      },
      vulnerabilityType: {
        type: 'string',
        description: 'Type of vulnerability (e.g., SQL injection, XSS, CSRF)',
      },
      message: {
        type: 'string',
        description: 'Clear description of the security issue',
      },
      line: {
        type: 'number',
        description: 'Line number where vulnerability occurs',
      },
      mitigation: {
        type: 'string',
        description: 'Concrete mitigation steps with code example',
      },
      impact: {
        type: 'string',
        description: 'Potential impact if exploited',
      },
    },
    required: ['severity', 'vulnerabilityType', 'message', 'line', 'mitigation', 'impact'],
  },
} as const;

/** Valid severity values */
const VALID_SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const;
type ValidSeverity = (typeof VALID_SEVERITIES)[number];

/** Retry configuration */
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

/** Batch size for parallel file processing */
const BATCH_SIZE = 5;

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Security analyzer
 * Uses LLM with tool calling for structured findings
 */
export class SecurityAnalyzer extends BaseLLMAnalyzer {
  readonly id = 'security';
  readonly name = 'Security Analysis';

  /** Track failed files for reporting */
  private failedFiles: Array<{ file: string; error: string }> = [];

  async analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];
    const cache = useCache();
    this.failedFiles = [];

    // Separate cached files from files needing analysis
    const filesToAnalyze: ParsedFile[] = [];

    for (const file of files) {
      const cacheKey = this.generateCacheKey(file, context.preset);

      if (cache) {
        // eslint-disable-next-line no-await-in-loop -- Sequential cache check before batching
        const cached = await cache.get<ReviewFinding[]>(cacheKey);
        if (cached) {
          findings.push(...cached);
          continue;
        }
      }

      filesToAnalyze.push(file);
    }

    // Process files in batches for controlled parallelism
    for (let i = 0; i < filesToAnalyze.length; i += BATCH_SIZE) {
      const batch = filesToAnalyze.slice(i, i + BATCH_SIZE);

      // Process batch in parallel
      // eslint-disable-next-line no-await-in-loop -- Intentional batching to limit concurrency
      const batchResults = await Promise.allSettled(
        batch.map(file => this.analyzeFile(file, context, cache))
      );

      // Collect results
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j]!;
        const file = batch[j]!;

        if (result.status === 'fulfilled') {
          findings.push(...result.value);
        } else {
          this.failedFiles.push({ file: file.path, error: result.reason?.message ?? 'Unknown error' });
        }
      }
    }

    // Log summary of failures if any
    if (this.failedFiles.length > 0) {
      useLogger()?.debug(`[SecurityAnalyzer] Failed to analyze ${this.failedFiles.length} file(s):`, {
        files: this.failedFiles,
      });
    }

    return findings;
  }

  /**
   * Analyze a single file with retry logic
   */
  private async analyzeFile(
    file: ParsedFile,
    context: ReviewContext,
    cache: ReturnType<typeof useCache>
  ): Promise<ReviewFinding[]> {
    const analytics = useAnalytics();
    const systemPrompt = securityPrompts.buildSystemPrompt(context);
    const userPrompt = securityPrompts.analyzeFile(file);

    const llm = useLLM({ tier: 'medium' });
    if (!llm?.chatWithTools) {
      throw new Error('LLM not configured or does not support tool calling');
    }

    // Retry with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Retry loop requires sequential attempts
        const response = await llm.chatWithTools(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          {
            tools: [SECURITY_FINDING_TOOL],
            temperature: 0.1,
          }
        );

        // Track analytics
        if (analytics) {
          // eslint-disable-next-line no-await-in-loop -- Analytics tracking in retry loop
          await analytics.track('review.security.complete', {
            file: file.path,
            tokensUsed: response.usage.promptTokens + response.usage.completionTokens,
            toolCalls: response.toolCalls?.length ?? 0,
            attempts: attempt,
          });
        }

        // Process tool calls
        const fileFindings = this.processToolCalls(response.toolCalls || [], file);

        // Cache results (24 hours)
        if (cache) {
          const cacheKey = this.generateCacheKey(file, context.preset);
          // eslint-disable-next-line no-await-in-loop -- Cache storage in retry loop
          await cache.set(cacheKey, fileFindings, 86400000);
        }

        return fileFindings;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        useLogger()?.debug(`[SecurityAnalyzer] Attempt ${attempt}/${MAX_RETRIES} failed for ${file.path}:`, { error });

        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
          // eslint-disable-next-line no-await-in-loop -- Intentional delay between retry attempts
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Analysis failed');
  }

  /**
   * Get list of files that failed analysis
   */
  getFailedFiles(): Array<{ file: string; error: string }> {
    return [...this.failedFiles];
  }

  /**
   * Process LLM tool calls into ReviewFindings
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Complex validation and mapping of LLM tool call results to structured findings
  private processToolCalls(toolCalls: { name: string; input: unknown }[], file: ParsedFile): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const call of toolCalls) {
      if (call.name === 'report_security_finding') {

        const args = call.input as Record<string, unknown>;

        // Validate line number
        const lineCount = file.content.split('\n').length;
        const line = typeof args.line === 'number' ? args.line : parseInt(String(args.line), 10);
        if (isNaN(line) || line < 1 || line > lineCount) {
          useLogger()?.debug(`[SecurityAnalyzer] Invalid line number ${args.line} for ${file.path}`);
          continue;
        }

        // Validate severity (reject invalid values instead of normalizing)
        const severity = args.severity as string;
        if (!VALID_SEVERITIES.includes(severity as ValidSeverity)) {
          useLogger()?.debug(`[SecurityAnalyzer] Invalid severity "${severity}" for finding in ${file.path}:${line}`);
          continue;
        }

        // Sanitize vulnerability type (alphanumeric, dash, underscore only)
        const vulnerabilityType = String(args.vulnerabilityType || 'unknown')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 50);

        findings.push({
          id: this.buildFindingId(file, line, 'sec'),
          ruleId: `llm:security:${vulnerabilityType}`,
          type: 'security',
          severity: severity as ValidSeverity,
          confidence: 'likely', // LLM findings are "likely", not "certain"

          file: file.path,
          line,

          message: `[${vulnerabilityType}] ${String(args.message || '').slice(0, 500)}`,
          suggestion: args.mitigation ? String(args.mitigation).slice(0, 1000) : undefined,
          rationale: args.impact ? `Impact: ${String(args.impact).slice(0, 500)}` : undefined,

          engine: 'llm',
          source: 'llm-security',

          // For agent mode gating
          scope: 'local',
          automated: false, // Security fixes need human review
        });
      }
    }

    return findings;
  }
}
