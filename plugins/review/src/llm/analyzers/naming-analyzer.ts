/**
 * @module @kb-labs/review/llm/analyzers/naming-analyzer
 * Naming conventions analyzer using LLM with tool calling
 */

import type { ReviewFinding, ParsedFile, ReviewContext } from '../../contracts/index.js';
import { BaseLLMAnalyzer } from '../../contracts/index.js';
import { useLLM, useCache, useAnalytics, useLogger } from '@kb-labs/sdk';
import * as namingPrompts from '../prompts/naming.prompts.js';

/**
 * Tool schema for naming findings (structured output)
 */
const NAMING_FINDING_TOOL = {
  name: 'report_naming_finding',
  description: 'Report a naming convention issue',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['warning', 'info'],
        description: 'Severity level (naming issues are typically warning/info)',
      },
      currentName: {
        type: 'string',
        description: 'Current name that violates conventions',
      },
      suggestedName: {
        type: 'string',
        description: 'Suggested better name',
      },
      message: {
        type: 'string',
        description: 'Description of the naming issue',
      },
      line: {
        type: 'number',
        description: 'Line number where name appears',
      },
      rationale: {
        type: 'string',
        description: 'Why the current name is problematic',
      },
    },
    required: ['severity', 'currentName', 'suggestedName', 'message', 'line', 'rationale'],
  },
} as const;

/**
 * Naming analyzer
 * Uses LLM with tool calling for structured findings
 */
export class NamingAnalyzer extends BaseLLMAnalyzer {
  readonly id = 'naming';
  readonly name = 'Naming Conventions';

  async analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];
    const cache = useCache();
    const analytics = useAnalytics();

    for (const file of files) {
      // Check cache first
      const cacheKey = this.generateCacheKey(file, context.preset);

      if (cache) {
        // eslint-disable-next-line no-await-in-loop -- Sequential file analysis with caching
        const cached = await cache.get<ReviewFinding[]>(cacheKey);
        if (cached) {
          findings.push(...cached);
          continue;
        }
      }

      // Build prompts
      const systemPrompt = namingPrompts.buildSystemPrompt(context);
      const userPrompt = namingPrompts.analyzeFile(file);

      // Use LLM with tool calling
      const llm = useLLM({ tier: 'small' }); // Naming is simpler, can use small model
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
            tools: [NAMING_FINDING_TOOL],
            temperature: 0.2, // Low temp for consistency
          }
        );

        // Track analytics
        if (analytics) {
          // eslint-disable-next-line no-await-in-loop -- Analytics tracking after each file
          await analytics.track('review.naming.complete', {
            file: file.path,
            tokensUsed: response.usage.promptTokens + response.usage.completionTokens,
            toolCalls: response.toolCalls?.length ?? 0,
          });
        }

        // Process tool calls
        const fileFindings = this.processToolCalls(response.toolCalls || [], file);
        findings.push(...fileFindings);

        // Cache results (24 hours)
        if (cache) {
          // eslint-disable-next-line no-await-in-loop -- Cache storage after analysis
          await cache.set(cacheKey, fileFindings, 86400000);
        }
      } catch (error) {
        useLogger()?.debug(`[NamingAnalyzer] Failed to analyze ${file.path}:`, { error });
        continue;
      }
    }

    return findings;
  }

  /**
   * Process LLM tool calls into ReviewFindings
   */
   
  private processToolCalls(toolCalls: { name: string; input: unknown }[], file: ParsedFile): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const call of toolCalls) {
      if (call.name === 'report_naming_finding') {

        const args = call.input as Record<string, unknown>;

        // Validate line number
        const lineCount = file.content.split('\n').length;
        const line = typeof args.line === 'number' ? args.line : parseInt(String(args.line), 10);
        if (isNaN(line) || line < 1 || line > lineCount) {
          useLogger()?.debug(`[NamingAnalyzer] Invalid line number ${args.line} for ${file.path}`);
          continue;
        }

        // Validate severity (naming issues are warning/info only)
        const severity = args.severity === 'warning' ? 'medium' : 'info';

        // Sanitize names for display
        const currentName = String(args.currentName || '').slice(0, 100);
        const suggestedName = String(args.suggestedName || '').slice(0, 100);

        findings.push({
          id: this.buildFindingId(file, line, 'naming'),
          ruleId: 'llm:naming',
          type: 'style',
          severity,
          confidence: 'heuristic', // Naming is subjective, low confidence

          file: file.path,
          line,

          message: String(args.message || '').slice(0, 500),
          suggestion: `Rename '${currentName}' to '${suggestedName}'`,
          rationale: args.rationale ? String(args.rationale).slice(0, 500) : undefined,

          engine: 'llm',
          source: 'llm-naming',

          // For agent mode gating
          scope: 'local',
          automated: false, // Naming suggestions are optional
        });
      }
    }

    return findings;
  }
}
