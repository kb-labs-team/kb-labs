/**
 * @module @kb-labs/review/llm/analyzers/architecture-analyzer
 * Architecture patterns analyzer using LLM with tool calling
 */

import type { ReviewFinding, ParsedFile, ReviewContext } from '../../contracts/index.js';
import { BaseLLMAnalyzer } from '../../contracts/index.js';
import { useLLM, useCache, useAnalytics, useLogger } from '@kb-labs/sdk';

type ToolCall = { name: string; input: unknown };
import * as architecturePrompts from '../prompts/architecture.prompts.js';

/**
 * Tool schema for architecture findings (structured output)
 */
const ARCHITECTURE_FINDING_TOOL = {
  name: 'report_architecture_finding',
  description: 'Report an architecture issue or suggestion',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info'],
        description: 'Severity level of the finding',
      },
      message: {
        type: 'string',
        description: 'Clear description of the architecture issue',
      },
      line: {
        type: 'number',
        description: 'Line number where issue occurs (must exist in file)',
      },
      suggestion: {
        type: 'string',
        description: 'Concrete fix suggestion with code example',
      },
      rationale: {
        type: 'string',
        description: 'Why this is an issue (reference conventions/ADRs if applicable)',
      },
    },
    required: ['severity', 'message', 'line', 'suggestion', 'rationale'],
  },
} as const;

/**
 * Valid severity values for ReviewFinding.
 * Maps to ReviewFinding['severity'] from @kb-labs/review/contracts.
 */
const _VALID_SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'] as const;
type ValidSeverity = (typeof _VALID_SEVERITIES)[number];

/**
 * Map LLM severity output to internal ReviewFinding severity.
 * LLM uses tool schema with enum ['error', 'warning', 'info'],
 * but internal findings use ['blocker', 'high', 'medium', 'low', 'info'].
 */
function mapSeverity(llmSeverity: string): ValidSeverity {
  switch (llmSeverity) {
    case 'error': return 'high';
    case 'warning': return 'medium';
    case 'info': return 'info';
    default: return 'medium';
  }
}

/**
 * Architecture analyzer
 * Uses LLM with tool calling for structured findings
 */
export class ArchitectureAnalyzer extends BaseLLMAnalyzer {
  readonly id = 'architecture';
  readonly name = 'Architecture Analysis';

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Complex LLM-based analysis with caching, error handling, and result validation
  async analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];
    const cache = useCache();
    const analytics = useAnalytics();

    for (const file of files) {
      // Check cache first (content-hash based)
      const cacheKey = this.generateCacheKey(file, context.preset);

      if (cache) {
        // eslint-disable-next-line no-await-in-loop -- Sequential file analysis with caching
        const cached = await cache.get<ReviewFinding[]>(cacheKey);
        if (cached) {
          findings.push(...cached);
          continue;
        }
      }

      // Build prompts with context
      const systemPrompt = architecturePrompts.buildSystemPrompt(context);
      const userPrompt = architecturePrompts.analyzeFile(file);

      // Use LLM with tool calling (structured output - better than text parsing!)
      const llm = useLLM({ tier: 'medium' }); // Architecture needs good reasoning
      if (!llm?.chatWithTools) {
        throw new Error('LLM not configured or does not support tool calling');
      }

      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential LLM calls per file (rate limiting)
        const response = await llm.chatWithTools(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          {
            tools: [ARCHITECTURE_FINDING_TOOL],
            temperature: 0.2, // Low temp for consistency
          }
        );

        // Validate response structure
        if (!response || typeof response !== 'object') {
          useLogger()?.debug(`[ArchitectureAnalyzer] Invalid response from LLM for ${file.path}`);
          continue;
        }

        // Track analytics (useful for monitoring)
        if (analytics && response.usage) {
          // eslint-disable-next-line no-await-in-loop -- Analytics tracking after each file
          await analytics.track('review.architecture.complete', {
            file: file.path,
            tokensUsed: (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0),
            toolCalls: response.toolCalls?.length ?? 0,
          });
        }

        // Process tool calls into findings (structured, no parsing!)
        const fileFindings = this.processToolCalls(response.toolCalls || [], file);
        findings.push(...fileFindings);

        // Cache results (24 hours)
        if (cache) {
          // eslint-disable-next-line no-await-in-loop -- Cache storage after analysis
          await cache.set(cacheKey, fileFindings, 86400000);
        }
      } catch (error) {
        // Log detailed error information for debugging
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'UnknownError';

        useLogger()?.debug(`[ArchitectureAnalyzer] Failed to analyze ${file.path}:`, {
          error,
          errorName,
          errorMessage,
        });
        continue;
      }
    }

    return findings;
  }

  /**
   * Process LLM tool calls into ReviewFindings
   */
   
  private processToolCalls(toolCalls: ToolCall[], file: ParsedFile): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const call of toolCalls) {
      if (call.name === 'report_architecture_finding') {
         
        const args = call.input as Record<string, unknown>;

        // Validate line number
        const lineCount = file.content.split('\n').length;
        const line = typeof args.line === 'number' ? args.line : parseInt(String(args.line), 10);
        if (isNaN(line) || line < 1 || line > lineCount) {
          useLogger()?.debug(`[ArchitectureAnalyzer] Invalid line number ${args.line} for ${file.path}`);
          continue;
        }

        // Map and validate severity
        const severity = mapSeverity(String(args.severity || 'warning'));

        findings.push({
          id: this.buildFindingId(file, line, 'arch'),
          ruleId: 'llm:architecture',
          type: 'architecture',
          severity,
          confidence: 'likely', // LLM findings are "likely", not "certain"

          file: file.path,
          line,

          message: String(args.message || '').slice(0, 500),
          suggestion: args.suggestion ? String(args.suggestion).slice(0, 1000) : undefined,
          rationale: args.rationale ? String(args.rationale).slice(0, 500) : undefined,

          engine: 'llm',
          source: 'llm-architecture',

          // For agent mode gating
          scope: 'local', // Architecture can be local or global
          automated: false, // LLM suggestions need human review
        });
      }
    }

    return findings;
  }
}
