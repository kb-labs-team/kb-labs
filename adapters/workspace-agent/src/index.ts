/**
 * @module @kb-labs/adapters-workspace-agent
 *
 * IWorkspaceProvider implementation that materializes workspaces by fetching
 * files from a local machine via Host Agent connected to the Gateway.
 *
 * Usage in kb.config.json (cloud mode):
 *   "platform": {
 *     "adapters": {
 *       "workspace": "@kb-labs/adapters-workspace-agent"
 *     },
 *     "adapterOptions": {
 *       "workspace": {
 *         "gatewayUrl": "http://localhost:4000",
 *         "namespaceId": "default",
 *         "cacheDir": ".kb/runtime/workspaces"
 *       }
 *     }
 *   }
 *
 * The adapter calls filesystem.fetchWorkspace on the connected Host Agent
 * via Gateway's /internal/dispatch endpoint, writes files to a local cache
 * dir, and returns a WorkspaceDescriptor with rootPath pointing to that cache.
 * From that point on, workflow workers and Docker environments use rootPath
 * as a normal local directory — no knowledge of remote origin.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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

export interface AgentWorkspaceAdapterConfig {
  /** Gateway base URL. Default: 'http://localhost:4000' */
  gatewayUrl?: string;
  /** Shared secret for /internal/dispatch. Read from GATEWAY_INTERNAL_SECRET env if omitted. */
  internalSecret?: string;
  /** Gateway namespace to find the host agent in. Default: 'default' */
  namespaceId?: string;
  /** Local directory where fetched workspaces are cached. Default: `<KB_HOME>/state/<projectId>/runtime/workspaces` */
  cacheDir?: string;
  /** Specific hostId to use. If omitted, Gateway picks first connected host in namespace. */
  hostId?: string;
}

interface WorkspaceRecord {
  workspaceId: string;
  rootPath: string;
  status: WorkspaceStatus;
  updatedAt: string;
}

export class AgentWorkspaceAdapter implements IWorkspaceProvider {
  private readonly gatewayUrl: string;
  private readonly internalSecret: string;
  private readonly namespaceId: string;
  private readonly cacheDir: string;
  private readonly hostId?: string;
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(config: AgentWorkspaceAdapterConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    this.internalSecret = config.internalSecret ?? process.env['GATEWAY_INTERNAL_SECRET'] ?? '';
    this.namespaceId = config.namespaceId ?? 'default';
    // No explicit dir: per-project runtime state lives outside the repository (ADR-0044).
    this.cacheDir = config.cacheDir ?? resolveRuntimeStatePath(process.cwd(), ['runtime', 'workspaces']);
    this.hostId = config.hostId;
  }

  async materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor> {
    const workspaceId = request.workspaceId ?? `ws_${randomUUID()}`;
    const now = new Date().toISOString();

    // Determine which path to fetch from the agent
    const remotePath = request.basePath ?? request.sourceRef ?? '.';

    // Call filesystem.fetchWorkspace via Gateway /internal/dispatch
    const files = await this.dispatch('filesystem', 'fetchWorkspace', [remotePath]) as Array<{ path: string; content: string }>;

    if (!Array.isArray(files)) {
      throw new Error(`AgentWorkspaceAdapter: expected array of files from fetchWorkspace, got ${typeof files}`);
    }

    // Write files to local cache
    const rootPath = join(this.cacheDir, workspaceId);
    await mkdir(rootPath, { recursive: true });

    for (const file of files) {
      const dest = join(rootPath, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf-8');
    }

    const descriptor: WorkspaceDescriptor = {
      workspaceId,
      provider: 'workspace-agent',
      status: 'ready',
      rootPath,
      createdAt: now,
      updatedAt: now,
      metadata: {
        sourceRef: request.sourceRef,
        remotePath,
        namespaceId: this.namespaceId,
        fileCount: files.length,
      },
    };

    this.records.set(workspaceId, {
      workspaceId,
      rootPath,
      status: 'ready',
      updatedAt: now,
    });

    return descriptor;
  }

  async attach(request: AttachWorkspaceRequest): Promise<WorkspaceAttachment> {
    const now = new Date().toISOString();
    const record = this.getRecordOrThrow(request.workspaceId);
    record.status = 'attached';
    record.updatedAt = now;

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
    const record = this.records.get(workspaceId);
    if (record) {
      record.status = 'released';
      record.updatedAt = new Date().toISOString();
    }
    // Cached files kept on disk — GC handled separately
  }

  async getStatus(workspaceId: string): Promise<WorkspaceStatusResult> {
    const record = this.getRecordOrThrow(workspaceId);
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
        provider: 'agent',
        remote: true,
      },
    };
  }

  /**
   * Call an adapter method on the connected Host Agent via Gateway /internal/dispatch.
   */
  private async dispatch(adapter: string, method: string, args: unknown[]): Promise<unknown> {
    const url = `${this.gatewayUrl}/internal/dispatch`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': this.internalSecret,
      },
      body: JSON.stringify({
        namespaceId: this.namespaceId,
        hostId: this.hostId,
        adapter,
        method,
        args,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `AgentWorkspaceAdapter: dispatch failed (${response.status}): ${text}`,
      );
    }

    const json = await response.json() as { result: unknown };
    return json.result;
  }

  private getRecordOrThrow(workspaceId: string): WorkspaceRecord {
    const record = this.records.get(workspaceId);
    if (!record) { throw new Error(`Workspace not found: ${workspaceId}`); }
    return record;
  }
}

export function createAdapter(config?: AgentWorkspaceAdapterConfig): AgentWorkspaceAdapter {
  return new AgentWorkspaceAdapter(config);
}

export default createAdapter;
