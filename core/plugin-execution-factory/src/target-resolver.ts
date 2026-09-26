import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { ExecutionRequest, WorkspaceConfig } from './types.js';

type EnvironmentStatus = 'pending' | 'provisioning' | 'ready' | 'degraded' | 'terminating' | 'terminated' | 'failed';
type WorkspaceStatus = 'pending' | 'materializing' | 'ready' | 'attaching' | 'attached' | 'releasing' | 'released' | 'failed';

interface EnvironmentManagerLike {
  getEnvironmentStatus(environmentId: string): Promise<{ status: EnvironmentStatus }>;
}

interface WorkspaceManagerLike {
  getWorkspaceStatus(workspaceId: string): Promise<{ status: WorkspaceStatus }>;
}

type PlatformWithManagers = PlatformServices & {
  environmentManager?: EnvironmentManagerLike;
  workspaceManager?: WorkspaceManagerLike;
};

function getEnvironmentManager(platform: PlatformServices): EnvironmentManagerLike | undefined {
  return (platform as PlatformWithManagers).environmentManager;
}

function getWorkspaceManager(platform: PlatformServices): WorkspaceManagerLike | undefined {
  return (platform as PlatformWithManagers).workspaceManager;
}

async function tryResolveWorkspaceRootPath(workspaceId: string): Promise<string | undefined> {
  const registryFile = path.join(resolveRuntimeStatePath(process.cwd(), ['runtime', 'workspace-registry']), `${workspaceId}.json`);
  try {
    const raw = await readFile(registryFile, 'utf8');
    const parsed = JSON.parse(raw) as { rootPath?: string };
    if (typeof parsed.rootPath === 'string' && parsed.rootPath.length > 0) {
      return parsed.rootPath;
    }
  } catch {
    // best-effort lookup
  }
  return undefined;
}

function mergeWorkspace(base: WorkspaceConfig | undefined, updates: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    ...(base ?? {}),
    ...updates,
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function resolveExecutionTarget(
  request: ExecutionRequest,
  platform: PlatformServices
): Promise<ExecutionRequest> {
  const target = request.target;
  if (!target) {
    return request;
  }

  if (!target.namespace) {
    throw new Error('TARGET_INVALID: target.namespace is required');
  }

  const resolved: ExecutionRequest = {
    ...request,
    workspace: request.workspace ? { ...request.workspace } : undefined,
  };

  if (target.environmentId) {
    const environmentManager = getEnvironmentManager(platform);
    if (environmentManager) {
      const status = await environmentManager.getEnvironmentStatus(target.environmentId);
      if (status.status === 'terminated' || status.status === 'failed') {
        throw new Error(`ENVIRONMENT_NOT_AVAILABLE: environment '${target.environmentId}' status=${status.status}`);
      }
    }
  }

  if (target.workspaceId) {
    const workspaceManager = getWorkspaceManager(platform);
    if (workspaceManager) {
      const status = await workspaceManager.getWorkspaceStatus(target.workspaceId);
      if (status.status === 'failed' || status.status === 'released') {
        throw new Error(`WORKSPACE_NOT_AVAILABLE: workspace '${target.workspaceId}' status=${status.status}`);
      }
    }

    if (!resolved.workspace?.cwd) {
      const workspaceRootPath = await tryResolveWorkspaceRootPath(target.workspaceId);
      if (workspaceRootPath) {
        resolved.workspace = mergeWorkspace(resolved.workspace, {
          type: resolved.workspace?.type ?? 'local',
          cwd: workspaceRootPath,
        });
      }
    }
  }

  if (target.workdir) {
    resolved.workspace = mergeWorkspace(resolved.workspace, {
      type: resolved.workspace?.type ?? 'local',
      cwd: target.workdir,
    });
  }

  return resolved;
}

