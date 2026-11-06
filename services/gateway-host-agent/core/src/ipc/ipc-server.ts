/**
 * IpcServer — accepts IPC requests from CLI/Studio via ILocalTransport.
 * Transport is injected — caller picks unix socket, named pipe, or TCP.
 *
 * Execute requests are tunneled through GatewayClient:
 * CLI → IPC → IpcServer → GatewayClient HTTP → Gateway → Server
 *
 * Cancel requests forwarded to Gateway:
 * CLI → IPC → IpcServer → GatewayClient.cancelExecute() → Gateway REST
 */

import {
  IpcExecuteRequestSchema,
  IpcCancelRequestSchema,
  IpcStatusRequestSchema,
} from '@kb-labs/host-agent-contracts';
import type { IpcRequest, IpcExecuteRequest, IpcCancelRequest, IpcStatusResponse } from '@kb-labs/host-agent-contracts';
import type { ILocalTransport } from '@kb-labs/host-agent-transport';
import type { GatewayClient } from '../ws/gateway-client.js';

export interface IpcServerOptions {
  transport: ILocalTransport;
  /** Returns current connection status */
  getStatus: () => Omit<IpcStatusResponse, 'type'>;
  /** GatewayClient for tunneling execute requests */
  gatewayClient?: GatewayClient;
}

export class IpcServer {
  constructor(private readonly opts: IpcServerOptions) {}

  async start(): Promise<void> {
    this.opts.transport.onMessage((raw) => void this.handleMessage(raw));
    await this.opts.transport.listen();
  }

  stop(): void {
    this.opts.transport.close();
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const req = this.parseRequest(raw);
    if (!req) {
      console.warn('[ipc] Invalid IPC request schema:', JSON.stringify(raw).slice(0, 200));
      return;
    }

    if (req.type === 'status') {
      const status = this.opts.getStatus();
      this.opts.transport.send({ type: 'status', ...status });
      return;
    }

    if (req.type === 'cancel') {
      this.handleCancel(req);
      return;
    }

    // execute — tunnel through GatewayClient
    this.handleExecute(req);
  }

  private handleExecute(req: IpcExecuteRequest): void {
    const { gatewayClient } = this.opts;
    if (!gatewayClient) {
      this.opts.transport.send({
        type: 'error',
        requestId: req.requestId,
        code: 'NO_GATEWAY',
        message: 'GatewayClient not configured — cannot tunnel execute requests',
      });
      return;
    }

    gatewayClient.executeTunnel(
      req.requestId,
      req.command,
      req.params,
      {
        onEvent: (event) => {
          // Forward execution events to CLI via IPC
          this.opts.transport.send({
            type: 'event',
            requestId: req.requestId,
            data: event,
          });
        },
        onDone: (result) => {
          this.opts.transport.send({
            type: 'done',
            requestId: req.requestId,
            result,
          });
        },
        onError: (error) => {
          this.opts.transport.send({
            type: 'error',
            requestId: req.requestId,
            code: 'TUNNEL_ERROR',
            message: error.message,
          });
        },
      },
    );
  }

  private handleCancel(req: IpcCancelRequest): void {
    const { gatewayClient } = this.opts;
    if (!gatewayClient) {
      return; // Best-effort — nothing to cancel if no gateway
    }

    gatewayClient.cancelExecute(req.executionId, req.reason);
  }

  private parseRequest(raw: unknown): IpcRequest | null {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) { return null; }
    const type = (raw as Record<string, unknown>)['type'];
    if (type === 'status') { return IpcStatusRequestSchema.safeParse(raw).data ?? null; }
    if (type === 'execute') { return IpcExecuteRequestSchema.safeParse(raw).data ?? null; }
    if (type === 'cancel') { return IpcCancelRequestSchema.safeParse(raw).data ?? null; }
    return null;
  }
}
