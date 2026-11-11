/**
 * Error thrown when workflow ID conflicts are detected
 */
export class WorkflowRegistryError extends Error {
  constructor(
    message: string,
    public readonly workflowId?: string,
  ) {
    super(message)
    this.name = 'WorkflowRegistryError'
  }
}

