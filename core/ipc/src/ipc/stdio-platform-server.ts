import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { StdioChannel } from '../transport/stdio-channel';
import { PlatformRPCDispatcher } from './platform-rpc-dispatcher';

/** Serves platform RPC over the child stdio control stream. */
export class StdioPlatformServer {
  private readonly dispatcher: PlatformRPCDispatcher;
  private readonly unsubscribeRequest: () => void;
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeCancel: () => void;
  private readonly dispatches = new Set<Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly channel: StdioChannel, platform: IPlatformAdapters) {
    this.dispatcher = new PlatformRPCDispatcher(platform, async (message) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        throw new Error('Platform RPC dispatcher emitted an invalid message');
      }
      const value = message as { type: unknown; requestId?: unknown };
      if (value.type === 'adapter:response' && typeof value.requestId === 'string') {
        await channel.send({ type: 'platform:response', requestId: value.requestId, payload: message });
        return;
      }
      if (value.type === 'eventbus:push') {
        await channel.send({ type: 'platform:push', payload: message });
        return;
      }
      throw new Error('Platform RPC dispatcher emitted an unsupported message');
    });
    this.unsubscribeRequest = channel.on('platform:request', (frame) => this.dispatch(frame.payload));
    this.unsubscribeMessage = channel.on('platform:message', (frame) => this.dispatch(frame.payload));
    this.unsubscribeCancel = channel.on('platform:cancel', (frame) => {
      this.dispatch({ type: 'adapter:cancel', requestId: frame.requestId });
    });
  }

  async close(graceMs = 1000): Promise<void> {
    if (this.closePromise) { await this.closePromise; return; }
    this.closed = true;
    this.unsubscribeRequest();
    this.unsubscribeMessage();
    this.unsubscribeCancel();
    this.dispatcher.close();
    const active = Promise.allSettled([...this.dispatches]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.closePromise = Promise.race([active, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })])
      .finally(() => clearTimeout(timer));
    await this.closePromise;
  }

  private dispatch(payload: unknown): void {
    const operation = this.dispatcher.dispatch(payload)
      .catch(() => {})
      .finally(() => this.dispatches.delete(operation));
    this.dispatches.add(operation);
  }
}
