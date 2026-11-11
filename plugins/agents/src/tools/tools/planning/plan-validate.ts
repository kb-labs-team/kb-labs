/**
 * plan_validate tool — LLM-based plan quality gate.
 *
 * Called by the plan-writer agent after drafting a plan to get structured
 * feedback before reporting it as ready. The LLM evaluator receives:
 *   - The original user task (so it can judge relevance)
 *   - The full plan markdown
 *   - The requested evaluation tier (default: small)
 *
 * Returns a human+agent-readable string with:
 *   - passed: yes/no
 *   - score: 0.0–1.0
 *   - Per-dimension breakdown (specificity, actionability, completeness, verification)
 *   - Concrete, actionable feedback for each failing dimension
 *
 * The agent uses this output to decide:
 *   1. passed=yes → call report() with the plan
 *   2. passed=no  → revise the plan based on feedback and call plan_validate again
 *   3. After 3 failed attempts → call ask_user() with the plan + issues
 */

import type { Tool, ToolContext } from '../../types.js';
import { useLLM } from '@kb-labs/sdk';

const EVAL_SYSTEM_PROMPT = `You are a plan quality evaluator. Evaluate implementation plans written by AI agents.

You will receive the original user task and the plan markdown.

Score the plan on four dimensions (0.0–1.0 each):

**specificity** (weight 0.30)
- Does the plan reference real file paths from the codebase?
- Are function names, class names, or line numbers mentioned where relevant?
- For simple tasks (1-2 files), mentioning those files is sufficient for a high score.
- For complex tasks (many files), more paths are expected.

**actionability** (weight 0.35)
- Can each step be executed without guessing what to do?
- Steps should contain: what file to edit, what to change, or what command to run.
- "Edit X to add Y" is actionable. "Update the configuration" is not.

**completeness** (weight 0.15)
- Does the plan have: task description, steps, verification?
- Are sections substantive (not just headings)?

**verification** (weight 0.20)
- Does the plan include concrete commands to verify correctness?
- At least one build or test command expected.

Respond in EXACTLY this format (no other text before or after):
SCORE: 0.XX
SPECIFICITY: 0.XX
ACTIONABILITY: 0.XX
COMPLETENESS: 0.XX
VERIFICATION: 0.XX
FEEDBACK:
<One paragraph per dimension scoring below 0.7. Quote the weak part, explain the problem, give a fix example. If all dimensions ≥ 0.7, write "Plan meets quality threshold.">

IMPORTANT: Only output the format above. Do NOT output tool calls, code blocks, or any other format.`;

/**
 * Build the evaluation user message.
 */
function buildEvalPrompt(task: string, planMarkdown: string): string {
  return `## Original user task

${task}

## Plan to evaluate

${planMarkdown}`;
}

/**
 * Parse the LLM response into a structured result string for the agent.
 * If parsing fails, returns the raw response — the agent can still read it.
 */
const PASS_THRESHOLD = 0.55;

function formatResult(raw: string, tier: string): string {
  const lines = raw.split('\n');
  const get = (key: string): string => {
    const line = lines.find(l => l.toUpperCase().startsWith(key.toUpperCase() + ':'));
    return line?.slice(line.indexOf(':') + 1).trim() ?? '';
  };

  const specificity = parseFloat(get('SPECIFICITY') || '0');
  const actionability = parseFloat(get('ACTIONABILITY') || '0');
  const completeness = parseFloat(get('COMPLETENESS') || '0');
  const verification = parseFloat(get('VERIFICATION') || '0');

  // Compute composite score ourselves — don't trust LLM's SCORE or PASSED fields
  const composite = specificity * 0.30 + actionability * 0.35 + completeness * 0.15 + verification * 0.20;
  const passed = composite >= PASS_THRESHOLD;

  // If all dimensions parsed as 0, the LLM likely hallucinated (wrong format)
  if (specificity === 0 && actionability === 0 && completeness === 0 && verification === 0) {
    return [
      `⚠️ EVAL_ERROR — LLM returned unparseable response (${tier} tier)`,
      '',
      'Raw response (first 300 chars):',
      raw.slice(0, 300),
      '',
      'ACTION: Try again with a different tier, or call report() if you believe the plan is ready.',
    ].join('\n');
  }

  const feedbackIdx = raw.toUpperCase().indexOf('FEEDBACK:');
  const feedback = feedbackIdx >= 0 ? raw.slice(feedbackIdx + 'FEEDBACK:'.length).trim() : '';

  const status = passed ? '✅ PASSED' : '❌ FAILED';
  const scoreBar = Math.round(composite * 10);
  const bar = '█'.repeat(scoreBar) + '░'.repeat(10 - scoreBar);

  return [
    `${status} — score: ${composite.toFixed(2)} [${bar}] (threshold ${PASS_THRESHOLD}, ${tier} tier)`,
    '',
    `  specificity:   ${specificity.toFixed(2)}  (weight 0.30)`,
    `  actionability: ${actionability.toFixed(2)}  (weight 0.35)`,
    `  completeness:  ${completeness.toFixed(2)}  (weight 0.15)`,
    `  verification:  ${verification.toFixed(2)}  (weight 0.20)`,
    '',
    ...(feedback ? ['─── Feedback ───', feedback, ''] : []),
    passed
      ? 'ACTION: Call report() with the plan — it is ready for user approval.'
      : 'ACTION: Revise the plan addressing the feedback above, then call plan_validate again.\n        After 3 failed validations, call ask_user() with the plan and this feedback.',
  ].join('\n');
}

export function createPlanValidateTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'plan_validate',
        description: `Evaluate a plan draft against quality criteria using an LLM judge.
Returns pass/fail, per-dimension scores, and concrete actionable feedback on what to fix.
Call this after writing a plan draft, before calling report().
If it fails, revise the plan based on the feedback and call plan_validate again.
After 3 consecutive failures, call ask_user() with the plan and the feedback to escalate to the human.`,
        parameters: {
          type: 'object' as const,
          properties: {
            task: {
              type: 'string' as const,
              description: 'The original user task/request that the plan is supposed to address. Copied verbatim — the evaluator needs this to judge relevance.',
            },
            plan_markdown: {
              type: 'string' as const,
              description: 'The full plan markdown to evaluate.',
            },
            tier: {
              type: 'string' as const,
              enum: ['small', 'medium', 'large'],
              description: 'LLM tier for evaluation. Default: small (fast, cheap). Use medium/large for complex plans or if small gives inconsistent results.',
            },
          },
          required: ['task', 'plan_markdown'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const task = input.task as string;
      const planMarkdown = input.plan_markdown as string;
      const tier = (input.tier as string | undefined) ?? 'small';

      if (!task?.trim()) {
        return { success: false, output: 'ERROR: task is required — provide the original user request so the evaluator can judge plan relevance.' };
      }
      if (!planMarkdown?.trim()) {
        return { success: false, output: 'ERROR: plan_markdown is required — provide the full plan markdown to evaluate.' };
      }

      const llm = useLLM({ tier: tier as 'small' | 'medium' | 'large' });
      if (!llm) {
        return { success: false, output: `ERROR: LLM tier "${tier}" is not available. Try a different tier or check platform configuration.` };
      }

      try {
        const response = await llm.complete(buildEvalPrompt(task, planMarkdown), {
          systemPrompt: EVAL_SYSTEM_PROMPT,
          maxTokens: 1500,
        });

        const formatted = formatResult(response.content, tier);

        // If plan passed, signal to report tool that validation is complete
        if (formatted.startsWith('✅ PASSED') || formatted.startsWith('⚠️ EVAL_ERROR')) {
          (context as unknown as Record<string, unknown>).planValidationPassed = true;
        }

        return { success: true, output: formatted };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: `ERROR: LLM evaluation failed: ${message}` };
      }
    },
  };
}
