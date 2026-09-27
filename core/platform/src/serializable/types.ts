/**
 * @module @kb-labs/core-platform/serializable
 * IPC serialization types for cross-process adapter communication.
 *
 * This module defines the protocol for serializing adapter method calls
 * and responses across process boundaries using IPC (Inter-Process Communication).
 *
 * @example
 * ```typescript
 * import { AdapterCall, AdapterResponse } from '@kb-labs/core-platform/serializable';
 *
 * const call: AdapterCall = {
 *   type: 'adapter:call',
 *   requestId: 'uuid-123',
 *   adapter: 'vectorStore',
 *   method: 'search',
 *   args: [[0.1, 0.2, 0.3], 10],
 *   timeout: 30000,
 * };
 * ```
 */

/**
 * Special type for serialized Buffer instances.
 * Buffers are converted to base64 strings for transmission.
 */
export interface SerializableBuffer {
  __type: 'Buffer';
  data: string; // base64 encoded
}

/**
 * Special type for serialized Date instances.
 * Dates are converted to ISO 8601 strings for transmission.
 */
export interface SerializableDate {
  __type: 'Date';
  iso: string; // ISO 8601 format
}

/**
 * Special type for serialized Error instances.
 * Errors are converted to structured objects with name, message, stack, and optional code.
 */
export interface SerializableError {
  __type: 'Error';
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/**
 * Values that can be safely serialized over IPC/network.
 *
 * Supports:
 * - Primitives: null, boolean, number, string
 * - Special types: Buffer, Date, Error
 * - Collections: Array, Object
 *
 * Does NOT support:
 * - Functions
 * - Symbols (except as object keys after serialization)
 * - WeakMap/WeakSet
 * - Circular references (will be detected and throw error)
 */
export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | SerializableBuffer
  | SerializableDate
  | SerializableError
  | SerializableArray
  | SerializableObject;

/**
 * Serializable array - all elements must be SerializableValue
 */
export type SerializableArray = SerializableValue[];

/**
 * Serializable object - all values must be SerializableValue
 */
export type SerializableObject = { [key: string]: SerializableValue };

/**
 * Adapter types supported by the IPC protocol.
 *
 * These correspond to the adapters available in PlatformContainer:
 * - vectorStore: IVectorStore
 * - cache: ICache
 * - llm: ILLM
 * - embeddings: IEmbeddings
 * - storage: IStorage
 * - logger: ILogger
 * - analytics: IAnalytics
 * - eventBus: IEventBus
 * - invoke: IInvoke
 * - artifacts: IArtifacts
 */
export type AdapterType =
  | 'vectorStore'
  | 'cache'
  | 'config'
  | 'llm'
  | 'embeddings'
  | 'storage'
  | 'logger'
  | 'analytics'
  | 'eventBus'
  | 'invoke'
  | 'artifacts'
  | 'database.document'
  | 'database.kv'
  | 'processExecutor';

/**
 * Execution context for adapter calls.
 *
 * Used for tracing, debugging, security validation, and metrics.
 * All fields are optional to maintain backward compatibility.
 */
export interface AdapterCallContext {
  /** Trace ID for distributed tracing (spans entire CLI → Worker → Adapter → Service flow) */
  traceId?: string;
  /** Session ID for user session tracking */
  sessionId?: string;
  /** Plugin ID making the adapter call */
  pluginId?: string;
  /** Workspace ID for multi-tenant scenarios */
  workspaceId?: string;
  /** Tenant ID for multi-tenant quota enforcement */
  tenantId?: string;
  /** Plugin permissions snapshot (for adapter-level validation) */
  permissions?: {
    /** Allowed adapter access (e.g., ['vectorStore', 'cache']) */
    adapters?: string[];
    /** Allowed storage paths (e.g., ['.kb/**', 'docs/**']) */
    storagePaths?: string[];
    /** Allowed network hosts (e.g., ['api.openai.com']) */
    networkHosts?: string[];
  };
  /** Socket auth token for parent-side IPC authorization */
  authToken?: string;
}

/**
 * IPC protocol version.
 *
 * Version history:
 * - v1: Initial implementation (requestId, adapter, method, args, timeout)
 * - v2: Added context (traceId, pluginId, sessionId, tenantId, permissions)
 *
 * When making breaking changes:
 * 1. Increment version
 * 2. Update IPCServer to handle both old and new versions
 * 3. Update ADR-0038 with migration guide
 */
export const IPC_PROTOCOL_VERSION = 2;

/**
 * Adapter method call that can be sent over IPC.
 *
 * Represents a request from child process to parent process
 * to execute a method on an adapter.
 *
 * @example
 * ```typescript
 * const call: AdapterCall = {
 *   version: 2,
 *   type: 'adapter:call',
 *   requestId: 'uuid-123',
 *   adapter: 'vectorStore',
 *   method: 'search',
 *   args: [[0.1, 0.2, 0.3], 10, { collectionId: 'docs' }],
 *   timeout: 30000,
 *   context: {
 *     traceId: 'trace-abc',
 *     pluginId: '@kb-labs/mind',
 *     sessionId: 'session-xyz',
 *   },
 * };
 * ```
 */
export interface AdapterCall {
  /** Protocol version for backward compatibility */
  version: number;
  type: 'adapter:call';
  /** Unique request ID to match with response */
  requestId: string;
  /** Adapter to call */
  adapter: AdapterType;
  /** Method name to call on adapter */
  method: string;
  /** Serialized method arguments */
  args: SerializableValue[];
  /** Optional timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional execution context for tracing, debugging, security (v2+) */
  context?: AdapterCallContext;
}

/**
 * Response from adapter method call.
 *
 * Represents a response from parent process back to child process
 * after executing an adapter method.
 *
 * Either `result` or `error` will be present, never both.
 *
 * @example Success:
 * ```typescript
 * const response: AdapterResponse = {
 *   type: 'adapter:response',
 *   requestId: 'uuid-123',
 *   result: [{ id: '1', score: 0.95, metadata: {} }],
 * };
 * ```
 *
 * @example Error:
 * ```typescript
 * const response: AdapterResponse = {
 *   type: 'adapter:response',
 *   requestId: 'uuid-123',
 *   error: {
 *     __type: 'Error',
 *     name: 'VectorStoreError',
 *     message: 'Collection not found',
 *     stack: '...',
 *   },
 * };
 * ```
 */
export interface AdapterResponse {
  type: 'adapter:response';
  /** Request ID this response corresponds to */
  requestId: string;
  /** Serialized result (if successful) */
  result?: SerializableValue;
  /** Serialized error (if failed) */
  error?: SerializableError;
}

// ─── EventBus bidirectional messages ─────────────────────────────────────────

/**
 * Child → Parent: subscribe to an event bus topic.
 * Parent subscribes to platform.eventBus and forwards events back as EventBusPush.
 */
export interface EventBusSubscribe {
  type: 'eventbus:subscribe';
  /** Opaque ID used to match with future unsubscribe. */
  subscriptionId: string;
  topic: string;
}

/** Parent → Child: confirms the requested event subscription is active. */
export interface EventBusSubscribed {
  type: 'eventbus:subscribed';
  subscriptionId: string;
}

/** Child → Parent: cancel an in-flight adapter request by its request ID. */
export interface AdapterCancel {
  type: 'adapter:cancel';
  requestId: string;
}

export function isAdapterCancel(msg: unknown): msg is AdapterCancel {
  return isRecord(msg) && msg['type'] === 'adapter:cancel' && typeof msg['requestId'] === 'string';
}

/**
 * Child → Parent: cancel a previous subscription.
 */
export interface EventBusUnsubscribe {
  type: 'eventbus:unsubscribe';
  subscriptionId: string;
}

/**
 * Parent → Child: push an event to subscribed handlers.
 */
export interface EventBusPush {
  type: 'eventbus:push';
  subscriptionId: string;
  topic: string;
  payload: SerializableValue;
}

export function isEventBusSubscribe(msg: unknown): msg is EventBusSubscribe {
  return (
    isRecord(msg) &&
    msg['type'] === 'eventbus:subscribe' &&
    typeof msg['subscriptionId'] === 'string' &&
    typeof msg['topic'] === 'string'
  );
}

export function isEventBusSubscribed(msg: unknown): msg is EventBusSubscribed {
  return (
    isRecord(msg) &&
    msg['type'] === 'eventbus:subscribed' &&
    typeof msg['subscriptionId'] === 'string'
  );
}

export function isEventBusUnsubscribe(msg: unknown): msg is EventBusUnsubscribe {
  return (
    isRecord(msg) &&
    msg['type'] === 'eventbus:unsubscribe' &&
    typeof msg['subscriptionId'] === 'string'
  );
}

export function isEventBusPush(msg: unknown): msg is EventBusPush {
  return (
    isRecord(msg) &&
    msg['type'] === 'eventbus:push' &&
    typeof msg['subscriptionId'] === 'string' &&
    typeof msg['topic'] === 'string'
  );
}

/**
 * All possible IPC messages.
 *
 * Child → Parent: AdapterCall | EventBusSubscribe | EventBusUnsubscribe
 * Parent → Child: AdapterResponse | EventBusPush | EventBusSubscribed
 */
export type IPCMessage =
  | AdapterCall
  | AdapterResponse
  | EventBusSubscribe
  | EventBusUnsubscribe
  | EventBusPush
  | EventBusSubscribed
  | AdapterCancel;

/**
 * Narrows `unknown` to a plain object with string-keyed unknown values.
 * Used to avoid `as any` casts when inspecting arbitrary incoming messages.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Type guard to check if message is an AdapterCall.
 *
 * Supports both v1 (no version field) and v2+ (with version field)
 * for backward compatibility.
 */
export function isAdapterCall(msg: unknown): msg is AdapterCall {
  if (!isRecord(msg)) {
    return false;
  }

  if (
    msg['type'] !== 'adapter:call' ||
    typeof msg['requestId'] !== 'string' ||
    typeof msg['adapter'] !== 'string' ||
    typeof msg['method'] !== 'string' ||
    !Array.isArray(msg['args'])
  ) {
    return false;
  }

  // If version field is present, it must be a number
  if ('version' in msg && typeof msg['version'] !== 'number') {
    return false;
  }

  // v1 messages (no version field) are auto-upgraded to v2 by adding version: 1
  if (!('version' in msg)) {
    msg['version'] = 1; // Auto-upgrade legacy messages
  }

  return true;
}

/**
 * Type guard to check if message is an AdapterResponse.
 */
export function isAdapterResponse(msg: unknown): msg is AdapterResponse {
  return (
    isRecord(msg) &&
    msg['type'] === 'adapter:response' &&
    typeof msg['requestId'] === 'string'
  );
}

/**
 * Error thrown when serialization fails.
 */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/**
 * Error thrown when deserialization fails.
 */
export class DeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeserializationError';
  }
}
