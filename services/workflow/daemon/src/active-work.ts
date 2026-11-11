import type { ActiveWorkProvider } from "@kb-labs/shared-daemon";
import type { WorkflowEngine } from "@kb-labs/workflow-engine";

type WorkflowStateStore = Pick<ReturnType<WorkflowEngine["getStateStore"]>, "listActiveWork">;

export function createWorkflowActiveWorkProvider(store: WorkflowStateStore): ActiveWorkProvider {
  return async () => {
    const active = await store.listActiveWork();
    return [
      ...active.runs.map((id) => ({ kind: "workflow" as const, id })),
      ...active.jobs.map((id) => ({ kind: "job" as const, id })),
    ];
  };
}
