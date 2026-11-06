/**
 * CLI Host Wrapper
 *
 * Transforms RunResult<T> from runner layer into CLI-specific CommandResultWithMeta<T>.
 */

import type {
  RunResult,
  ExecutionMeta,
  CommandResult,
  CommandResultWithMeta,
  StandardMeta,
  PluginContextDescriptor,
} from '@kb-labs/plugin-contracts';
import { isErrorCode, toErrorEnvelope, type ValidatedErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { isUxResult, isUxResultCandidate } from '@kb-labs/core-platform/ux-result';

/**
 * A command failure is the only structured handler result. Success values are
 * always plain command data, even when that data contains an `ok` field.
 */
function commandFailureError(value: unknown, binaryName: string | undefined, correlationId: string): ValidatedErrorEnvelope | undefined {
  if (!isUxResultCandidate(value) || value.ok !== false || !('error' in value)) {
    return undefined;
  }
  const error = value.error;
  if (typeof error !== 'object' || error === null || Array.isArray(error) ||
      !('code' in error) || typeof error.code !== 'string' ||
      !('message' in error) || typeof error.message !== 'string' ||
      ('hint' in error && error.hint !== undefined && typeof error.hint !== 'string') ||
      ((!('hint' in error) || error.hint === undefined) && !isErrorCode(error.code))) {
    return undefined;
  }
  return toErrorEnvelope(error, {
    correlationId,
    ...(binaryName ? { binary: binaryName } : {}),
  });
}

function isFailureClaim(value: unknown): boolean {
  return isUxResultCandidate(value) && value.ok === false;
}

function contractViolation(meta: StandardMeta): CommandResultWithMeta<never> {
  return {
    exitCode: 1,
    ok: false,
    error: {
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      message: 'Plugin command violated the command result contract.',
      hint: 'Return command data, or return a typed failure with a catalogued code, message, and hint.',
    },
    meta: meta as StandardMeta & Record<string, unknown>,
  };
}

/**
 * Convert ExecutionMeta to StandardMeta format
 */
function toStandardMeta(
  executionMeta: ExecutionMeta,
  descriptor: PluginContextDescriptor
): StandardMeta {
  return {
    executedAt: new Date(executionMeta.startTime).toISOString(),
    duration: executionMeta.duration,
    pluginId: executionMeta.pluginId,
    pluginVersion: executionMeta.pluginVersion,
    commandId: executionMeta.handlerId,
    host: descriptor.hostType,
    tenantId: executionMeta.tenantId,
    requestId: executionMeta.requestId,
  };
}

/**
 * Wrap RunResult from runner into CLI-specific CommandResultWithMeta
 *
 * CLI commands can return either:
 * - CommandFailure for an operation failure
 * - T directly (data only, defaults to exitCode: 0)
 * - void/undefined (defaults to exitCode: 0)
 *
 * @param runResult - Result from runInProcess/runInSubprocess
 * @param descriptor - Plugin context descriptor for additional metadata
 * @returns CommandResultWithMeta<T> for CLI consumption
 */
export function wrapCliResult<T>(
  runResult: RunResult<CommandResult<T> | T | void>,
  descriptor: PluginContextDescriptor
): CommandResultWithMeta<T> {
  const { data, executionMeta } = runResult;
  const standardMeta = toStandardMeta(executionMeta, descriptor);

  // A handler must return its payload; only this boundary builds the success envelope.
  if (isUxResult(data)) {
    return contractViolation(standardMeta);
  }

  const binaryName = descriptor.hostContext.host === 'cli' ? descriptor.hostContext.binaryName : undefined;
  const failureError = commandFailureError(data, binaryName, executionMeta.requestId);
  if (isFailureClaim(data) && !failureError) {
    return contractViolation(standardMeta);
  }

  // Case 1: Handler returned the shared typed failure.
  if (failureError) {
    const mergedMeta: StandardMeta & Record<string, unknown> = {
      ...standardMeta,
    };

    return {
      exitCode: 1,
      ok: false,
      error: failureError,
      meta: mergedMeta,
    };
  }

  // Case 2: Handler returned void/undefined
  if (data === undefined || data === null) {
    return {
      exitCode: 0,
      ok: true,
      meta: standardMeta as StandardMeta & Record<string, unknown>,
    };
  }

  // Case 3: Handler returned raw data T
  return {
    exitCode: 0,
    ok: true,
    result: data as T,
    meta: standardMeta as StandardMeta & Record<string, unknown>,
  };
}
