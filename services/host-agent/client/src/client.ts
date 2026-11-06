/**
 * HostAgentClient — connects to the Host Agent daemon via ILocalTransport
 * and provides typed methods for CLI/Studio.
 *
 * Usage:
 *   const client = new HostAgentClient({ transport: createTransport({ mode: 'auto' }) });
 *   await client.connect();
 *   const status = await client.status();
 *   for await (const event of client.execute('workflow:run', { workflowId: 'x' })) { ... }
 *   client.close();
 */

import type { ILocalTransport } from '@kb-labs/host-agent-transport';
import type { IpcStatusResponse } from '@kb-labs/host-agent-contracts';

export interface HostAgentClientOptions {
  transport: ILocalTransport;
  /** ms to wait for a response before rejecting (default: 10_000) */
  requestTimeout?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  events: ((event: unknown) => void) | null;
  timer: ReturnType<typeof setTimeout>;
}

export class HostAgentClient {
  private readonly timeout: number;
  private pending = new Map<string, PendingRequest>();
  private connected = false;

  constructor(private readonly opts: HostAgentClientOptions) {
    this.timeout = opts.requestTimeout ?? 10_000;
  }

  async connect(): Promise<void> {
    this.opts.transport.onMessage((msg) => this.handleMessage(msg));
    await this.opts.transport.connect();
    this.connected = true;
  }

  close(): void {
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('HostAgentClient closed'));
    }
    this.pending.clear();
    this.opts.transport.close();
  }

  /** Query daemon status */
  async status(): Promise<Omit<IpcStatusResponse, 'type'>> {
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('status request timed out'));
      }, this.timeout);

      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, events: null, timer });
      this.opts.transport.send({ type: 'status', requestId });
    }) as Promise<Omit<IpcStatusResponse, 'type'>>;
  }

  /**
   * Execute a command on the daemon and stream events back.
   * Yields event payloads until done or error.
   */
  async *execute(command: string, params: unknown = {}): AsyncGenerator<unknown> {
    const requestId = randomId();
    const queue: unknown[] = [];
    let done = false;
    let error: Error | null = null;
    let notify: (() => void) | null = null;

    const push = (item: unknown): void => {
      queue.push(item);
      notify?.();
    };

    const timer = setTimeout(() => {
      error = new Error(`execute '${command}' timed out`);
      done = true;
      notify?.();
    }, this.timeout);

    this.pending.set(requestId, {
      resolve: () => { done = true; notify?.(); },
      reject: (err) => { error = err; done = true; notify?.(); },
      events: push,
      timer,
    });

    this.opts.transport.send({ type: 'execute', requestId, command, params });

    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    if (error) { throw error; }
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) { return; }
    const m = msg as Record<string, unknown>;

    // Status response (requestId optional on status)
    if (m['type'] === 'status') {
      // Find any pending status request
      for (const [id, pending] of this.pending) {
        if (pending.events === null) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(m);
          return;
        }
      }
      return;
    }

    const requestId = typeof m['requestId'] === 'string' ? m['requestId'] : null;
    if (!requestId) { return; }
    const pending = this.pending.get(requestId);
    if (!pending) { return; }

    if (m['type'] === 'event') {
      pending.events?.(m['data']);
    } else if (m['type'] === 'done') {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(m['result']);
    } else if (m['type'] === 'error') {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(typeof m['message'] === 'string' ? m['message'] : 'Unknown error'));
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
