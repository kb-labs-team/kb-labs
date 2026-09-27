/**
 * @module @kb-labs/core-ipc/ipc/child-ipc-server
 *
 * IPC server for handling adapter calls from a specific child process.
 *
 * Unlike IPCServer (which listens on `process.on('message')`), ChildIPCServer
 * listens on `child.on('message')` — designed for worker-pool where the parent
 * is the main process managing multiple child workers.
 *
 * Includes Layer 2 permission enforcement: checks `call.context.permissions`
 * before dispatching to real adapters. Stateless — permissions travel with each call.
 */

import type { ChildProcess } from 'node:child_process';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { AdapterCall, AdapterResponse, SerializableError } from '@kb-labs/core-platform/serializable';
import {
  isAdapterCall,
  isAdapterCancel,
  isEventBusSubscribe,
  isEventBusUnsubscribe,
  serialize,
  deserialize,
} from '@kb-labs/core-platform/serializable';
import { resolveIPCAdapter } from './adapter-route.js';
import { attachLlmCallAbortSignal } from './llm-call-signal.js';

/**
 * Serialize an Error (or any value) to SerializableError for IPC response.
 * `serialize` always returns `SerializableError` when given an `Error` instance.
 * This helper makes the narrowing explicit without `as any`.
 */
function serializeError(error: unknown): SerializableError {
  return serialize(error) as SerializableError;
}

/**
 * ChildIPCServer — parent-side adapter call handler for a single child process.
 *
 * Responsibilities:
 * - Listen for `adapter:call` messages on child.on('message')
 * - Layer 2 permission check (adapter-level gate from call.context.permissions)
 * - Dispatch to real adapter on platform
 * - Send `adapter:response` back via child.send()
 * - Auto-stop on child exit
 *
 * Message coexistence: WorkerMessage types (execute, result, error, log, health, ready)
 * have different `type` fields than AdapterCall ('adapter:call') / AdapterResponse
 * ('adapter:response'). Both coexist on the same IPC channel without collision.
 */
export class ChildIPCServer {
  private messageHandler: (msg: unknown) => void;
  private exitHandler: () => void;
  private started = false;
  /** Active EventBus subscriptions: subscriptionId → unsubscribe fn */
  private eventBusSubs = new Map<string, () => void>();
  private activeLlmCalls = new Map<string, AbortController>();

  constructor(
    private readonly platform: IPlatformAdapters,
    private readonly child: ChildProcess,
  ) {
    this.messageHandler = this.handleMessage.bind(this);
    this.exitHandler = () => this.stop();
  }

  /**
   * Start listening for adapter calls from child process.
   */
  start(): void {
    if (this.started) { return; }

    this.child.on('message', this.messageHandler);
    this.child.on('exit', this.exitHandler);
    this.started = true;
  }

  /**
   * Stop listening. Removes all listeners and cancels all EventBus subscriptions.
   */
  stop(): void {
    if (!this.started) {return;}

    this.child.off('message', this.messageHandler);
    this.child.off('exit', this.exitHandler);
    this.started = false;

    for (const unsub of this.eventBusSubs.values()) { unsub(); }
    this.eventBusSubs.clear();
    for (const controller of this.activeLlmCalls.values()) { controller.abort(new Error('IPC child disconnected')); }
    this.activeLlmCalls.clear();
  }

  /**
   * Handle incoming message from child.
   * Routes adapter:call, eventbus:subscribe, eventbus:unsubscribe.
   * WorkerMessages (execute, result, etc.) pass through untouched.
   */
  private async handleMessage(msg: unknown): Promise<void> {
    if (isAdapterCancel(msg)) {
      this.activeLlmCalls.get(msg.requestId)?.abort(new Error('LLM request cancelled by caller'));
      return;
    }
    if (isEventBusSubscribe(msg)) {
      const { subscriptionId, topic } = msg;
      if (!this.platform.eventBus) {
        if (this.child.connected) { this.child.send({ type: 'eventbus:subscribed', subscriptionId }); }
        return;
      }
      const unsub = this.platform.eventBus.subscribe(topic, async (payload) => {
        if (this.child.connected) {
          this.child.send({ type: 'eventbus:push', subscriptionId, topic, payload: serialize(payload) });
        }
      });
      this.eventBusSubs.set(subscriptionId, unsub);
      if (this.child.connected) { this.child.send({ type: 'eventbus:subscribed', subscriptionId }); }
      return;
    }

    if (isEventBusUnsubscribe(msg)) {
      const unsub = this.eventBusSubs.get(msg.subscriptionId);
      if (unsub) {
        unsub();
        this.eventBusSubs.delete(msg.subscriptionId);
      }
      return;
    }

    if (!isAdapterCall(msg)) {return;}

    // Layer 2: permission check (stateless — reads from call context)
    const permissionError = this.checkPermission(msg);
    if (permissionError) {
      this.sendResponse({
        type: 'adapter:response',
        requestId: msg.requestId,
        error: serializeError(permissionError),
      });
      return;
    }

    let activeRequestId: string | undefined;
    try {
      const adapter = resolveIPCAdapter(this.platform, msg.adapter);
      const method = (adapter as Record<string, unknown>)[msg.method];

      if (typeof method !== 'function') {
        throw new Error(
          `Method '${msg.method}' not found on adapter '${msg.adapter}'`
        );
      }

      const args = msg.args.map((arg) => deserialize(arg));
      const controller = new AbortController();
      if (attachLlmCallAbortSignal(msg.adapter, msg.method, args, controller.signal)) {
        activeRequestId = msg.requestId;
        this.activeLlmCalls.set(msg.requestId, controller);
      }
      const result = await method.apply(adapter, args);

      this.sendResponse({
        type: 'adapter:response',
        requestId: msg.requestId,
        result: serialize(result),
      });
    } catch (error) {
      this.sendResponse({
        type: 'adapter:response',
        requestId: msg.requestId,
        error: serializeError(error),
      });
    } finally {
      if (activeRequestId) { this.activeLlmCalls.delete(activeRequestId); }
    }
  }

  /**
   * Layer 2 permission check.
   * Reads permissions from call.context.permissions (stateless).
   * Returns Error if denied, undefined if allowed.
   */
  private checkPermission(call: AdapterCall): Error | undefined {
    const permissions = call.context?.permissions;

    // No permissions context = allow (backward compat with v1 protocol)
    if (!permissions) {return undefined;}

    const allowedAdapters = permissions.adapters;

    // No adapter restrictions = allow all
    if (!allowedAdapters) {return undefined;}

    // Check if adapter is in allowed list
    if (!allowedAdapters.includes(call.adapter)) {
      return new Error(
        `Permission denied: adapter '${call.adapter}' not allowed. ` +
        `Allowed: ${allowedAdapters.join(', ')}`
      );
    }

    return undefined;
  }

  /**
   * Send response back to child process.
   */
  private sendResponse(response: AdapterResponse): void {
    if (this.child.connected) {
      this.child.send(response);
    }
  }

  isStarted(): boolean {
    return this.started;
  }
}
