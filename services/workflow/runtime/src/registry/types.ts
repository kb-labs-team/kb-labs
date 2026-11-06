/**
 * Resolved workflow information from registry
 */
export interface ResolvedWorkflow {
  /** Workflow ID (e.g., "workspace:ai-ci", "plugin:@kb-labs/review/full-audit") */
  id: string
  /** Source of the workflow */
  source: 'workspace' | 'plugin'
  /** Absolute path to workflow file (YAML/JSON) */
  filePath: string
  /** Optional description from workflow spec */
  description?: string
  /** Optional tags for filtering */
  tags?: string[]
  /** Optional metadata (plugin ID, version, etc.) */
  metadata?: {
    pluginId?: string
    pluginVersion?: string
  }
}

/**
 * Base interface for workflow registry
 */
export interface WorkflowRegistry {
  /**
   * List all discovered workflows (cached)
   */
  list(): Promise<ResolvedWorkflow[]>

  /**
   * Resolve workflow by ID
   * @param id - Workflow ID (with or without prefix)
   */
  resolve(id: string): Promise<ResolvedWorkflow | null>

  /**
   * Refresh the cache (explicit update)
   */
  refresh(): Promise<void>

  /**
   * Cleanup resources
   */
  dispose?(): Promise<void>
}

/**
 * Configuration for workflow registry
 */
export interface WorkflowRegistryConfig {
  /** Workspace root directory */
  workspaceRoot: string
  /** Glob patterns for workspace workflows */
  workspaces?: string[]
  /** Include plugin workflows */
  plugins?: boolean
  /** Cache configuration */
  cache?: {
    /** Time-to-live in milliseconds (optional, for future) */
    ttl?: number
  }
}

