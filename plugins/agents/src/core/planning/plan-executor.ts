/**
 * Plan executor - executes plans step by step with progress tracking
 */

import { promises as fs } from 'node:fs';
import type {
  TaskPlan,
  Phase,
  SessionProgress,
  Tracer,
  DetailedTraceEntry,
} from '../../contracts/index.js';

/**
 * Executes task plans with progress tracking
 */
export class PlanExecutor {
  private tracer?: Tracer;

  constructor(tracer?: Tracer) {
    this.tracer = tracer;
  }

  /**
   * Execute a plan
   */
  async execute(
    plan: TaskPlan,
    toolExecutor: (tool: string, args: Record<string, unknown>) => Promise<string>
  ): Promise<{
    success: boolean;
    completedPhases: number;
    completedSteps: number;
    failedSteps: number;
    error?: string;
  }> {
    let completedPhases = 0;
    let completedSteps = 0;
    let failedSteps = 0;

    for (const phase of plan.phases) {
      // Check dependencies
      if (!this.areDependenciesMet(phase, plan.phases)) {
        phase.status = 'skipped';
        continue;
      }

      this.recordTrace({
        iteration: 0,
        timestamp: new Date().toISOString(),
        type: 'phase_start',
        data: {
          phaseId: phase.id,
          phaseName: phase.name,
        },
      });

      phase.status = 'in_progress';
      phase.startedAt = new Date().toISOString();

      try {
        // Execute steps in sequence
        for (const step of phase.steps) {
          this.recordTrace({
            iteration: 0,
            timestamp: new Date().toISOString(),
            type: 'step_start',
            data: {
              stepId: step.id,
              action: step.action,
              tool: step.tool,
            },
          });

          step.status = 'in_progress';

          try {
            if (step.tool) {
              // Sequential tool execution required - plan steps must execute in order
               
              const result = await toolExecutor(step.tool, step.args || {});
              step.result = result;
            }

            step.status = 'completed';
            completedSteps++;

            this.recordTrace({
              iteration: 0,
              timestamp: new Date().toISOString(),
              type: 'step_end',
              data: {
                stepId: step.id,
                status: 'completed',
                result: step.result,
              },
            });
          } catch (error) {
            step.status = 'failed';
            step.error = error instanceof Error ? error.message : String(error);
            failedSteps++;

            this.recordTrace({
              iteration: 0,
              timestamp: new Date().toISOString(),
              type: 'step_end',
              data: {
                stepId: step.id,
                status: 'failed',
                error: step.error,
              },
            });

            // Fail the entire phase if a step fails
            throw error;
          }
        }

        phase.status = 'completed';
        phase.completedAt = new Date().toISOString();
        completedPhases++;

        this.recordTrace({
          iteration: 0,
          timestamp: new Date().toISOString(),
          type: 'phase_end',
          data: {
            phaseId: phase.id,
            status: 'completed',
          },
        });
      } catch (error) {
        phase.status = 'failed';
        phase.error = error instanceof Error ? error.message : String(error);

        this.recordTrace({
          iteration: 0,
          timestamp: new Date().toISOString(),
          type: 'phase_end',
          data: {
            phaseId: phase.id,
            status: 'failed',
            error: phase.error,
          },
        });

        return {
          success: false,
          completedPhases,
          completedSteps,
          failedSteps,
          error: phase.error,
        };
      }
    }

    return {
      success: true,
      completedPhases,
      completedSteps,
      failedSteps,
    };
  }

  /**
   * Check if phase dependencies are met
   */
  private areDependenciesMet(phase: Phase, allPhases: Phase[]): boolean {
    if (!phase.dependencies || phase.dependencies.length === 0) {
      return true;
    }

    for (const depId of phase.dependencies) {
      const depPhase = allPhases.find((p) => p.id === depId);
      if (!depPhase || depPhase.status !== 'completed') {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculate progress
   */
  calculateProgress(plan: TaskPlan): SessionProgress {
    const totalPhases = plan.phases.length;
    const completedPhases = plan.phases.filter((p) => p.status === 'completed').length;

    const totalSteps = plan.phases.reduce((sum, p) => sum + p.steps.length, 0);
    const completedSteps = plan.phases.reduce(
      (sum, p) => sum + p.steps.filter((s) => s.status === 'completed').length,
      0
    );

    const percentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const currentPhase = plan.phases.find((p) => p.status === 'in_progress');
    const currentStep = currentPhase?.steps.find((s) => s.status === 'in_progress');

    return {
      sessionId: plan.sessionId,
      planId: plan.id,
      currentPhaseId: currentPhase?.id,
      currentStepId: currentStep?.id,
      completedPhases,
      totalPhases,
      completedSteps,
      totalSteps,
      percentage,
      startedAt: plan.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Save progress to file
   */
  async saveProgress(progress: SessionProgress, filePath: string): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(progress, null, 2), 'utf-8');
  }

  /**
   * Record trace entry
   */
  private recordTrace(entry: Record<string, unknown>): void {
    if (this.tracer) {
      // plan-executor uses custom plan-phase event types (phase_start, step_start, etc.)
      // that predate the typed DetailedTraceEntry union. Cast through unknown to acknowledge
      // the intentional structural mismatch without using as any.
      this.tracer.trace(entry as unknown as Omit<DetailedTraceEntry, 'seq' | 'timestamp'>);
    }
  }
}
