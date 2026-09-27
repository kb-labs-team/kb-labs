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

/**
 * Check whether a handler returned the canonical command result.
 */
function isCommandResult<T>(value: unknown): value is CommandResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
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
 * - CommandResult<T> with ok, result, meta
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

  // Case 1: Handler returned CommandResult
  if (isCommandResult<T>(data)) {
    const ok = data.ok;
    const isTimeout = !ok
      && typeof data.error === 'object'
      && data.error.code === 'TIMEOUT';
    const exitCode = ok ? 0 : isTimeout ? 124 : 1;
    const mergedMeta: StandardMeta & Record<string, unknown> = {
      ...data.meta,
      ...standardMeta,
    };

    return {
      exitCode,
      ok,
      result: data.result as T | undefined,
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
