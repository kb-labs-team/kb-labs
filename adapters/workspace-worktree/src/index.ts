import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execAsync = promisify(exec);
import type {
  IWorkspaceProvider,
  MaterializeWorkspaceRequest,
  WorkspaceDescriptor,
  AttachWorkspaceRequest,
  WorkspaceAttachment,
  WorkspaceStatusResult,
  WorkspaceCleanupResult,
  WorkspaceProviderCapabilities,
  WorkspaceStatus,
} from '@kb-labs/sdk/adapters';

export { manifest } from './manifest.js';

interface WorkspaceContext {
  projectRoot?: string;
  platformRoot?: string;
}

export interface WorktreeWorkspaceAdapterConfig {
  worktreeDir?: string;
  branch?: string;
  initSubmodules?: boolean;
  installDeps?: boolean;
  /**
   * Relative paths (from platform root) of tool dist/ directories to symlink from the
   * platform into the worktree. Only link tool binaries the agent should never
   * rebuild — package dist/ directories are left absent so agent builds write into
   * the worktree, not the platform.
   *
   * Default: ['cli/bin/dist'] — makes `pnpm kb` resolve to the platform's CLI.
   * Set to [] to disable all symlinking.
   */
  toolDistPaths?: string[];
  /** @deprecated use toolDistPaths: [] to disable */
  symlinkPlatformDist?: boolean;
  workspace?: WorkspaceContext;
}

interface WorktreeRecord {
  workspaceId: string;
  worktreePath: string;
  branch: string;
  status: WorkspaceStatus;
  createdAt: string;
  runId?: string;
  /** Reference count — number of jobs currently using this workspace */
  refCount: number;
  repoRoot: string;
  worktreeBaseDir: string;
}

const TIMEOUTS = {
  worktree: 30_000,
  submodules: 600_000,
  install: 300_000,
  cleanup: 30_000,
} as const;

export class WorktreeWorkspaceAdapter implements IWorkspaceProvider {
  private readonly configuredProjectRoot?: string;
  private readonly configuredPlatformRoot?: string;
  private readonly worktreeDir: string;
  private readonly defaultBranch: string;
  private readonly initSubmodules: boolean;
  private readonly installDeps: boolean;
  private readonly toolDistPaths: string[];
  private readonly records = new Map<string, WorktreeRecord>();

  constructor(config: WorktreeWorkspaceAdapterConfig = {}) {
    this.configuredProjectRoot = config.workspace?.projectRoot;
    this.configuredPlatformRoot = config.workspace?.platformRoot;
    this.worktreeDir = config.worktreeDir ?? '.worktrees';
    this.defaultBranch = config.branch ?? 'main';
    this.initSubmodules = config.initSubmodules ?? true;
    this.installDeps = config.installDeps ?? true;
    // Default: link only the kb CLI binary so `pnpm kb` works in the worktree.
    // Agent builds other packages fresh into the worktree's own dist/ directories.
    this.toolDistPaths = config.toolDistPaths ?? (config.symlinkPlatformDist === false ? [] : ['cli/bin/dist']);
  }

  async materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor> {
    const workspaceId = request.workspaceId ?? `wt_${randomUUID().slice(0, 8)}`;
    const branch = request.sourceRef ?? this.defaultBranch;
    const runId = (request.metadata as Record<string, unknown>)?.runId as string | undefined;
    const onProgress = request.onProgress;

    const safeBranch = branch.replace(/[^a-zA-Z0-9_\-./]/g, '');
    if (!safeBranch || safeBranch !== branch) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    const projectRoot = request.projectRoot ?? this.configuredProjectRoot;
    const platformRoot = request.platformRoot ?? this.configuredPlatformRoot;
    if (!projectRoot) {
      throw new Error('Workspace materialization needs the owning project root. Pass projectRoot from the project runtime.');
    }
    if (this.toolDistPaths.length > 0 && !platformRoot) {
      throw new Error('Workspace materialization needs the platform root to link CLI tools. Pass platformRoot from the platform runtime.');
    }
    const repoRoot = path.resolve(projectRoot);
    const worktreeBaseDir = path.resolve(repoRoot, this.worktreeDir);

    if (!existsSync(worktreeBaseDir)) {
      mkdirSync(worktreeBaseDir, { recursive: true });
    }

    const worktreePath = path.join(worktreeBaseDir, workspaceId);

    // Reuse existing worktree (retry scenario — same run, same workspace)
    if (existsSync(worktreePath)) {
      const existing = this.records.get(workspaceId);
      if (existing) {
        existing.refCount++;
        onProgress?.({ stage: 'reuse', message: 'Reusing existing worktree', progress: 100 });
        return {
          workspaceId,
          provider: 'worktree',
          status: 'ready',
          rootPath: worktreePath,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
          metadata: { branch, runId, repoRoot, reused: true },
        };
      }
      // Worktree exists on disk but not in records (stale) — reuse anyway
      onProgress?.({ stage: 'reuse', message: 'Reusing existing worktree (recovered)', progress: 100 });
      const now = new Date().toISOString();
      this.records.set(workspaceId, { workspaceId, worktreePath, branch, status: 'ready', createdAt: now, runId, refCount: 1, repoRoot, worktreeBaseDir });
      return {
        workspaceId,
        provider: 'worktree',
        status: 'ready',
        rootPath: worktreePath,
        createdAt: now,
        updatedAt: now,
        metadata: { branch, runId, repoRoot, reused: true },
      };
    }

    const progress = (stage: string, message: string, pct?: number) => {
      onProgress?.({ stage, message, progress: pct });
    };

    try {
      // Stage 1: Create worktree
      progress('worktree', `Creating worktree from ${safeBranch}...`, 10);
      await this.exec(
        `git worktree add --detach "${worktreePath}" ${safeBranch}`,
        repoRoot,
        TIMEOUTS.worktree,
      );
      progress('worktree', 'Worktree created', 25);

      // Stage 1b: Symlink the root .env — it's gitignored so `git worktree add`
      // never copies it, and its contents aren't per-worktree specific.
      this.symlinkEnvFromRoot(worktreePath, repoRoot);

      // Stage 2: Initialize submodules
      if (this.initSubmodules) {
        progress('submodules', 'Initializing submodules...', 30);
        await this.exec(
          'git submodule update --recursive',
          worktreePath,
          TIMEOUTS.submodules,
        );
        progress('submodules', 'Submodules ready', 60);
      }

      // Stage 3: Install dependencies
      if (this.installDeps) {
        progress('dependencies', 'Installing dependencies (pnpm install)...', 65);
        await this.exec(
          'pnpm install --frozen-lockfile',
          worktreePath,
          TIMEOUTS.install,
        );
        progress('dependencies', 'Dependencies installed', 90);
      }

      // Stage 4: Symlink specific tool dist/ directories from the platform.
      // dist/ is gitignored, so the worktree won't have compiled tool binaries.
      // Only tool binaries (e.g. cli/bin/dist) are linked — package dist/ dirs
      // are left absent so agent builds produce output in the worktree, not the platform.
      if (this.toolDistPaths.length > 0) {
        progress('dist-links', 'Linking platform tool binaries...', 95);
        if (platformRoot) await this.symlinkDistFromPlatform(worktreePath, platformRoot);
        progress('dist-links', 'Tool binaries linked', 98);
      }

      progress('ready', 'Workspace ready', 100);

      const record: WorktreeRecord = {
        workspaceId,
        worktreePath,
        branch,
        status: 'ready',
        createdAt: new Date().toISOString(),
        runId,
        refCount: 1,
        repoRoot,
        worktreeBaseDir,
      };
      this.records.set(workspaceId, record);

      return {
        workspaceId,
        provider: 'worktree',
        status: 'ready',
        rootPath: worktreePath,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        metadata: { branch, runId, repoRoot, platformRoot },
      };
    } catch (error) {
      progress('failed', `Provisioning failed: ${error instanceof Error ? error.message : String(error)}`);

      const recoveryHint = existsSync(worktreePath)
        ? ` Workspace preserved for recovery at ${worktreePath}`
        : '';

      throw new Error(
        `Failed to provision workspace: ${error instanceof Error ? error.message : String(error)}${recoveryHint}`
      );
    }
  }

  async attach(_request: AttachWorkspaceRequest): Promise<WorkspaceAttachment> {
    return {
      workspaceId: _request.workspaceId,
      environmentId: _request.environmentId,
      mountPath: this.records.get(_request.workspaceId)?.worktreePath,
      attachedAt: new Date().toISOString(),
    };
  }

  async release(workspaceId: string): Promise<void> {
    const record = this.records.get(workspaceId);
    if (!record) {
      return;
    }

    record.refCount--;
    // Keep the worktree alive for the entire run — subsequent jobs of the same run
    // reuse it and see all accumulated changes (agent edits, build artifacts, etc.).
    // Startup reports retained worktrees. Explicit destroy() ends their lifetime.
    record.status = 'released';
  }

  async destroy(workspaceId: string): Promise<void> {
    const record = this.records.get(workspaceId);
    if (!record) {
      return;
    }

    try {
      await this.exec(`git worktree remove "${record.worktreePath}" --force`, record.repoRoot, TIMEOUTS.cleanup);
    } catch {
      if (existsSync(record.worktreePath)) {
        rmSync(record.worktreePath, { recursive: true, force: true });
      }
      try {
        await this.exec('git worktree prune', record.repoRoot, TIMEOUTS.cleanup);
      } catch { /* ignore */ }
    }

    this.records.delete(workspaceId);
  }

  async startupCleanup(projectRoot = this.configuredProjectRoot): Promise<WorkspaceCleanupResult[]> {
    if (!projectRoot) {
      return [];
    }
    const repoRoot = path.resolve(projectRoot);
    const worktreeBaseDir = path.resolve(repoRoot, this.worktreeDir);
    if (!existsSync(worktreeBaseDir)) {
      return [];
    }
    const preserved: WorkspaceCleanupResult[] = [];
    for (const entry of readdirSync(worktreeBaseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const worktreePath = path.join(worktreeBaseDir, entry.name);
      const status = await this.inspectWorktree(worktreePath);
      if (status === 'not-worktree') {
        continue;
      }

      // Git cleanliness cannot establish that a workflow has finished using this path.
      preserved.push({
        workspaceId: entry.name,
        status: 'preserved',
        path: worktreePath,
        reason: status,
      });
    }
    return preserved;
  }

  private async inspectWorktree(worktreePath: string): Promise<WorkspaceCleanupResult['reason'] | 'not-worktree'> {
    let topLevel: string;
    try {
      topLevel = (await this.exec('git rev-parse --show-toplevel', worktreePath, TIMEOUTS.cleanup)).trim();
    } catch {
      return 'status-unavailable';
    }
    if (path.resolve(topLevel) !== path.resolve(worktreePath)) {
      return 'not-worktree';
    }

    try {
      const status = await this.exec('git --no-optional-locks status --porcelain --untracked-files=all', worktreePath, TIMEOUTS.cleanup);
      return status.trim() ? 'dirty' : 'ownership-unverified';
    } catch {
      return 'status-unavailable';
    }
  }

  async getStatus(workspaceId: string): Promise<WorkspaceStatusResult> {
    const record = this.records.get(workspaceId);
    if (!record) {
      return { workspaceId, status: 'released', updatedAt: new Date().toISOString() };
    }

    const exists = existsSync(record.worktreePath);
    return {
      workspaceId,
      status: exists ? record.status : 'failed',
      updatedAt: record.createdAt,
    };
  }

  getCapabilities(): WorkspaceProviderCapabilities {
    return {
      supportsAttach: true,
      supportsRelease: true,
    };
  }

  /**
   * Symlink specific platform tool dist directories into the worktree.
   *
   * Only tool binaries that the agent should never rebuild are linked (e.g. the kb CLI).
   * Package dist/ directories that the agent may build are intentionally left absent so
   * agent builds write into the worktree, not the platform.
   *
   * Default tool paths to link (relative to platform root):
   *   cli/bin/dist  — makes `pnpm kb` resolve to the platform's compiled CLI binary
   */
  private async symlinkDistFromPlatform(worktreePath: string, platformRoot: string): Promise<void> {
    const toolDists = this.toolDistPaths;
    for (const relative of toolDists) {
      const platDist = path.join(platformRoot, relative);
      if (!existsSync(platDist)) continue;
      const worktreeDist = path.join(worktreePath, relative);
      if (!existsSync(worktreeDist)) {
        mkdirSync(path.dirname(worktreeDist), { recursive: true });
        try {
          symlinkSync(platDist, worktreeDist, 'dir');
        } catch {
          // ignore — another process may have raced us
        }
      }
    }
  }

  private symlinkEnvFromRoot(worktreePath: string, repoRoot: string): void {
    const rootEnv = path.join(repoRoot, '.env');
    if (!existsSync(rootEnv)) return;
    const worktreeEnv = path.join(worktreePath, '.env');
    if (existsSync(worktreeEnv)) return;
    try {
      symlinkSync(rootEnv, worktreeEnv);
    } catch {
      // ignore — another process may have raced us
    }
  }

  private async exec(command: string, cwd: string, timeout = 60_000): Promise<string> {
    const { stdout } = await execAsync(command, { cwd, encoding: 'utf8', timeout });
    return stdout;
  }
}

/**
 * Adapter factory — called by platform adapter loader.
 */
export function createAdapter(config: WorktreeWorkspaceAdapterConfig = {}): WorktreeWorkspaceAdapter {
  return new WorktreeWorkspaceAdapter(config);
}
