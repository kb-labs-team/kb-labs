/**
 * plan_write tool — write/update the session plan file on disk.
 *
 * Enables iterative plan building: agent writes plan incrementally during
 * exploration, rather than generating everything at the end in one shot.
 * The plan survives context compaction because it lives on disk.
 *
 * Plan file location: .kb/agents/sessions/{sessionId}/plan.md
 * (resolved from context.sessionId and context.workingDir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../../types.js';
import { toolError } from '../shared/tool-error.js';

export function createPlanWriteTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'plan_write',
        description: `Write or update the plan file for this session. The plan is saved to disk and survives context compaction. Use this to iteratively build your plan during exploration — write what you've learned so far, then continue exploring. The user can view the plan file at any time.`,
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Full markdown content for the plan file (replaces previous content)',
            },
            append: {
              type: 'string',
              description: 'Text to append to the existing plan (mutually exclusive with content)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string | undefined;
      const append = input.append as string | undefined;

      if (!content && !append) {
        return toolError({
          code: 'MISSING_INPUT',
          message: 'Either content or append must be provided.',
          retryable: false,
          hint: 'Provide content= for full replacement, or append= to add to existing plan.',
        });
      }

      if (content && append) {
        return toolError({
          code: 'AMBIGUOUS_INPUT',
          message: 'Cannot use both content and append at the same time.',
          retryable: false,
          hint: 'Use content= to replace the entire plan, or append= to add a section.',
        });
      }

      // Resolve plan file path
      const sessionId = context.sessionId;
      if (!sessionId) {
        return toolError({
          code: 'NO_SESSION',
          message: 'No session ID available. Plan write requires an active session.',
          retryable: false,
        });
      }

      const planDir = path.join(context.workingDir, '.kb', 'agents', 'sessions', sessionId);
      const planPath = path.join(planDir, 'plan.md');

      // Ensure directory exists
      if (!fs.existsSync(planDir)) {
        fs.mkdirSync(planDir, { recursive: true });
      }

      let finalContent: string;

      if (content) {
        // Full replacement
        finalContent = content;
      } else {
        // Append mode
        let existing = '';
        try {
          existing = fs.readFileSync(planPath, 'utf-8');
        } catch {
          // File doesn't exist yet — start fresh
        }
        finalContent = existing
          ? `${existing.trimEnd()}\n\n${append}`
          : append!;
      }

      fs.writeFileSync(planPath, finalContent, 'utf-8');

      const lineCount = finalContent.split('\n').length;
      const mode = content ? 'replaced' : 'appended to';

      return {
        success: true,
        output: `Plan ${mode}: ${planPath}\nLines: ${lineCount}`,
        metadata: {
          planPath,
          lineCount,
          mode: content ? 'replace' : 'append',
        },
      };
    },
  };
}
