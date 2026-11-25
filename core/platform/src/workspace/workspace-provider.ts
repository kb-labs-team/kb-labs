/**
 * @module @kb-labs/core-platform/workspace/workspace-provider
 * Workspace lifecycle abstraction.
 *
 * This port manages workspace materialization and attach/release lifecycle.
 */

export type WorkspaceStatus =
  | "pending"
  | "materializing"
  | "ready"
  | "attaching"
  | "attached"
  | "releasing"
  | "released"
  | "failed";

export interface WorkspaceMount {
  hostPath?: string;
  mountPath?: string;
  readOnly?: boolean;
}

/**
 * Progress event emitted during workspace materialization.
 * Any adapter can report lifecycle stages so hosts (workflow daemon, UI) can display progress.
 */
export interface WorkspaceProgressEvent {
  /** Lifecycle stage identifier (e.g. 'worktree', 'submodules', 'dependencies') */
  stage: string;
  /** Human-readable message */
  message: string;
  /** Optional progress percentage 0-100 */
  progress?: number;
}

export interface MaterializeWorkspaceRequest {
  /** Owning registered project path; required by project-backed workspace providers. */
  projectRoot?: string;
  /** Platform installation path used for tool binaries inside worktrees. */
  platformRoot?: string;
  workspaceId?: string;
  tenantId?: string;
  namespace?: string;
  sourceRef?: string;
  basePath?: string;
  metadata?: Record<string, unknown>;
  /** Optional callback for lifecycle progress updates */
  onProgress?: (event: WorkspaceProgressEvent) => void;
}

export interface WorkspaceDescriptor {
  workspaceId: string;
  provider: string;
  status: WorkspaceStatus;
  rootPath?: string;
  mount?: WorkspaceMount;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AttachWorkspaceRequest {
  workspaceId: string;
  environmentId: string;
  mountPath?: string;
  readOnly?: boolean;
}

export interface WorkspaceAttachment {
  workspaceId: string;
  environmentId: string;
  mountPath?: string;
  attachedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceStatusResult {
  workspaceId: string;
  status: WorkspaceStatus;
  reason?: string;
  updatedAt: string;
}

export interface WorkspaceCleanupResult {
  workspaceId: string;
  status: 'preserved';
  path: string;
  reason: 'dirty' | 'status-unavailable' | 'cleanup-failed';
}

export interface WorkspaceProviderCapabilities {
  supportsAttach?: boolean;
  supportsRelease?: boolean;
  supportsReadOnlyMounts?: boolean;
  custom?: Record<string, unknown>;
}

export interface IWorkspaceProvider {
  materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor>;
  attach(request: AttachWorkspaceRequest): Promise<WorkspaceAttachment>;
  release(workspaceId: string, environmentId?: string): Promise<void>;
  getStatus(workspaceId: string): Promise<WorkspaceStatusResult>;
  /** Remove stale workspaces at host startup and report any path retained for recovery. */
  startupCleanup?(projectRoot?: string): Promise<WorkspaceCleanupResult[]>;
  getCapabilities?(): WorkspaceProviderCapabilities;
}
