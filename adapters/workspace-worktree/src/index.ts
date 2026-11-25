import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportGitPatch, metadataEnvironment } from './export-patch.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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
  WorkspacePatchExport,
  WorkspacePatchExportRequest,
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
  ownerRunId?: string;
  /** Reference count — number of jobs currently using this workspace */
  refCount: number;
  repoRoot: string;
  worktreeBaseDir: string;
  baseCommit?: string;
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

  private assertWorkspaceId(workspaceId: string): void {
    if (!workspaceId || workspaceId === '.' || workspaceId === '..' || /[\\/\0]/.test(workspaceId)) {
      throw Object.assign(new Error('Workspace ID must be a single safe path segment'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
  }

  private assertOwnerRunId(ownerRunId: string): void {
    if (!ownerRunId || ownerRunId.length > 256 || /[\r\n\0]/.test(ownerRunId)) {
      throw Object.assign(new Error('Workspace owner run ID could not be verified'), {
        code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED',
      });
    }
  }

  private async resolveOwnerRoot(projectRoot: string): Promise<string> {
    try {
      return await realpath(path.resolve(projectRoot));
    } catch (cause) {
      throw Object.assign(new Error('Workspace owner project root could not be verified'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
        cause,
      });
    }
  }

  private async resolveOwnedWorktreeBase(repoRoot: string, create = false): Promise<string> {
    const basePath = path.resolve(repoRoot, this.worktreeDir);
    const configuredOutsideProject = path.isAbsolute(this.worktreeDir);
    if (!configuredOutsideProject && !this.isPathWithin(repoRoot, basePath)) {
      throw Object.assign(new Error('Workspace directory must remain inside its owning project'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    if (create) mkdirSync(basePath, { recursive: true });
    const actualBase = await realpath(basePath).catch((cause: unknown) => {
      throw Object.assign(new Error('Workspace directory could not be verified'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
        cause,
      });
    });
    if (!configuredOutsideProject && !this.isPathWithin(repoRoot, actualBase)) {
      throw Object.assign(new Error('Workspace directory resolves outside its owning project'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    return actualBase;
  }

  private isPathWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private async assertGitBelongsToOwner(projectRoot: string, worktreePath: string): Promise<void> {
    try {
      const commonDirFor = async (cwd: string): Promise<string> => {
        const commonDir = (await this.gitOutput(['rev-parse', '--git-common-dir'], cwd)).trim();
        return realpath(path.resolve(cwd, commonDir));
      };
      const [ownerCommonDir, worktreeCommonDir] = await Promise.all([
        commonDirFor(projectRoot),
        commonDirFor(worktreePath),
      ]);
      const worktreeGitDirRaw = (await this.gitOutput(['rev-parse', '--git-dir'], worktreePath)).trim();
      const worktreeGitDir = await realpath(path.resolve(worktreePath, worktreeGitDirRaw));
      const worktreeRoot = await realpath(worktreePath);
      const backpointer = (await readFile(path.join(worktreeGitDir, 'gitdir'), 'utf8')).trim();
      if (
        worktreeCommonDir !== ownerCommonDir
        || path.dirname(worktreeGitDir) !== path.join(ownerCommonDir, 'worktrees')
        || path.resolve(worktreeGitDir, backpointer) !== path.join(worktreeRoot, '.git')
      ) {
        throw new Error('Git worktree metadata does not belong to the trusted project');
      }
    } catch (cause) {
      throw Object.assign(new Error('Workspace Git metadata does not belong to the trusted project'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
        cause,
      });
    }
  }

  private async assertRecordOwner(
    record: WorktreeRecord,
    workspaceId: string,
    projectRoot: string,
    expectedWorktree: string,
    ownerRunId?: string,
    allowLegacy = false,
  ): Promise<void> {
    if (
      record.workspaceId !== workspaceId
      || path.resolve(record.repoRoot) !== projectRoot
      || path.resolve(record.worktreePath) !== expectedWorktree
      || path.resolve(record.worktreeBaseDir) !== path.dirname(expectedWorktree)
    ) {
      throw Object.assign(new Error('Workspace does not belong to the trusted project root and workspace ID'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    const persistedOwnerRunId = await this.readOwnerRunId(expectedWorktree);
    if (persistedOwnerRunId !== record.ownerRunId) {
      throw Object.assign(new Error('Workspace owner metadata does not match its Git worktree'), {
        code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED',
      });
    }
    if (record.ownerRunId !== ownerRunId && !(allowLegacy && !record.ownerRunId && !persistedOwnerRunId)) {
      throw Object.assign(new Error('Workspace owner run ID does not match the materialized workspace'), {
        code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED',
      });
    }
    const [actualRoot, gitTopLevel] = await Promise.all([
      realpath(expectedWorktree).catch(() => ''),
      this.gitOutput(['rev-parse', '--show-toplevel'], expectedWorktree)
        .then((value) => realpath(value.trim()))
        .catch(() => ''),
    ]);
    if (actualRoot !== expectedWorktree || gitTopLevel !== expectedWorktree) {
      throw Object.assign(new Error('Workspace Git root does not match the trusted owner'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    await this.assertGitBelongsToOwner(projectRoot, expectedWorktree);
    if (ownerRunId && persistedOwnerRunId && persistedOwnerRunId !== ownerRunId) {
      throw Object.assign(new Error('Workspace owner run ID does not match the materialized workspace'), {
        code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED',
      });
    }
  }

  async materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor> {
    const workspaceId = request.workspaceId ?? `wt_${randomUUID().slice(0, 8)}`;
    this.assertWorkspaceId(workspaceId);
    const branch = request.sourceRef ?? this.defaultBranch;
    const runId = request.ownerRunId ?? (request.metadata as Record<string, unknown>)?.runId as string | undefined;
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
    const repoRoot = await this.resolveOwnerRoot(projectRoot);
    const requestedBaseCommit = request.sourceRef
      ? await this.resolveSourceRef(request.sourceRef, repoRoot)
      : undefined;
    const worktreeBaseDir = await this.resolveOwnedWorktreeBase(repoRoot, true);

    const worktreePath = path.join(worktreeBaseDir, workspaceId);

    // Reuse existing worktree (retry scenario — same run, same workspace)
    if (existsSync(worktreePath)) {
      const existing = this.records.get(workspaceId);
      if (existing) {
        await this.assertRecordOwner(existing, workspaceId, repoRoot, worktreePath, runId, true);
        if (request.sourceRef) {
          if (!requestedBaseCommit) throw new Error('Workspace source ref did not resolve to a commit');
          this.assertRequestedBaseMatches(existing, requestedBaseCommit);
        }
        existing.refCount++;
        onProgress?.({ stage: 'reuse', message: 'Reusing existing worktree', progress: 100 });
        return {
          workspaceId,
          provider: 'worktree',
          status: 'ready',
          rootPath: worktreePath,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
          metadata: { branch, runId, repoRoot, reused: true, baseCommit: existing.baseCommit },
        };
      }
      // Worktree exists on disk but not in records (stale) — reuse anyway
      const recovered = await this.recoverRecord(workspaceId, repoRoot, worktreePath, runId, true);
      if (request.sourceRef) {
        if (!requestedBaseCommit) throw new Error('Workspace source ref did not resolve to a commit');
        this.assertRequestedBaseMatches(recovered, requestedBaseCommit);
      }
      onProgress?.({ stage: 'reuse', message: 'Reusing existing worktree (recovered)', progress: 100 });
      const now = recovered.createdAt;
      recovered.branch = branch;
      recovered.runId = runId;
      // Do not promote legacy worktrees to trusted ownership during recovery.
      recovered.refCount = 1;
      this.records.set(workspaceId, recovered);
      return {
        workspaceId,
        provider: 'worktree',
        status: 'ready',
        rootPath: worktreePath,
        createdAt: now,
        updatedAt: now,
        metadata: { branch, runId, repoRoot, reused: true, baseCommit: recovered.baseCommit },
      };
    }

    const progress = (stage: string, message: string, pct?: number) => {
      onProgress?.({ stage, message, progress: pct });
    };

    try {
      const baseCommitRef = requestedBaseCommit ?? await this.resolveSourceRef(branch, repoRoot);
      // Stage 1: Create worktree
      progress('worktree', `Creating worktree from ${safeBranch}...`, 10);
      await this.exec(
        `git worktree add --detach "${worktreePath}" ${baseCommitRef}`,
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

      const baseCommit = await this.persistBaseCommit(worktreePath);
      await this.persistOwnerRunId(worktreePath, runId);

      progress('ready', 'Workspace ready', 100);

      const record: WorktreeRecord = {
        workspaceId,
        worktreePath,
        branch,
        status: 'ready',
        createdAt: new Date().toISOString(),
        runId,
        ownerRunId: runId,
        refCount: 1,
        repoRoot,
        worktreeBaseDir,
        baseCommit,
      };
      this.records.set(workspaceId, record);

      return {
        workspaceId,
        provider: 'worktree',
        status: 'ready',
        rootPath: worktreePath,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        metadata: { branch, runId, repoRoot, platformRoot, baseCommit },
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

  async exportPatch(request: WorkspacePatchExportRequest): Promise<WorkspacePatchExport> {
    const { workspaceId, ownerRunId, workspaceRoot } = request;
    this.assertWorkspaceId(workspaceId);
    this.assertOwnerRunId(ownerRunId);
    const projectRoot = await this.resolveOwnerRoot(request.projectRoot);
    const worktreeBaseDir = await this.resolveOwnedWorktreeBase(projectRoot);
    const expectedWorktree = path.join(worktreeBaseDir, workspaceId);
    const claimedWorkspaceRoot = await realpath(path.resolve(workspaceRoot)).catch(() => '');
    if (claimedWorkspaceRoot !== expectedWorktree) {
      throw Object.assign(new Error('Workspace path does not match the trusted project root and workspace ID'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    let record = this.records.get(workspaceId);
    if (!record) {
      record = await this.recoverRecord(workspaceId, projectRoot, workspaceRoot, ownerRunId);
    } else {
      await this.assertRecordOwner(record, workspaceId, projectRoot, expectedWorktree, ownerRunId);
    }
    if (!record) {
      throw Object.assign(new Error('Workspace is not available for patch export'), {
        code: 'KB_WORKSPACE_PATCH_WORKSPACE_MISSING',
      });
    }

    const expectedRoot = await realpath(record.worktreePath).catch(() => '');
    const actualRoot = await this.gitOutput(['rev-parse', '--show-toplevel'], record.worktreePath)
      .then((value) => realpath(value.trim()))
      .catch(() => '');
    if (!expectedRoot || actualRoot !== expectedRoot) {
      throw Object.assign(new Error('Workspace Git root does not match the materialized workspace'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }

    const baseCommit = await this.readBaseCommit(record.worktreePath);
    if (!baseCommit || baseCommit !== record.baseCommit) {
      throw Object.assign(new Error('Workspace base commit metadata changed'), {
        code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
      });
    }

    return exportGitPatch(record.worktreePath, baseCommit, request.signal);
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
    const repoRoot = await this.resolveOwnerRoot(projectRoot);
    const configuredWorktreeBase = path.resolve(repoRoot, this.worktreeDir);
    if (!existsSync(configuredWorktreeBase)) {
      return [];
    }
    const worktreeBaseDir = await this.resolveOwnedWorktreeBase(repoRoot);
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
      supportsSourceRef: true,
    };
  }

  async resolveSourceRef(sourceRef: string, projectRoot: string): Promise<string> {
    const repoRoot = await this.resolveOwnerRoot(projectRoot);
    const commit = (await this.gitOutput(
      ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`],
      repoRoot,
    )).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) {
      throw new Error(`Workspace source ref did not resolve to a commit: ${sourceRef}`);
    }
    return commit;
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

  private async gitOutput(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUTS.cleanup,
      env: env ?? metadataEnvironment(),
    });
    return stdout;
  }

  private assertRequestedBaseMatches(record: WorktreeRecord, requestedBaseCommit: string): void {
    if (!record.baseCommit || record.baseCommit !== requestedBaseCommit) {
      throw Object.assign(
        new Error('The existing workspace base does not match the requested source ref.'),
        { code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH' },
      );
    }
  }

  private async persistBaseCommit(worktreePath: string): Promise<string> {
    const commit = (await this.gitOutput(['rev-parse', 'HEAD'], worktreePath)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) {
      throw new Error('Materialized workspace has an invalid base commit');
    }
    const gitDirRaw = (await this.gitOutput(['rev-parse', '--git-dir'], worktreePath)).trim();
    const gitDir = await realpath(path.resolve(worktreePath, gitDirRaw));
    await writeFile(path.join(gitDir, 'kb-workflow-base'), `${commit}\n`, { flag: 'wx', mode: 0o600 });
    return commit;
  }

  private async persistOwnerRunId(worktreePath: string, ownerRunId?: string): Promise<void> {
    if (!ownerRunId) return;
    this.assertOwnerRunId(ownerRunId);
    const gitDirRaw = (await this.gitOutput(['rev-parse', '--git-dir'], worktreePath)).trim();
    const gitDir = await realpath(path.resolve(worktreePath, gitDirRaw));
    await writeFile(path.join(gitDir, 'kb-workflow-owner-run'), `${ownerRunId}\n`, { flag: 'wx', mode: 0o600 });
  }

  private async readBaseCommit(worktreePath: string, allowMissing = false): Promise<string | undefined> {
    const gitDirRaw = (await this.gitOutput(['rev-parse', '--git-dir'], worktreePath)).trim();
    const gitDir = await realpath(path.resolve(worktreePath, gitDirRaw));
    let commit: string;
    try {
      commit = (await readFile(path.join(gitDir, 'kb-workflow-base'), 'utf8')).trim();
    } catch (cause) {
      if (allowMissing && (cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw Object.assign(new Error('Workspace base commit metadata is missing or invalid'), {
        code: 'KB_WORKSPACE_PATCH_BASE_MISSING',
        cause,
      });
    }
    if (!/^[a-f0-9]{40,64}$/.test(commit)) {
      throw Object.assign(new Error('Workspace base commit metadata is missing or invalid'), {
        code: 'KB_WORKSPACE_PATCH_BASE_MISSING',
      });
    }
    return commit;
  }

  private async readOwnerRunId(worktreePath: string): Promise<string | undefined> {
    const gitDirRaw = (await this.gitOutput(['rev-parse', '--git-dir'], worktreePath)).trim();
    const gitDir = await realpath(path.resolve(worktreePath, gitDirRaw));
    let ownerRunId: string;
    try {
      ownerRunId = (await readFile(path.join(gitDir, 'kb-workflow-owner-run'), 'utf8')).trim();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
    this.assertOwnerRunId(ownerRunId);
    return ownerRunId;
  }

  private async recoverRecord(
    workspaceId: string,
    projectRoot: string,
    workspaceRoot: string,
    ownerRunId?: string,
    allowLegacy = false,
  ): Promise<WorktreeRecord> {
    this.assertWorkspaceId(workspaceId);
    const repoRoot = await this.resolveOwnerRoot(projectRoot);
    const worktreeBaseDir = await this.resolveOwnedWorktreeBase(repoRoot);
    const expectedWorktree = path.join(worktreeBaseDir, workspaceId);
    const rootPath = await realpath(path.resolve(workspaceRoot)).catch(() => '');
    const actualWorkspaceRoot = await realpath(rootPath).catch(() => '');
    const gitTopLevel = rootPath
      ? await this.gitOutput(['rev-parse', '--show-toplevel'], rootPath)
        .then((value) => realpath(value.trim()))
        .catch(() => '')
      : '';
    if (
      rootPath !== expectedWorktree
      || actualWorkspaceRoot !== expectedWorktree
      || gitTopLevel !== expectedWorktree
    ) {
      throw Object.assign(new Error('Workspace Git root does not match the requested workspace ID'), {
        code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH',
      });
    }
    await this.assertGitBelongsToOwner(repoRoot, rootPath);
    const persistedOwnerRunId = await this.readOwnerRunId(rootPath);
    if (ownerRunId && persistedOwnerRunId !== ownerRunId && !(allowLegacy && !persistedOwnerRunId)) {
      throw Object.assign(new Error('Workspace owner could not be verified for patch export'), {
        code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED',
      });
    }
    const baseCommit = await this.readBaseCommit(rootPath, allowLegacy);
    const now = new Date().toISOString();
    const record: WorktreeRecord = {
      workspaceId,
      worktreePath: rootPath,
      branch: 'HEAD',
      status: 'ready',
      createdAt: now,
      runId: persistedOwnerRunId,
      ownerRunId: persistedOwnerRunId,
      refCount: 1,
      repoRoot,
      worktreeBaseDir,
      baseCommit,
    };
    this.records.set(workspaceId, record);
    return record;
  }
}

/**
 * Adapter factory — called by platform adapter loader.
 */
export function createAdapter(config: WorktreeWorkspaceAdapterConfig = {}): WorktreeWorkspaceAdapter {
  return new WorktreeWorkspaceAdapter(config);
}
