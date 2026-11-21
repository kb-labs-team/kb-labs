import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { StdioChannel } from '../transport/stdio-channel';
import { PlatformRPCDispatcher } from './platform-rpc-dispatcher';

/** Serves platform RPC over the child stdio control stream. */
export class StdioPlatformServer {
  private readonly dispatcher: PlatformRPCDispatcher;
  private readonly unsubscribeRequest: () => void;
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeCancel: () => void;

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
    this.unsubscribeRequest = channel.on('platform:request', (frame) => {
      void this.dispatcher.dispatch(frame.payload);
    });
    this.unsubscribeMessage = channel.on('platform:message', (frame) => {
      void this.dispatcher.dispatch(frame.payload);
    });
    this.unsubscribeCancel = channel.on('platform:cancel', (frame) => {
      void this.dispatcher.dispatch({ type: 'adapter:cancel', requestId: frame.requestId });
    });
  }

  close(): void {
    this.unsubscribeRequest();
    this.unsubscribeMessage();
    this.unsubscribeCancel();
    this.dispatcher.close();
  }
}
