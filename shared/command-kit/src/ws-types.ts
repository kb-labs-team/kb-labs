/**
 * Enhanced WebSocket types for better DX
 *
 * Provides type-safe message builders and pattern matching utilities.
 */

import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { WSSender, WSMessage } from '@kb-labs/plugin-contracts';

/**
 * Type-safe message builder
 *
 * @example
 * ```typescript
 * const Progress = defineMessage<{ phase: string; progress: number }>('progress');
 * const msg = Progress.create({ phase: 'analyzing', progress: 50 });
 * // msg: { type: 'progress', payload: { phase: 'analyzing', progress: 50 }, timestamp: number }
 * ```
 */
export class MessageBuilder<TPayload = unknown> {
  constructor(private type: string) {}

  /**
   * Create message with payload
   */
  create(payload: TPayload, messageId?: string): WSMessage {
    return {
      type: this.type,
      payload,
      messageId,
      timestamp: Date.now(),
    };
  }

  /**
   * Match against incoming message type (type guard)
   */
  is(message: WSMessage): message is WSMessage & { payload: TPayload } {
    return message.type === this.type;
  }
}

/**
 * Helper to define typed messages
 *
 * @example
 * ```typescript
 * const StartMsg = defineMessage<{ scope?: string }>('start');
 * const ProgressMsg = defineMessage<{ phase: string; progress: number }>('progress');
 * ```
 */
export function defineMessage<TPayload = unknown>(type: string) {
  return new MessageBuilder<TPayload>(type);
}

/**
 * Message router for pattern matching
 *
 * Provides elegant routing of incoming WebSocket messages to typed handlers.
 *
 * @example
 * ```typescript
 * const router = new MessageRouter()
 *   .on(StartMsg, async (ctx, payload, sender) => {
 *     // payload is typed as { scope?: string }
 *     console.log('Starting with scope:', payload.scope);
 *   })
 *   .on(StopMsg, async (ctx, payload, sender) => {
 *     // Different message type, different payload type
 *     sender.close(1000, 'Stopped by user');
 *   });
 *
 * await router.handle(ctx, message, sender);
 * ```
 */
export class MessageRouter<TConfig = unknown> {

  private handlers = new Map<string, (ctx: PluginContextV3<TConfig>, payload: any, sender: WSSender) => Promise<void> | void>();

  /**
   * Register message handler
   */
  on<TPayload>(
    message: MessageBuilder<TPayload>,
    handler: (ctx: PluginContextV3<TConfig>, payload: TPayload, sender: WSSender) => Promise<void> | void
  ): this {
    this.handlers.set(message['type'], handler);
    return this;
  }

  /**
   * Handle incoming message
   *
   * @returns true if message was handled, false otherwise
   */
  async handle(ctx: PluginContextV3<TConfig>, message: WSMessage, sender: WSSender): Promise<boolean> {
    const handler = this.handlers.get(message.type);
    if (handler) {
      await handler(ctx, message.payload, sender);
      return true;
    }
    return false;
  }
}
