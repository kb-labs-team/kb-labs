/**
 * Execute mode handler - standard task execution with optional revision loop.
 *
 * When a session has an approved plan, the plan markdown is injected into
 * the task prompt and the plan status is tracked through its lifecycle:
 *   approved → in_progress → completed | failed
 *
 * Revision loop (when enabled):
 *   execute → quality gate → if fail → compact summary → inject feedback → re-execute
 *   Max 2 revisions. Quality gate is heuristic (no LLM).
 */

import type { TaskResult, AgentConfig, TaskPlan } from '../../contracts/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import type { ModeHandler } from './mode-handler';
import { AgentSDK } from '../../sdk/index.js';
import { createCoreToolPack } from '../tools/index.js';
import { SessionManager } from '../planning/session-manager';
import { promises as fs } from 'node:fs';

const MAX_REVISIONS = 2;
const QUALITY_GATE_THRESHOLD = 70;

/**
 * Heuristic quality gate scoring (no LLM).
 */
function evaluateQualityGate(result: TaskResult): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Success flag (+40)
  if (result.success) {
    score += 40;
  } else {
    reasons.push('execution reported failure');
  }

  // Files modified (+10) — agent actually did something
  if (result.filesModified.length > 0 || result.filesCreated.length > 0) {
    score += 10;
  } else {
    reasons.push('no files modified or created');
  }

  // Reasonable iteration count — not stuck/aborted early (+20)
  if (result.iterations >= 3) {
    score += 20;
  } else {
    reasons.push(`only ${result.iterations} iteration(s) — may have been interrupted`);
  }

  // Has a summary (+15)
  if (result.summary && result.summary.length > 50) {
    score += 15;
  } else {
    reasons.push('summary is missing or too short');
  }

  // Tokens used (reasonable range) (+15)
  if (result.tokensUsed > 1000) {
    score += 15;
  }

  return { score, reasons };
}

/**
 * Execute mode - standard agent execution
 */
export class ExecuteModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    const plan = await this.loadApprovedPlan(config);
    const enrichedTask = plan ? this.buildTaskWithPlan(task, plan) : task;

    // Mark plan as in_progress before execution starts
    if (plan) {
      await this.updatePlanStatus(config, plan, 'in_progress');
    }

    // First execution attempt
    let result = await this.runOnce(enrichedTask, config, toolRegistry);

    // Revision loop: if quality gate fails, retry with feedback
    for (let revision = 0; revision < MAX_REVISIONS; revision++) {
      const gate = evaluateQualityGate(result);
      if (gate.score >= QUALITY_GATE_THRESHOLD) {
        break; // Quality is acceptable
      }

      // Build revision task with feedback from previous attempt
      const revisionTask = this.buildRevisionTask(task, result, gate.reasons, revision + 1);
      result = await this.runOnce(revisionTask, config, toolRegistry);
    }

    // Mark plan as completed or failed based on final result
    if (plan) {
      await this.updatePlanStatus(config, plan, result.success ? 'completed' : 'failed');
    }

    return result;
  }

  /**
   * Single execution attempt.
   */
  private async runOnce(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
  ): Promise<TaskResult> {
    // Strip mode from config so child runner always uses 'execute' (no recursion)
    const { mode: _mode, ...execConfig } = config;
    const runner = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(execConfig as AgentConfig);

    return runner.execute(task);
  }

  /**
   * Build a revision task that includes compact feedback from previous attempt.
   */
  private buildRevisionTask(
    originalTask: string,
    prevResult: TaskResult,
    failReasons: string[],
    revisionNum: number,
  ): string {
    const prevSummary = prevResult.summary
      ? prevResult.summary.slice(0, 1000)
      : '(no summary available)';

    const modifiedFiles = prevResult.filesModified.length > 0
      ? `Modified files: ${prevResult.filesModified.slice(0, 10).join(', ')}`
      : 'No files were modified.';

    return [
      `## Revision ${revisionNum} — Previous attempt did not meet quality threshold`,
      '',
      `Original task: ${originalTask}`,
      '',
      '### Previous Attempt Summary',
      `- Success: ${prevResult.success}`,
      `- Iterations: ${prevResult.iterations}`,
      `- ${modifiedFiles}`,
      `- Summary: ${prevSummary}`,
      '',
      '### Issues to Address',
      ...failReasons.map(r => `- ${r}`),
      '',
      '### Instructions',
      'Review the previous attempt and address the issues listed above.',
      'Focus on completing the task successfully. Check existing files before making changes.',
      'Do NOT repeat the same approach if it failed — try a different strategy.',
    ].join('\n');
  }

  /**
   * Load approved (or draft) plan from session storage.
   * Falls back to plan.md (written by plan_write tool) if plan.json not available.
   */
  private async loadApprovedPlan(config: AgentConfig): Promise<TaskPlan | null> {
    if (!config.sessionId || !config.workingDir) { return null; }

    // Try plan.json first (structured format)
    try {
      const sessionManager = new SessionManager(config.workingDir);
      const planPath = sessionManager.getSessionPlanPath(config.sessionId);
      const raw = await fs.readFile(planPath, 'utf-8');
      const plan: TaskPlan = JSON.parse(raw);
      if (plan.status !== 'approved' && plan.status !== 'draft') { return null; }
      return plan;
    } catch {
      // plan.json not available — try plan.md
    }

    // Fallback: load plan.md (written by plan_write tool during plan mode)
    try {
      const { join } = await import('node:path');
      const planMdPath = join(config.workingDir, '.kb', 'agents', 'sessions', config.sessionId, 'plan.md');
      const markdown = await fs.readFile(planMdPath, 'utf-8');
      if (markdown.trim().length > 0) {
        return {
          id: `plan-${config.sessionId}`,
          task: config.sessionId,
          status: 'approved',
          markdown,
          phases: [],
          createdAt: new Date().toISOString(),
        } as unknown as TaskPlan;
      }
    } catch {
      // No plan available at all
    }

    return null;
  }

  /**
   * Update plan status on disk.
   */
  private async updatePlanStatus(
    config: AgentConfig,
    plan: TaskPlan,
    status: TaskPlan['status'],
  ): Promise<void> {
    if (!config.sessionId || !config.workingDir) { return; }
    try {
      const sessionManager = new SessionManager(config.workingDir);
      const planPath = sessionManager.getSessionPlanPath(config.sessionId);
      const updated: TaskPlan = { ...plan, status, updatedAt: new Date().toISOString() };
      await fs.writeFile(planPath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch {
      // Non-fatal — execution continues regardless
    }
  }

  /**
   * Inject full plan markdown into the task prompt so the agent follows it.
   * Also adds a todo bootstrap instruction so the agent tracks progress.
   */
  private buildTaskWithPlan(task: string, plan: TaskPlan): string {
    const planContent = plan.markdown
      ? plan.markdown
      : this.formatPhasesCompact(plan);

    const todoBootstrap = this.buildTodoBootstrap(plan);

    // Replace the user task with a directive that makes it clear the plan is already here.
    // Do NOT search the filesystem for plan files — the full plan is provided below.
    return [
      'Execute the following plan step by step. The full plan is provided below — do NOT search for plan files in the filesystem.',
      '',
      `Original task: ${task}`,
      '',
      '## Execution progress tracking',
      '- After completing each phase/step, call `plan_write` to update the plan with checkboxes:',
      '  - `[x] Phase 2.1 — done (ConversationView empty states migrated)`',
      '  - `[ ] Phase 2.2 — pending`',
      '- This way if execution is interrupted, the next resume will see what was already done.',
      '- If a step in the plan is already marked `[x]`, SKIP it — it was done in a previous run.',
      '- Check git diff or read files to verify completed steps before skipping.',
      '',
      '---',
      '',
      planContent,
      ...(todoBootstrap ? ['', '---', '', todoBootstrap] : []),
    ].join('\n');
  }

  /**
   * Build a todo_create instruction from plan phases so the agent tracks progress.
   * Returns null if no phases or sessionId is missing.
   */
  private buildTodoBootstrap(plan: TaskPlan): string | null {
    if (!plan.phases.length || !plan.sessionId) { return null; }

    const items = plan.phases.map((phase, i) => {
      const stepsSummary = phase.steps.length > 0
        ? ` (${phase.steps.map(s => s.action).join('; ')})`
        : '';
      return `  ${i + 1}. "${phase.name}${stepsSummary}" — priority: ${i === 0 ? 'high' : 'medium'}`;
    });

    return [
      '## Progress Tracking',
      '',
      'IMPORTANT: Before starting execution, call `todo_create` to set up progress tracking with these items:',
      '',
      ...items,
      '',
      'Update each todo to "in-progress" when you start a phase and "completed" when done.',
    ].join('\n');
  }

  /**
   * Fallback compact formatter when markdown is not stored on the plan object.
   */
  private formatPhasesCompact(plan: TaskPlan): string {
    const lines: string[] = [];
    for (const phase of plan.phases) {
      lines.push(`### ${phase.name}`);
      for (const step of phase.steps) {
        lines.push(`  - ${step.action}`);
      }
    }
    return lines.join('\n');
  }
}
