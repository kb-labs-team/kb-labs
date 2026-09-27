import { mkdir, readFile, rm, writeFile, access, cp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { randomUUID } from 'node:crypto';
import type {
  ISnapshotProvider,
  CaptureSnapshotRequest,
  SnapshotDescriptor,
  RestoreSnapshotRequest,
  RestoreSnapshotResult,
  SnapshotStatusResult,
  SnapshotGarbageCollectRequest,
  SnapshotGarbageCollectResult,
  SnapshotProviderCapabilities,
  SnapshotStatus,
} from '@kb-labs/sdk/adapters';

export { manifest } from './manifest.js';

interface WorkspaceContext {
  cwd?: string;
}

export interface LocalFsSnapshotAdapterConfig {
  storageDir?: string;
  workspaceRegistryDir?: string;
  workspace?: WorkspaceContext;
}

interface SnapshotRecord {
  snapshotId: string;
  status: SnapshotStatus;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  environmentId?: string;
  sourcePath: string;
  payloadPath: string;
  namespace?: string;
}

interface WorkspaceRecord {
  workspaceId: string;
  rootPath?: string;
}

export class LocalFsSnapshotAdapter implements ISnapshotProvider {
  private readonly cwd: string;
  private readonly storageDir: string;
  private readonly workspaceRegistryDir: string;
  private readonly records = new Map<string, SnapshotRecord>();

  constructor(private readonly config: LocalFsSnapshotAdapterConfig = {}) {
    this.cwd = path.resolve(config.workspace?.cwd ?? process.cwd());
    // No explicit dir: per-project runtime state lives outside the repository (ADR-0044).
    this.storageDir = config.storageDir === undefined
      ? resolveRuntimeStatePath(this.cwd, ['runtime', 'snapshots'])
      : path.resolve(this.cwd, config.storageDir);
    this.workspaceRegistryDir = config.workspaceRegistryDir === undefined
      ? resolveRuntimeStatePath(this.cwd, ['runtime', 'workspace-registry'])
      : path.resolve(this.cwd, config.workspaceRegistryDir);
  }

  async capture(request: CaptureSnapshotRequest): Promise<SnapshotDescriptor> {
    const snapshotId = request.snapshotId ?? `snap_${randomUUID()}`;
    const now = new Date().toISOString();
    const sourcePath = await this.resolveSourcePath(request);
    const namespace = request.namespace ?? 'default';
    const payloadPath = path.join(this.storageDir, namespace, snapshotId);

    await mkdir(path.dirname(payloadPath), { recursive: true });
    await rm(payloadPath, { recursive: true, force: true });
    await cp(sourcePath, payloadPath, { recursive: true, force: true });

    const record: SnapshotRecord = {
      snapshotId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      sourcePath,
      payloadPath,
      namespace,
    };

    await this.persistRecord(record);

    return {
      snapshotId,
      provider: 'snapshot-localfs',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      metadata: {
        namespace,
        payloadPath,
      },
    };
  }

  async restore(request: RestoreSnapshotRequest): Promise<RestoreSnapshotResult> {
    const record = await this.getRecordOrThrow(request.snapshotId);
    const now = new Date().toISOString();

    const targetPath = request.targetPath
      ? path.resolve(this.cwd, request.targetPath)
      : await this.resolveRestoreTargetPath(request.workspaceId, record.workspaceId);

    if (!request.overwrite) {
      try {
        await access(targetPath);
        throw new Error(`Restore target already exists: ${targetPath}. Use overwrite=true.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Restore target already exists')) {
          throw error;
        }
        // path missing, continue
      }
    }

    if (request.overwrite) {
      await rm(targetPath, { recursive: true, force: true });
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(record.payloadPath, targetPath, { recursive: true, force: true });

    record.status = 'ready';
    record.updatedAt = now;
    await this.persistRecord(record);

    return {
      snapshotId: request.snapshotId,
      restoredAt: now,
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      targetPath,
    };
  }

  async getStatus(snapshotId: string): Promise<SnapshotStatusResult> {
    const record = await this.getRecordOrThrow(snapshotId);
    return {
      snapshotId,
      status: record.status,
      updatedAt: record.updatedAt,
    };
  }

  async delete(snapshotId: string): Promise<void> {
    const record = await this.getRecordOrThrow(snapshotId);
    await rm(record.payloadPath, { recursive: true, force: true });
    this.records.delete(snapshotId);
    await rm(this.getRecordPath(snapshotId), { force: true });
  }

  async garbageCollect(
    request: SnapshotGarbageCollectRequest = {}
  ): Promise<SnapshotGarbageCollectResult> {
    const beforeTs = request.before ? new Date(request.before).getTime() : Number.POSITIVE_INFINITY;
    const limit = request.limit ?? Number.POSITIVE_INFINITY;
    const dryRun = request.dryRun ?? false;
    let scanned = 0;
    let deleted = 0;

    for (const record of await this.loadAllRecords()) {
      scanned += 1;
      const createdTs = new Date(record.createdAt).getTime();
      if (createdTs >= beforeTs) {
        continue;
      }
      if (request.namespace && record.namespace !== request.namespace) {
        continue;
      }
      if (deleted >= limit) {
        break;
      }

      if (!dryRun) {
        await this.delete(record.snapshotId);
      }
      deleted += 1;
    }

    return { scanned, deleted, dryRun };
  }

  getCapabilities(): SnapshotProviderCapabilities {
    return {
      supportsWorkspaceSnapshots: true,
      supportsEnvironmentSnapshots: false,
      supportsGarbageCollection: true,
      supportsIncrementalSnapshots: false,
      custom: {
        provider: 'localfs',
      },
    };
  }

  private async resolveSourcePath(request: CaptureSnapshotRequest): Promise<string> {
    if (request.sourcePath) {
      return path.resolve(this.cwd, request.sourcePath);
    }

    if (request.workspaceId) {
      const workspace = await this.readWorkspaceRecord(request.workspaceId);
      if (workspace.rootPath) {
        return workspace.rootPath;
      }
    }

    throw new Error('Snapshot capture requires sourcePath or resolvable workspaceId');
  }

  private async resolveRestoreTargetPath(
    requestedWorkspaceId?: string,
    recordWorkspaceId?: string
  ): Promise<string> {
    const workspaceId = requestedWorkspaceId ?? recordWorkspaceId;
    if (!workspaceId) {
      throw new Error('Snapshot restore requires targetPath or workspaceId');
    }
    const workspace = await this.readWorkspaceRecord(workspaceId);
    if (!workspace.rootPath) {
      throw new Error(`Workspace rootPath not found for workspaceId=${workspaceId}`);
    }
    return workspace.rootPath;
  }

  private getRecordPath(snapshotId: string): string {
    return path.join(this.storageDir, '.records', `${snapshotId}.json`);
  }

  private async persistRecord(record: SnapshotRecord): Promise<void> {
    this.records.set(record.snapshotId, record);
    const recordPath = this.getRecordPath(record.snapshotId);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8');
  }

  private async getRecordOrThrow(snapshotId: string): Promise<SnapshotRecord> {
    const inMemory = this.records.get(snapshotId);
    if (inMemory) {
      return inMemory;
    }

    const recordPath = this.getRecordPath(snapshotId);
    try {
      const raw = await readFile(recordPath, 'utf8');
      const parsed = JSON.parse(raw) as SnapshotRecord;
      this.records.set(snapshotId, parsed);
      return parsed;
    } catch {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
  }

  private async readWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    const filePath = path.join(this.workspaceRegistryDir, `${workspaceId}.json`);
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as WorkspaceRecord;
  }

  private async loadAllRecords(): Promise<SnapshotRecord[]> {
    const recordsDir = path.join(this.storageDir, '.records');
    try {
      const entries = await readdir(recordsDir);
      const loaded: SnapshotRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(recordsDir, entry);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          continue;
        }
        const raw = await readFile(filePath, 'utf8');
        loaded.push(JSON.parse(raw) as SnapshotRecord);
      }
      return loaded;
    } catch {
      return [];
    }
  }
}

export function createAdapter(config?: LocalFsSnapshotAdapterConfig): LocalFsSnapshotAdapter {
  return new LocalFsSnapshotAdapter(config);
}

export default createAdapter;
