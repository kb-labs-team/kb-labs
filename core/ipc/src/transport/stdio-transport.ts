import type { AdapterCall, AdapterResponse } from '@kb-labs/core-platform/serializable';
import { isAdapterResponse } from '@kb-labs/core-platform/serializable';
import {
  type ITransport,
  type TransportConfig,
  type PendingRequest,
  TransportError,
  TimeoutError,
  createTransportAbortError,
} from './transport';
import { selectTimeout } from './timeout-config';
import type { StdioChannel } from './stdio-channel';

/** Platform RPC transport over the same framed stdio channel as execution control. */
export class StdioTransport implements ITransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pushHandlers = new Set<(msg: unknown) => void>();
  private readonly unsubscribeResponse: () => void;
  private readonly unsubscribePush: () => void;
  private closed = false;

  constructor(private readonly channel: StdioChannel, private readonly config: TransportConfig = {}) {
    this.unsubscribeResponse = channel.on('platform:response', (frame) => {
      if (!isAdapterResponse(frame.payload)) { return; }
      const pending = this.pending.get(frame.requestId);
      if (!pending) { return; }
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler!);
      this.pending.delete(frame.requestId);
      pending.resolve(frame.payload);
    });
    this.unsubscribePush = channel.on('platform:push', (frame) => {
      for (const handler of this.pushHandlers) { handler(frame.payload); }
    });
  }

  send(call: AdapterCall, signal?: AbortSignal): Promise<AdapterResponse> {
    if (signal?.aborted) { return Promise.reject(createTransportAbortError(signal)); }
    if (this.closed) { return Promise.reject(new TransportError('Transport is closed')); }
    const timeout = selectTimeout(call, this.config.timeout);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(call.requestId);
        pending.signal?.removeEventListener('abort', pending.abortHandler!);
        void this.channel.send({ type: 'platform:cancel', requestId: call.requestId }).catch(() => {});
        reject(new TimeoutError(`Adapter call timed out after ${timeout}ms`, timeout));
      }, timeout);
      const pending = { resolve, reject, timer, signal } as PendingRequest;
      if (signal) {
        pending.abortHandler = () => {
          if (this.pending.get(call.requestId) !== pending) { return; }
          clearTimeout(timer);
          this.pending.delete(call.requestId);
          void this.channel.send({ type: 'platform:cancel', requestId: call.requestId }).catch(() => {});
          reject(createTransportAbortError(signal));
        };
        signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(call.requestId, pending);
      this.channel.send({ type: 'platform:request', requestId: call.requestId, payload: call }).catch((error: unknown) => {
        const pending = this.pending.get(call.requestId);
        if (!pending) { return; }
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.abortHandler!);
        this.pending.delete(call.requestId);
        reject(new TransportError('Failed to send platform RPC frame', error instanceof Error ? error : undefined));
      });
    });
  }

  sendMessage(msg: unknown): void {
    if (this.closed) { return; }
    void this.channel.send({ type: 'platform:message', payload: msg });
  }

  onPushMessage(handler: (msg: unknown) => void): () => void {
    this.pushHandlers.add(handler);
    return () => { this.pushHandlers.delete(handler); };
  }

  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    this.unsubscribeResponse();
    this.unsubscribePush();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler!);
      pending.reject(new TransportError('Transport closed'));
    }
    this.pending.clear();
    this.pushHandlers.clear();
  }

  isClosed(): boolean { return this.closed; }
}
