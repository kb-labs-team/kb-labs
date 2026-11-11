/**
 * @module @kb-labs/core-platform/errors
 *
 * Platform-level error types shared by all adapter implementations.
 */

/** Stable structural error contract consumed by the command boundary. */
export interface TypedPlatformError<C extends PlatformErrorCode = PlatformErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly hint?: string;
  readonly details?: DetailsFor<C>;
  readonly diagnostics?: Array<{ code: string; severity: 'error' | 'warning' | 'info'; message: string; path?: string; line?: number; hint?: string }>;
  readonly correlationId?: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly service?: string;
}

/**
 * Thrown by NoOp adapter implementations when a plugin tries to use a
 * platform service that has no honest fallback available (e.g. LLM,
 * Embeddings) and the operator hasn't configured a real adapter.
 *
 * Distinct from generic `Error` so callers can branch on it:
 *
 * ```ts
 * try {
 *   await platform.llm.complete(...);
 * } catch (err) {
 *   if (err instanceof AdapterUnavailableError) {
 *     // surface to user: "configure an LLM adapter"
 *   }
 * }
 * ```
 *
 * The gateway HTTP error mapper converts this into a structured response
 * `{code: 'ADAPTER_UNAVAILABLE', slot, reason}` for REST consumers.
 */
export class AdapterUnavailableError extends Error {
  /** Adapter slot, e.g. 'llm', 'embeddings', 'notifier'. */
  public readonly slot: string;
  public readonly hint: string;
  /** Why the adapter is unavailable. */
  public readonly reason: 'not-configured' | 'load-failed';
  /** Optional user-facing explanation for a known adapter load failure. */
  public readonly userMessage?: string;
  /** Optional copy-ready corrective command. */
  public readonly action?: { id: string; label: string; command: string };

  constructor(
    slot: string,
    reason: 'not-configured' | 'load-failed' = 'not-configured',
    message?: string,
    cause?: unknown,
    options?: { hint?: string; userMessage?: string; action?: { id: string; label: string; command: string } },
  ) {
    super(
      message ?? (reason === 'not-configured'
        ? `Adapter "${slot}" is not configured. Configure a real adapter in kb.config.json under \`adapters.${slot}\`.`
        : `Adapter "${slot}" is not available (reason: ${reason}).`),
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AdapterUnavailableError';
    this.slot = slot;
    this.reason = reason;
    const command = getAdapterConfigurationCommand(slot);
    this.hint = options?.hint ?? (reason === 'load-failed'
      ? `Run "kb logs query" to inspect why the ${slot} adapter could not load, correct the underlying issue, then retry.`
      : `Run "${command}" to configure the ${slot} adapter, then retry the command.`);
    this.userMessage = options?.userMessage;
    this.action = options?.action;
    Object.setPrototypeOf(this, AdapterUnavailableError.prototype);
  }
}

export function getAdapterConfigurationCommand(slot: string): string {
  const packages: Record<string, string> = {
    llm: '@kb-labs/adapters-openai',
    embeddings: '@kb-labs/adapters-openai/embeddings',
    vectorStore: '@kb-labs/adapters-qdrant',
  };
  const adapterPackage = packages[slot] ?? `@kb-labs/adapters-${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  return `kb adapter bind ${slot} ${adapterPackage}`;
}

/** A project config attempted to set adapter bindings or options. */
export class AdapterProjectScopeError extends Error {
  constructor() {
    super('Project adapter configuration is unsupported.');
    this.name = 'AdapterProjectScopeError';
    Object.setPrototypeOf(this, AdapterProjectScopeError.prototype);
  }
}

/** A bound adapter cannot run because a required credential is absent. */
export class AdapterCredentialsMissingError extends Error implements TypedPlatformError<'KB_ADAPTER_CREDENTIALS_MISSING'> {
  public readonly code: 'KB_ADAPTER_CREDENTIALS_MISSING' = 'KB_ADAPTER_CREDENTIALS_MISSING' as const;
  public readonly slot: string;
  public readonly credential: string;
  public readonly configurationPath: string;
  public readonly details: DetailsFor<'KB_ADAPTER_CREDENTIALS_MISSING'>;
  public readonly hint: string;

  constructor(slot: string, credential: string, configurationPath: string) {
    super(`Adapter "${slot}" is missing ${credential}. No request was sent.`);
    this.name = 'AdapterCredentialsMissingError';
    this.slot = slot;
    this.credential = credential;
    this.configurationPath = configurationPath;
    const command = `kb config set --scope platform ${configurationPath} '\${${credential}}' --allow-missing-env`;
    this.details = { service: slot, credential, path: configurationPath, command };
    this.hint = `Run "${command}" to configure the missing credential. No request was sent.`;
    Object.setPrototypeOf(this, AdapterCredentialsMissingError.prototype);
  }
}

/** An adapter operation failed after its own retry policy was exhausted. */
export class AdapterOperationError extends Error {
  public readonly code: 'KB_ADAPTER_OPERATION_FAILED' = 'KB_ADAPTER_OPERATION_FAILED' as const;

  constructor(
    public readonly slot: string,
    public readonly operation: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AdapterOperationError';
    Object.setPrototypeOf(this, AdapterOperationError.prototype);
  }
}

/** A present platform configuration layer could not be loaded or validated. */
export class PlatformConfigError extends Error {
  public readonly configPath: string;
  public readonly reason: 'read' | 'parse' | 'invalid';
  public readonly detail: string;

  constructor(configPath: string, reason: 'read' | 'parse' | 'invalid', detail: string) {
    super(`Platform configuration ${configPath} failed to ${reason}: ${detail}`);
    this.name = 'PlatformConfigError';
    this.configPath = configPath;
    this.reason = reason;
    this.detail = detail;
    Object.setPrototypeOf(this, PlatformConfigError.prototype);
  }
}

/** The install root has no layout contract in its active version. */
export class PlatformLayoutContractError extends Error {
  public readonly contractPath: string;
  public readonly remedy: { operation: 'update'; platformRoot: string };

  constructor(contractPath: string, installRoot: string) {
    super(`The active platform layout contract is missing at ${contractPath}.`);
    this.name = 'PlatformLayoutContractError';
    this.contractPath = contractPath;
    this.remedy = { operation: 'update', platformRoot: installRoot };
    Object.setPrototypeOf(this, PlatformLayoutContractError.prototype);
  }
}

/** A typed adapter option failed validation before the adapter could start. */
export class AdapterConfigError extends Error {
  public readonly optionPath: string;
  public readonly detail: string;
  public readonly hint: string;

  constructor(optionPath: string, detail: string, hint: string) {
    super(`Adapter option "${optionPath}" is invalid: ${detail}.`);
    this.name = 'AdapterConfigError';
    this.optionPath = optionPath;
    this.detail = detail;
    this.hint = hint;
    Object.setPrototypeOf(this, AdapterConfigError.prototype);
  }
}

/** A service port environment setting is not a valid TCP port. */
export class ServicePortConfigError extends Error {
  public readonly envVar: string;
  public readonly reason: string;

  constructor(envVar: string, reason: string) {
    super(`Environment variable "${envVar}" ${reason}.`);
    this.name = 'ServicePortConfigError';
    this.envVar = envVar;
    this.reason = reason;
    Object.setPrototypeOf(this, ServicePortConfigError.prototype);
  }
}
import type { PlatformErrorCode } from './error-envelope/types.js';
import type { DetailsFor } from './error-envelope/catalog.js';
