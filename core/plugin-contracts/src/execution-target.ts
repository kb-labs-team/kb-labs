/**
 * Target descriptor for execution in a specific runtime environment/workspace context.
 */
export interface ExecutionTarget {
  /**
   * Target environment identifier.
   */
  environmentId?: string;

  /**
   * Target workspace identifier.
   */
  workspaceId?: string;

  /**
   * Namespace boundary for authorization (required for targeted mode).
   */
  namespace?: string;

  /**
   * Working directory override inside target context.
   */
  workdir?: string;

  /** Git ref used when materializing an isolated workspace. Omitted refs keep the provider's configured default. */
  sourceRef?: string;
}

