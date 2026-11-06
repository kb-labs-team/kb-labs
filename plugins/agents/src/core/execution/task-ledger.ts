export type StepStatus = 'pending' | 'done' | 'failed';

export type CapabilityType =
  | 'discover_resource'
  | 'read_resource'
  | 'mutate_resource'
  | 'execute_command'
  | 'memory_access'
  | 'progress_tracking'
  | 'finalize_result'
  | 'integrate_external'
  | 'general_action';

export type LedgerStep = {
  id: string;
  goal: string;
  capability: CapabilityType;
  toolName?: string;
  status: StepStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  evidence?: string;
};

export class TaskLedger {
  private steps: LedgerStep[] = [];
  private activeById = new Map<string, number>();
  private counter = 0;

  startStep(params: {
    goal: string;
    capability: CapabilityType;
    toolName?: string;
  }): string {
    this.counter += 1;
    const id = `ledger-step-${this.counter}`;
    const step: LedgerStep = {
      id,
      goal: params.goal,
      capability: params.capability,
      toolName: params.toolName,
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    this.steps.push(step);
    this.activeById.set(id, this.steps.length - 1);
    return id;
  }

  completeStep(stepId: string, evidence?: string): void {
    const idx = this.activeById.get(stepId);
    if (idx == null) {
      return;
    }
    const step = this.steps[idx]!;
    const completedAt = new Date().toISOString();
    step.status = 'done';
    step.completedAt = completedAt;
    step.evidence = evidence;
    step.durationMs = new Date(completedAt).getTime() - new Date(step.startedAt).getTime();
    this.activeById.delete(stepId);
  }

  failStep(stepId: string, error: string): void {
    const idx = this.activeById.get(stepId);
    if (idx == null) {
      return;
    }
    const step = this.steps[idx]!;
    const completedAt = new Date().toISOString();
    step.status = 'failed';
    step.completedAt = completedAt;
    step.error = error;
    step.durationMs = new Date(completedAt).getTime() - new Date(step.startedAt).getTime();
    this.activeById.delete(stepId);
  }

  getSummary(): {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    pendingSteps: number;
    avgStepDurationMs: number;
    capabilityUsage: Record<CapabilityType, number>;
  } {
    const capabilityUsage: Record<CapabilityType, number> = {
      discover_resource: 0,
      read_resource: 0,
      mutate_resource: 0,
      execute_command: 0,
      memory_access: 0,
      progress_tracking: 0,
      finalize_result: 0,
      integrate_external: 0,
      general_action: 0,
    };

    let completedSteps = 0;
    let failedSteps = 0;
    let pendingSteps = 0;
    let durationTotal = 0;
    let durationCount = 0;

    for (const step of this.steps) {
      capabilityUsage[step.capability] += 1;

      if (step.status === 'done') {
        completedSteps += 1;
      } else if (step.status === 'failed') {
        failedSteps += 1;
      } else {
        pendingSteps += 1;
      }

      if (step.durationMs != null && step.durationMs >= 0) {
        durationTotal += step.durationMs;
        durationCount += 1;
      }
    }

    return {
      totalSteps: this.steps.length,
      completedSteps,
      failedSteps,
      pendingSteps,
      avgStepDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : 0,
      capabilityUsage,
    };
  }
}

export function mapToolToCapability(toolName: string): CapabilityType {
  if (toolName === 'report') {
    return 'finalize_result';
  }
  if (toolName.startsWith('todo_')) {
    return 'progress_tracking';
  }
  if (toolName.startsWith('memory_')) {
    return 'memory_access';
  }
  if (toolName === 'shell_exec') {
    return 'execute_command';
  }
  if (toolName.startsWith('fs_')) {
    if (toolName === 'fs_read' || toolName === 'fs_list') {
      return 'read_resource';
    }
    return 'mutate_resource';
  }
  if (toolName.includes('search') || toolName.includes('find')) {
    return 'discover_resource';
  }
  if (toolName.includes('mcp') || toolName.startsWith('plugin_')) {
    return 'integrate_external';
  }
  return 'general_action';
}

