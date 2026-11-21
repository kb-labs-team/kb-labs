import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { AdapterCall, AdapterResponse, SerializableError } from '@kb-labs/core-platform/serializable';
import {
  isAdapterCall,
  isEventBusSubscribe,
  isEventBusUnsubscribe,
  serialize,
  deserialize,
} from '@kb-labs/core-platform/serializable';
import { resolveIPCAdapter } from './adapter-route';

function serializeError(error: unknown): SerializableError {
  return serialize(error) as SerializableError;
}

/** Owns adapter authorization, dispatch, and event-bus message handling. */
export class PlatformRPCDispatcher {
  private readonly eventBusSubs = new Map<string, () => void>();
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly platform: IPlatformAdapters,
    private readonly send: (message: Record<string, unknown>) => void | Promise<void>,
  ) {}

  async dispatch(message: unknown): Promise<void> {
    if (typeof message === 'object' && message !== null
      && 'type' in message && message.type === 'adapter:cancel'
      && 'requestId' in message && typeof message.requestId === 'string') {
      this.inFlight.get(message.requestId)?.abort();
      return;
    }

    if (isEventBusSubscribe(message)) {
      if (!this.platform.eventBus) { return; }
      const { subscriptionId, topic } = message;
      const unsubscribe = this.platform.eventBus.subscribe(topic, async (payload) => {
        await this.send({ type: 'eventbus:push', subscriptionId, topic, payload: serialize(payload) });
      });
      this.eventBusSubs.set(subscriptionId, unsubscribe);
      return;
    }

    if (isEventBusUnsubscribe(message)) {
      this.eventBusSubs.get(message.subscriptionId)?.();
      this.eventBusSubs.delete(message.subscriptionId);
      return;
    }

    if (!isAdapterCall(message)) { return; }
    const permissionError = this.checkPermission(message);
    if (permissionError) {
      await this.send({
        type: 'adapter:response',
        requestId: message.requestId,
        error: serializeError(permissionError),
      } satisfies AdapterResponse);
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(message.requestId, controller);
    try {
      const adapter = resolveIPCAdapter(this.platform, message.adapter);
      const method = (adapter as Record<string, unknown>)[message.method];
      if (typeof method !== 'function') {
        throw new Error(`Method '${message.method}' not found on adapter '${message.adapter}'`);
      }
      const args = message.args.map((arg) => deserialize(arg));
      if (message.adapter === 'llm' && (message.method === 'complete' || message.method === 'chatWithTools')) {
        const optionsIndex = 1;
        const options = args[optionsIndex];
        args[optionsIndex] = { ...(options && typeof options === 'object' ? options as Record<string, unknown> : {}), signal: controller.signal };
      }
      const result = await method.apply(adapter, args);
      await this.send({
        type: 'adapter:response',
        requestId: message.requestId,
        result: serialize(result),
      } satisfies AdapterResponse);
    } catch (error) {
      await this.send({
        type: 'adapter:response',
        requestId: message.requestId,
        error: serializeError(error),
      } satisfies AdapterResponse);
    } finally {
      this.inFlight.delete(message.requestId);
    }
  }

  close(): void {
    for (const unsubscribe of this.eventBusSubs.values()) { unsubscribe(); }
    for (const controller of this.inFlight.values()) { controller.abort(); }
    this.inFlight.clear();
    this.eventBusSubs.clear();
  }

  private checkPermission(call: AdapterCall): Error | undefined {
    const allowedAdapters = call.context?.permissions?.adapters;
    if (!allowedAdapters || allowedAdapters.includes(call.adapter)) { return undefined; }
    return new Error(
      `Permission denied: adapter '${call.adapter}' not allowed. Allowed: ${allowedAdapters.join(', ')}`,
    );
  }
}
