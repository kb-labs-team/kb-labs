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
  /** Workflow run that owns this workspace, when materialized for workflow execution. */
  ownerRunId?: string;
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
  reason: 'dirty' | 'status-unavailable' | 'ownership-unverified';
}

export interface WorkspaceProviderCapabilities {
  supportsAttach?: boolean;
  supportsRelease?: boolean;
  supportsReadOnlyMounts?: boolean;
  supportsSourceRef?: boolean;
  custom?: Record<string, unknown>;
}

/** Binary-safe Git patch produced from the immutable workspace base. */
export interface WorkspacePatchExport {
  patch: NodeJS.ReadableStream;
  baseCommit: string;
  changedFiles: string[];
}

/** Trusted owner context required to export a patch from a project workspace. */
export interface WorkspacePatchExportRequest {
  workspaceId: string;
  /** Owning registered project root supplied by the workflow runtime. */
  projectRoot: string;
  /** Full owning workflow run ID; prevents another run in the same project from claiming the workspace. */
  ownerRunId: string;
  /** Persisted workspace root; verified against the owner and workspace ID. */
  workspaceRoot: string;
  /** Cancels Git work if the workflow step exceeds its execution deadline. */
  signal?: AbortSignal;
}

export interface IWorkspaceProvider {
  materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor>;
  /** Resolve a source ref to an immutable commit before workspace materialization. */
  resolveSourceRef?(sourceRef: string, projectRoot: string): Promise<string>;
  attach(request: AttachWorkspaceRequest): Promise<WorkspaceAttachment>;
  release(workspaceId: string, environmentId?: string): Promise<void>;
  getStatus(workspaceId: string): Promise<WorkspaceStatusResult>;
  /** Optional capability used only by the explicit `builtin:workspace-patch` workflow step. */
  exportPatch?(request: WorkspacePatchExportRequest): Promise<WorkspacePatchExport>;
  /** Inspect existing workspaces at host startup and report paths retained for recovery. */
  startupCleanup?(projectRoot?: string): Promise<WorkspaceCleanupResult[]>;
  getCapabilities?(): WorkspaceProviderCapabilities;
}
