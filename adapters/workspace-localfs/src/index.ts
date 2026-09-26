import { mkdir, access, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { randomUUID } from 'node:crypto';
import type {
  IWorkspaceProvider,
  MaterializeWorkspaceRequest,
  WorkspaceDescriptor,
  AttachWorkspaceRequest,
  WorkspaceAttachment,
  WorkspaceStatusResult,
  WorkspaceProviderCapabilities,
  WorkspaceStatus,
} from '@kb-labs/sdk/adapters';

export { manifest } from './manifest.js';

interface WorkspaceContext {
  cwd?: string;
}

export interface LocalFsWorkspaceAdapterConfig {
  rootDir?: string;
  registryDir?: string;
  workspace?: WorkspaceContext;
}

interface WorkspaceRecord {
  workspaceId: string;
  rootPath?: string;
  status: WorkspaceStatus;
  updatedAt: string;
}

function isFileSourceRef(sourceRef?: string): string | undefined {
  if (!sourceRef) {
    return undefined;
  }
  if (sourceRef.startsWith('file://')) {
    return sourceRef.slice('file://'.length);
  }
  if (sourceRef.startsWith('/') || sourceRef.startsWith('./') || sourceRef.startsWith('../')) {
    return sourceRef;
  }
  return undefined;
}

export class LocalFsWorkspaceAdapter implements IWorkspaceProvider {
  private readonly workspaceRoot: string;
  private readonly registryDir: string;
  private readonly workspaceCwd: string;
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(private readonly config: LocalFsWorkspaceAdapterConfig = {}) {
    this.workspaceCwd = path.resolve(config.workspace?.cwd ?? process.cwd());
    // No explicit dir: per-project runtime state lives outside the repository (ADR-0044).
    this.workspaceRoot = config.rootDir === undefined
      ? resolveRuntimeStatePath(this.workspaceCwd, ['runtime', 'workspaces'])
      : path.resolve(this.workspaceCwd, config.rootDir);
    this.registryDir = config.registryDir === undefined
      ? resolveRuntimeStatePath(this.workspaceCwd, ['runtime', 'workspace-registry'])
      : path.resolve(this.workspaceCwd, config.registryDir);
  }

  async materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor> {
    const workspaceId = request.workspaceId ?? `ws_${randomUUID()}`;
    const now = new Date().toISOString();

    const explicitPath = request.basePath ? path.resolve(this.workspaceCwd, request.basePath) : undefined;
    const sourcePath = isFileSourceRef(request.sourceRef)
      ? path.resolve(this.workspaceCwd, isFileSourceRef(request.sourceRef) as string)
      : undefined;

    const rootPath = explicitPath ?? sourcePath ?? path.join(this.workspaceRoot, workspaceId);

    await mkdir(rootPath, { recursive: true });

    const descriptor: WorkspaceDescriptor = {
      workspaceId,
      provider: 'workspace-localfs',
      status: 'ready',
      rootPath,
      createdAt: now,
      updatedAt: now,
      metadata: {
        sourceRef: request.sourceRef,
      },
    };

    await this.persistRecord({
      workspaceId,
      rootPath,
      status: descriptor.status,
      updatedAt: now,
    });

    return descriptor;
  }

  async attach(request: AttachWorkspaceRequest): Promise<WorkspaceAttachment> {
    const now = new Date().toISOString();
    const record = await this.getRecordOrThrow(request.workspaceId);

    record.status = 'attached';
    record.updatedAt = now;
    await this.persistRecord(record);

    return {
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      mountPath: request.mountPath ?? '/workspace',
      attachedAt: now,
      metadata: {
        rootPath: record.rootPath,
        readOnly: request.readOnly ?? false,
      },
    };
  }

  async release(workspaceId: string): Promise<void> {
    const now = new Date().toISOString();
    const record = await this.getRecordOrThrow(workspaceId);
    record.status = 'released';
    record.updatedAt = now;
    await this.persistRecord(record);
  }

  async getStatus(workspaceId: string): Promise<WorkspaceStatusResult> {
    const record = await this.getRecordOrThrow(workspaceId);
    return {
      workspaceId,
      status: record.status,
      updatedAt: record.updatedAt,
    };
  }

  getCapabilities(): WorkspaceProviderCapabilities {
    return {
      supportsAttach: true,
      supportsRelease: true,
      supportsReadOnlyMounts: true,
      custom: {
        provider: 'localfs',
      },
    };
  }

  private async persistRecord(record: WorkspaceRecord): Promise<void> {
    this.records.set(record.workspaceId, record);
    await mkdir(this.registryDir, { recursive: true });
    const filePath = path.join(this.registryDir, `${record.workspaceId}.json`);
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  }

  private async getRecordOrThrow(workspaceId: string): Promise<WorkspaceRecord> {
    const inMemory = this.records.get(workspaceId);
    if (inMemory) {
      return inMemory;
    }

    const filePath = path.join(this.registryDir, `${workspaceId}.json`);
    try {
      await access(filePath);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as WorkspaceRecord;
      this.records.set(workspaceId, parsed);
      return parsed;
    } catch {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
  }
}

export function createAdapter(config?: LocalFsWorkspaceAdapterConfig): LocalFsWorkspaceAdapter {
  return new LocalFsWorkspaceAdapter(config);
}

export default createAdapter;
