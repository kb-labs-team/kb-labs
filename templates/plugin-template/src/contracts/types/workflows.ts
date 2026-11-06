export interface WorkflowStepContract {
  id: string;
  description?: string;
  commandId?: string;
  consumes?: string[];
  produces?: string[];
}

export interface WorkflowContract {
  id: string;
  description?: string;
  consumes?: string[];
  produces?: string[];
  steps?: WorkflowStepContract[];
}

export type WorkflowContractsMap = Record<string, WorkflowContract>;

