/**
 * @module cli-core/gateway/host-agent-transport
 *
 * Transport through Host Agent IPC.
 * Used when CLI and Host Agent are on the same host,
 * and Gateway is on a remote server.
 *
 * CLI → IPC (unix socket) → Host Agent → WS → Gateway → Server
 */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ExecutionEvent } from '@kb-labs/core-contracts';
import { createErrorEnvelope, ErrorEnvelopeError, toErrorEnvelope } from '@kb-labs/core-platform';
import type { IGatewayClient, GatewayExecuteRequest } from '@kb-labs/sdk/gateway';

function hostAgentUnavailable(socketPath: string): ErrorEnvelopeError {
  return new ErrorEnvelopeError(createErrorEnvelope('KB_HOST_UNREACHABLE', {
    details: { address: socketPath },
    cause: 'The CLI could not connect to the local Host Agent IPC socket.',
  }));
}

export class HostAgentTransport implements IGatewayClient {
  private socket: net.Socket | null = null;

  constructor(private readonly socketPath: string) {}

  async *execute(request: GatewayExecuteRequest): AsyncIterable<ExecutionEvent> {
    const requestId = randomUUID();
    const socket = await this.connect();

    // Send execute request
    const ipcRequest = {
      type: 'execute',
      requestId,
      command: `${request.pluginId}:${request.handlerRef}`,
      params: {
        exportName: request.exportName,
        input: request.input,
        timeoutMs: request.timeoutMs,
      },
      stream: true,
    };
    socket.write(JSON.stringify(ipcRequest) + '\n');

    // Read ndjson events from socket
    let buffer = '';
    const events: ExecutionEvent[] = [];
    let done = false;
    let error: Error | null = null;

    const eventPromises: {
      resolve: (value: IteratorResult<ExecutionEvent>) => void;
      reject: (err: Error) => void;
    }[] = [];

    // eslint-disable-next-line sonarjs/cognitive-complexity
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {continue;}

        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;

          if (msg.type === 'event' && msg.requestId === requestId) {
            const event = msg.data as ExecutionEvent;
            if (eventPromises.length > 0) {
              eventPromises.shift()!.resolve({ value: event, done: false });
            } else {
              events.push(event);
            }
          } else if (msg.type === 'done' && msg.requestId === requestId) {
            // Forward final event from result
            const result = msg.result as Record<string, unknown> | undefined;
            if (result && typeof result.type === 'string' && result.type.startsWith('execution:')) {
              const event = result as unknown as ExecutionEvent;
              if (eventPromises.length > 0) {
                eventPromises.shift()!.resolve({ value: event, done: false });
              } else {
                events.push(event);
              }
            }
            done = true;
            // Signal completion
            if (eventPromises.length > 0) {
              eventPromises.shift()!.resolve({ value: undefined as unknown as ExecutionEvent, done: true });
            }
          } else if (msg.type === 'error' && msg.requestId === requestId) {
            error = new ErrorEnvelopeError(toErrorEnvelope(msg));
            done = true;
            if (eventPromises.length > 0) {
              eventPromises.shift()!.reject(error);
            }
          }
        } catch {
          // Ignore malformed lines
        }
      }
    };

    const onError = (err: Error) => {
      error = err;
      done = true;
      if (eventPromises.length > 0) {
        eventPromises.shift()!.reject(err);
      }
    };

    const onEnd = () => {
      done = true;
      if (eventPromises.length > 0) {
        eventPromises.shift()!.resolve({ value: undefined as unknown as ExecutionEvent, done: true });
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);

    try {
      while (true) {
        // Yield buffered events first
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }

        if (done) {
          if (error) {throw error;}
          return;
        }

        // Wait for next event
        const result = await new Promise<IteratorResult<ExecutionEvent>>((resolve, reject) => {
          eventPromises.push({ resolve, reject });
        });

        if (result.done) {return;}
        yield result.value;
      }
    } finally {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
    }
  }

  async cancel(executionId: string, reason?: string): Promise<void> {
    if (!this.socket || this.socket.destroyed) { return; }
    this.socket.write(JSON.stringify({
      type: 'cancel',
      executionId,
      reason: reason ?? 'user',
    }) + '\n');
  }

  async *subscribe(_executionId: string): AsyncIterable<ExecutionEvent> {
    throw new Error('subscribe not supported via Host Agent IPC transport');
  }

  async ping(): Promise<boolean> {
    try {
      const socket = await this.connect();
      socket.write(JSON.stringify({ type: 'status' }) + '\n');

      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        socket.once('data', (data) => {
          clearTimeout(timeout);
          try {
            const msg = JSON.parse(data.toString().trim()) as Record<string, unknown>;
            resolve(msg.type === 'status' && msg.connected === true);
          } catch {
            resolve(false);
          }
        });
      });
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath }, () => {
        this.socket = socket;
        resolve(socket);
      });
      socket.on('error', () => reject(hostAgentUnavailable(this.socketPath)));
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(hostAgentUnavailable(this.socketPath));
      });
    });
  }
}
